'use strict';

/**
 * 作者：双子-阿攀达 | client.js | v0.3.1
 *
 * ============================================================================
 * Client（总入口）与 DBHelper（读写辅助）
 *
 * 【Client 的定位】
 *   对齐 Ruby 版的 Root：所有持久化操作的唯一入口。对外提供三类能力：
 *     ① 元类型：defineClass（v0.3.1 起支持 parentClass 继承）
 *     ② 读写：  put / get / meta$ / scope
 *     ③ 自省：  introspect / introspectClass（AI 友好型设计的核心）
 *
 * 【v0.3.1 主要变更】
 *   1. 继承多态：defineClass 支持 parentClass，子类复用父类物理表，
 *      真实类型由 oddm_root_index.class_name 判别（不存 __class__ 属性，
 *      避免与索引表构成双份真相）
 *   2. 系统元数据：每个对象自动写入 __name__ / __version__ /
 *      __created_at__ / __updated_at__，因此「最近更新的文档」这类需求
 *      可以直接走 where/order 的 SQL 下推
 *   3. 引用类型：ref / refs 两种新类型，读取时自动包装成 LazyRef /
 *      CollectionProxy，实现懒加载并天然支持循环引用
 *   4. 类作用域：db.User 直接得到 ClassScope，支持 db.User.where(...) 链式查询
 *   5. 视图与 Helper：db.views / db.helper 对齐 Ruby 版的视图与运维能力
 *
 * 【关于 db.User 这种属性式访问】
 *   Ruby 版靠 method_missing 实现；Node 版在 Client 上挂一层 Proxy 达成
 *   同样效果，同时保留显式的 client.scope('User') 作为不依赖 Proxy 的入口。
 *   Proxy 的 getPrototypeOf 陷阱指向 Client.prototype，因此
 *   `client instanceof Client` 依然成立（否则 DBHelper 的类型校验会失效）。
 * ============================================================================
 */

const Database = require('better-sqlite3');

const { Schema, MetaClassManager } = require('./schema');
const { PathParser, TreeNavigator } = require('./path');
const { Repository, ALL_COLUMNS } = require('./repository');
const { APL } = require('./apl');
const { ClassScope } = require('./classscope');
const { ViewManager } = require('./views');
const { Helper } = require('./helper');
const { LazyRef, CollectionProxy } = require('./lazyref');
const {
  TYPE_TO_COLUMN,
  assertValidClassName,
  assertValidVersion,
  tableNameFor,
  objectNameFor,
  coerceLiteral,
  supportsRangeOperator,
  isPath,
  parseObjectName,
} = require('./naming');
const {
  ODDMValidationError,
  ODDMNotFoundError,
  ODDMQueryError,
  ODDMCycleError,
  ODDMDepthLimitError,
} = require('./errors');
const { VERSION, SYS_ATTR, SYS_TABLE } = require('./constants');

/** 深度上限默认值，与概念文档 3 节「对象层级限制在 <10 层」一致 */
const DEFAULT_MAX_DEPTH = 10;

/** 键序稳定的序列化，用于 diff 比较，避免属性书写顺序影响判定 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function diffEqual(current, next) {
  if (current === next) return true;
  if (current instanceof Date && next instanceof Date) {
    return current.getTime() === next.getTime();
  }
  if (current === null || current === undefined) {
    return next === null || next === undefined ? true : false;
  }
  if (next === null || next === undefined) return false;
  if (typeof current === 'object' || typeof next === 'object') {
    return stableStringify(current) === stableStringify(next);
  }
  return false;
}

class Client {
  /**
   * @param {string|object} [options] 传入字符串视为数据库路径（兼容 :memory:）
   * @param {string} [options.path=':memory:']
   * @param {object|string} [options.apl] APL 日志配置，传字符串视为日志级别
   * @param {boolean} [options.strict=true] schema 外属性是否直接报错
   * @param {number} [options.maxDepth=10] 对象树最大深度
   * @param {boolean} [options.scopedAccess=true] 是否启用 db.User 属性式访问
   */
  constructor(options = {}) {
    const opts = typeof options === 'string' ? { path: options } : options || {};

    this.path = opts.path ?? ':memory:';
    this.strict = opts.strict !== false;
    this.maxDepth = Number.isInteger(opts.maxDepth) ? opts.maxDepth : DEFAULT_MAX_DEPTH;
    this.version = VERSION;

    if (typeof opts.apl === 'string') {
      this.apl = new APL({ level: opts.apl });
    } else if (opts.apl instanceof APL) {
      this.apl = opts.apl;
    } else {
      this.apl = new APL(opts.apl || { level: 'off' });
    }

    this.db = opts.db || new Database(this.path);
    this.db.pragma('foreign_keys = ON');

    Schema.initSystemTables(this.db);
    // 每个 Client 持有独立的元类型管理器，杜绝跨库 schema 串扰
    this.meta = new MetaClassManager(this.db);

    // ---- v0.3.1 新增的三个协作对象 ----
    this.views = new ViewManager(this); // 视图管理
    this.helper = new Helper(this); // 管理辅助（对齐 Ruby root.helper）
    this.dbHelper = new DBHelper(this); // 读写辅助（where/children/...）
    this._scopeCache = new Map(); // ClassScope 缓存，避免重复创建

    // ---- 身份映射（identity map，opt-in）----
    // 对齐 Ruby 版 Root 的 @identity_map：同一会话内对同一对象多次 get 命中
    // 缓存，减少 DB 往返。默认关闭——Node 版 get 习惯「每次返回快照」，
    // 强制共享引用会让不熟悉该语义的用户困惑；需要时用 new Client({identityMap:true})。
    this.identityMapEnabled = opts.identityMap === true;
    this._identityMap = new Map(); // key: objectName -> { version, object }
    this._transactionDepth = 0;

    // 启用 db.User 这类属性式访问
    if (opts.scopedAccess !== false) {
      return new Proxy(this, ClientHandler);
    }
    return this;
  }

  close() {
    if (this.db && this.db.open) this.db.close();
    return this;
  }

  // -------------------------------------------------------------------------
  // 元类型
  // -------------------------------------------------------------------------

  /**
   * 注册类定义
   *
   * @param {string} className
   * @param {object} schemaHash 属性名 -> 类型
   * @param {string} [version='1.0']
   * @param {object|string} [options] 传字符串视为 parentClass（简写）
   * @param {string} [options.parentClass] 父类名，设置后本类复用父类物理表
   * @param {string} [options.parentVersion] 父类版本，默认与子类版本一致
   */
  defineClass(className, schemaHash, version = '1.0', options = {}) {
    assertValidClassName(className);
    assertValidVersion(version);

    // 兼容 defineClass(name, schema, version, 'Parent') 的简写
    const opts = typeof options === 'string' ? { parentClass: options } : options;

    const result = this.meta.defineClass(className, schemaHash, version, opts);

    // 类定义变了，相关的 scope 缓存要失效（否则可能拿到旧的 schema）
    this._scopeCache.delete(`${className}:${version}`);

    return result;
  }

  /** 取该类已注册的最大版本，用于路径中间节点占位 */
  _latestVersionOf(className) {
    const row = this.db
      .prepare(
        `SELECT version FROM ${SYS_TABLE.META_CLASSES}
         WHERE class_name = ? ORDER BY version DESC LIMIT 1`
      )
      .get(className);
    return row ? row.version : '1.0';
  }

  // -------------------------------------------------------------------------
  // 类作用域（db.User / client.scope('User')）
  // -------------------------------------------------------------------------

  /**
   * 取得某个类的作用域对象
   *
   * @param {string} className
   * @param {object} [options]
   * @param {string} [options.version] 固定版本
   */
  scope(className, options = {}) {
    assertValidClassName(className);
    const cacheKey = `${className}:${options.version || 'latest'}`;

    if (!options.version && this._scopeCache.has(cacheKey)) {
      return this._scopeCache.get(cacheKey);
    }

    const scope = new ClassScope(this, className, options);
    if (!options.version) this._scopeCache.set(cacheKey, scope);
    return scope;
  }

  /**
   * 尝试把属性名解析成类作用域（供 Proxy 使用）
   *
   * 同时支持单数与复数写法：db.User 与 db.Users 等价，
   * 这是 Ruby 版 method_missing 里 find_root_view(name) || find_root_view("#{name}s")
   * 的同款兼容。
   */
  _tryScope(name) {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;

    const candidates = [name];
    if (name.length > 1 && name.endsWith('s')) candidates.push(name.slice(0, -1));

    for (const candidate of candidates) {
      const version = this._latestVersionOf(candidate);
      if (this.meta.getSchema(candidate, version)) {
        return this.scope(candidate);
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 寻址
  // -------------------------------------------------------------------------

  resolveToObjectName(input) {
    if (isPath(input)) {
      return PathParser.extractTarget(input).object_name;
    }
    return input;
  }

  _indexRow(objectName) {
    return this.db
      .prepare(
        `SELECT object_name, class_name, version, parent_name FROM ${SYS_TABLE.ROOT_INDEX}
         WHERE object_name = ?`
      )
      .get(objectName);
  }

  exists(objectName) {
    return Boolean(this._indexRow(objectName));
  }

  /**
   * 确保路径上的中间节点都已进入拓扑索引。
   *
   * 原实现只写路径末端的节点，中间节点不入库，导致 ancestors / resolveCanonicalPath
   * 在中间层断链（能查到子节点，却反解不出完整路径）。
   */
  _ensureAncestors(nodes) {
    const stmt = this.db.prepare(`
      INSERT INTO ${SYS_TABLE.ROOT_INDEX} (object_name, class_name, version, parent_name)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(object_name) DO NOTHING;
    `);

    // nodes[0] 是 Root，最后一个节点由 saveObject 负责，这里只处理中间层
    for (let i = 1; i < nodes.length - 1; i += 1) {
      const node = nodes[i];
      if (this.exists(node.object_name)) continue;
      const version = this._latestVersionOf(node.class_name);
      stmt.run(node.object_name, node.class_name, version, node.parent_name);

      this.apl.debug({
        path: node.object_name,
        layer: node.class_name,
        op: 'ensure_ancestor',
        message: `路径中间节点占位创建（version=${version}）`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 读写
  // -------------------------------------------------------------------------

  /**
   * 写入对象
   *
   * @param {string} pathOrObjectName ODL 路径或物理标识（Class/key）
   * @param {object} attributes
   * @param {object} [options]
   * @param {string} [options.version] 目标版本；对已存在对象仅在 migrate=true 时生效
   * @param {boolean} [options.migrate=false] 是否允许改写已存在对象的版本
   * @param {boolean} [options.strict] 覆盖实例级 strict 设置
   * @param {boolean} [options.touchOnly=false] 只刷新 __updated_at__，不写业务属性
   */
  put(pathOrObjectName, attributes, options = {}) {
    const rawAttributes =
      options.touchOnly === true ? {} : attributes || {};

    if (!rawAttributes || typeof rawAttributes !== 'object' || Array.isArray(rawAttributes)) {
      throw new ODDMValidationError('put 需要一个属性对象', { path: pathOrObjectName });
    }

    const strict = options.strict !== undefined ? options.strict : this.strict;
    let className;
    let objectName;
    let parentName = 'Root';
    let version = options.version || '1.0';

    if (isPath(pathOrObjectName)) {
      const nodes = PathParser.parse(pathOrObjectName);

      const depth = nodes.length - 1; // 去掉 Root 节点
      if (depth > this.maxDepth) {
        throw new ODDMDepthLimitError(
          `路径深度 ${depth} 超过上限 ${this.maxDepth}，请拆分业务对象`,
          { path: pathOrObjectName, layer: nodes[nodes.length - 1].class_name }
        );
      }

      this._ensureAncestors(nodes);

      const target = nodes[nodes.length - 1];
      className = target.class_name;
      objectName = target.object_name;
      parentName = target.parent_name;
    } else {
      const row = this._indexRow(pathOrObjectName);
      if (!row) {
        throw new ODDMNotFoundError(
          `不可识别的对象: ${pathOrObjectName}（未登记在拓扑索引中）`,
          { path: pathOrObjectName }
        );
      }
      className = row.class_name;
      objectName = row.object_name;
      parentName = row.parent_name;

      // 已存在对象沿用索引中记录的版本，避免被默认 1.0 静默改写造成版本分裂
      if (!options.migrate) {
        version = row.version;
      }
    }

    assertValidClassName(className);
    assertValidVersion(version);

    const schema = this.meta.requireSchema(className, version, {
      path: pathOrObjectName,
      layer: className,
    });

    // 继承场景：物理表可能是父类的表，不能用 tableNameFor 直接推
    const table = this.meta.resolveTable(className, version);
    Schema.ensureTableByName(this.db, table);

    const ctx = { apl: this.apl, path: pathOrObjectName, layer: className, table };

    const result = Repository.saveObject(this.db, {
      className,
      objectName,
      attributes: rawAttributes,
      parentName,
      version,
      schema,
      strict,
      ctx,
    });

    // 写入即让缓存失效，保证后续 get 拿到最新数据（对齐 Ruby 的失效策略）
    this._invalidateIdentity(objectName);

    return result;
  }

  /**
   * 读取对象
   *
   * @param {string} pathOrObjectName ODL 路径或物理标识
   * @param {object} [options]
   * @param {boolean} [options.includeMeta=false] 是否带上 __created_at__ 等系统元数据
   * @returns {object|null} 属性对象；不存在返回 null
   */
  get(pathOrObjectName, options = {}) {
    const objectName = this.resolveToObjectName(pathOrObjectName);
    const row = this._indexRow(objectName);
    if (!row) return null;

    // 身份映射命中：同一版本、且未要求强制刷新时直接返回缓存
    // （对齐 Ruby identity map；若关闭则不进入此分支）
    if (this.identityMapEnabled && !options.fresh) {
      const cached = this._identityMap.get(objectName);
      if (cached && cached.version === row.version) return cached.object;
    }

    const schema = this.meta.getSchema(row.class_name, row.version);
    if (!schema) {
      throw new ODDMValidationError(
        `对象 ${objectName} 的类型 ${row.class_name} V${row.version} 未注册`,
        { path: pathOrObjectName, layer: row.class_name }
      );
    }

    // 继承：用解析后的物理表（子类对象存在父类表里）
    const table = this.meta.resolveTable(row.class_name, row.version);
    Schema.ensureTableByName(this.db, table);

    const ctx = { apl: this.apl, path: pathOrObjectName, layer: row.class_name, table };

    const result = Repository.findObject(this.db, {
      objectName,
      className: row.class_name,
      version: row.version,
      schema,
      ctx,
      includeMeta: options.includeMeta === true,
    });

    // 引用类型包装成懒加载代理（不在 naming 层做，因为需要 Client 才能按需加载）
    const wrapped = this._wrapRefValues(result, schema);

    if (this.identityMapEnabled) {
      this._identityMap.set(objectName, { version: row.version, object: wrapped });
    }
    return wrapped;
  }

  /**
   * 只读取对象的框架级元数据
   *
   * @param {string} pathOrObjectName
   * @returns {object|null} { __name__, __version__, __created_at__, __updated_at__ }
   */
  meta$(pathOrObjectName) {
    const objectName = this.resolveToObjectName(pathOrObjectName);
    const row = this._indexRow(objectName);
    if (!row) return null;

    const table = this.meta.resolveTable(row.class_name, row.version);
    Schema.ensureTableByName(this.db, table);

    return Repository.findMeta(this.db, {
      objectName,
      schema: this.meta.getSchema(row.class_name, row.version) || {},
      ctx: { apl: this.apl, path: pathOrObjectName, layer: row.class_name, table },
    });
  }

  /**
   * 版本数据迁移（对齐 Ruby Root#migrate）
   *
   * 【Node 版的版本模型提示】
   *   Node 版每个 (类, 版本) 各自一张物理表（User_V1_0 / User_V2_0），
   *   而 Ruby 版所有版本共用一张表、靠 __version__ 区分。因此 Node 的「迁移」
   *   本质上是把实例从旧表整行搬到新表，并在拓扑索引里把 version 翻到新值，
   *   而不是简单改个标记。
   *
   * 【语义】
   *   ① 两个版本都必须先 defineClass 注册；
   *   ② 读出 fromVersion 的全部实例（按索引 class_name + version 取）；
   *   ③ 对每个实例：默认只保留新旧 schema 交集里的属性；
   *      若传了 transform(entity, fromVersion, toVersion) 回调，则用其返回值
   *      作为写入新表的属性（完全自定义，最灵活）；
   *   ④ 写入新表，并把索引的 version 翻到 toVersion；
   *   ⑤ 清掉旧表里这批对象的孤儿行（索引已指新表，旧行无人会读到）；
   *   ⑥ 全程包在一个事务里，任一失败整体回滚。
   *
   * @param {string} className
   * @param {string} fromVersion
   * @param {string} toVersion
   * @param {function} [transform] (entity, fromVersion, toVersion) => attributes
   * @returns {number} 迁移成功的实例数
   */
  migrate(className, fromVersion, toVersion, transform = null) {
    assertValidClassName(className);
    assertValidVersion(fromVersion);
    assertValidVersion(toVersion);

    if (fromVersion === toVersion) {
      this.apl.warn({
        op: 'migrate',
        message: `fromVersion 与 toVersion 相同，跳过: ${className}`,
      });
      return 0;
    }

    const fromSchema = this.meta.getSchema(className, fromVersion);
    const toSchema = this.meta.getSchema(className, toVersion);
    if (!fromSchema) {
      throw new ODDMNotFoundError(`源版本未注册: ${className} V${fromVersion}`, {
        layer: className,
      });
    }
    if (!toSchema) {
      throw new ODDMNotFoundError(`目标版本未注册: ${className} V${toVersion}`, {
        layer: className,
      });
    }

    const fromTable = this.meta.resolveTable(className, fromVersion);
    const toTable = this.meta.resolveTable(className, toVersion);
    Schema.ensureTableByName(this.db, fromTable);
    Schema.ensureTableByName(this.db, toTable);

    // 取出 fromVersion 下的所有实例物理标识
    const rows = this.db
      .prepare(
        `SELECT object_name, parent_name FROM ${SYS_TABLE.ROOT_INDEX}
         WHERE class_name = ? AND version = ?`
      )
      .all(className, fromVersion);
    const names = rows.map((r) => r.object_name);

    // 默认转换器：只保留新旧 schema 交集里的属性（删掉的属性自然丢弃，
    // 新增的属性在此刻尚没有值，留待后续业务补写）
    const defaultTransform = (entity) => {
      const out = {};
      for (const key of Object.keys(toSchema)) {
        if (Object.prototype.hasOwnProperty.call(entity, key)) out[key] = entity[key];
      }
      return out;
    };
    const fn = typeof transform === 'function' ? transform : defaultTransform;

    this.dbHelper.transaction(() => {
      for (const row of rows) {
        const objectName = row.object_name;
        // 此刻索引仍指向 fromVersion，故 get / meta$ 都从旧表读，拿到的是原始数据
        const entity = this.get(objectName) || {};

        // 保留原始创建时间，避免搬到新表后 __created_at__ 丢失
        const meta = this.meta$(objectName);
        const createdAt = meta ? meta[SYS_ATTR.CREATED_AT] || null : null;

        const newAttrs = fn(entity, fromVersion, toVersion) || {};

        Repository.saveObject(this.db, {
          className,
          objectName,
          attributes: newAttrs,
          parentName: row.parent_name || 'Root',
          version: toVersion,
          schema: toSchema,
          strict: false, // 迁移允许属性不完全对齐，宽松写入
          ctx: { apl: this.apl, path: objectName, layer: className, table: toTable },
          createdAt,
        });

        // 清掉旧表的孤儿行（索引已翻到新版本，旧行不再被任何查询读到）
        if (fromTable !== toTable) {
          Repository.deleteAttributeRows(this.db, {
            objectName,
            table: fromTable,
            ctx: { apl: this.apl, path: objectName, layer: className, table: fromTable },
          });
        }

        // 身份映射失效（若启用）
        this._invalidateIdentity(objectName);
      }
    });

    this.apl.info({
      op: 'migrate',
      message: `迁移 ${className}: ${fromVersion} -> ${toVersion}，共 ${names.length} 个实例`,
    });

    return names.length;
  }

  /**
   * 创建从属对象（对齐 Ruby Root#create_child）
   *
   * 与手写 put("Root.Parent['pk'].Child['ck']", attrs) 等价，但语义更直白，
   * 且会自动为「父对象下的子对象集合」登记一条 collection 视图路由，之后即可
   * 用 db.views.queryObjects("#{parentClass}:#{parentKey}:#{childClass}s")
   * 这类具名方式反复取出该父节点下的某类子对象。
   *
   * 不强制要求父对象已存在：与 put 的路径写法一致，缺失的中间节点会被
   * _ensureAncestors 自动占位（见 put 的说明）。
   *
   * @param {string} parentClass
   * @param {string} parentKey
   * @param {string} childClass
   * @param {string} childKey
   * @param {object} attributes
   * @param {object} [options] 透传给 put（如 version / strict）
   */
  createChild(parentClass, parentKey, childClass, childKey, attributes, options = {}) {
    assertValidClassName(parentClass);
    assertValidClassName(childClass);
    const parentName = objectNameFor(parentClass, parentKey);
    const path = `Root.${parentClass}['${parentKey}'].${childClass}['${childKey}']`;
    const result = this.put(path, attributes, { ...options });

    // 对齐 Ruby：create_child 时自动维护父对象下的子对象集合视图
    // 视图名用下划线拼接（Node 的视图名必须白名单安全，不能用 Ruby 的冒号）
    try {
      const collectionName = `${parentClass}_${parentKey}_${childClass}s`;
      if (!this.meta.findView(collectionName)) {
        this.views.registerCollection(collectionName, childClass, parentName);
      }
    } catch (err) {
      this.apl.warn({ op: 'create_child', message: `集合视图登记跳过: ${err.message}` });
    }
    return result;
  }

  /**
   * 查找从属对象（对齐 Ruby Root#find_child）
   *
   * 先确认 childKey 指向的对象真实存在、且其父节点正是 parentKey，
   * 再返回该对象；任一不满足都返回 null（Node 版走宽松风格，与 get 一致；
   * 需要「必须存在」语义时请自行判空或包一层 findOrFail 思路）。
   *
   * @param {string} parentClass
   * @param {string} parentKey
   * @param {string} childClass
   * @param {string} childKey
   * @returns {object|null}
   */
  findChild(parentClass, parentKey, childClass, childKey) {
    assertValidClassName(parentClass);
    assertValidClassName(childClass);
    const parentName = objectNameFor(parentClass, parentKey);
    const childName = objectNameFor(childClass, childKey);
    const row = this._indexRow(childName);
    if (!row) return null;
    if (row.parent_name !== parentName) return null;
    return this.get(childName);
  }

  /**
   * 把 ref / refs 两种引用属性的值包装成懒加载代理
   *
   * Repository 层只还原出物理标识（字符串 / 数组），因为它是无状态纯函数；
   * 包装需要 Client 实例来实现「按需加载」，因此放在这一层。
   */
  _wrapRefValues(result, schema) {
    if (!result || typeof result !== 'object') return result;

    for (const [attrName, type] of Object.entries(schema)) {
      if (type !== 'ref' && type !== 'refs') continue;
      const value = result[attrName];
      if (value === null || value === undefined) continue;

      if (type === 'ref') {
        if (value instanceof LazyRef) continue; // 已包装过
        result[attrName] = new LazyRef(this, value, this._classOfObjectName(value));
        continue;
      }

      // refs
      if (value instanceof CollectionProxy) continue;
      const list = Array.isArray(value) ? value : [];
      result[attrName] = new CollectionProxy(this, list);
    }

    return result;
  }

  /** 从物理标识推断类名（User/apanda -> User），用于 LazyRef 展示，不查库 */
  _classOfObjectName(objectName) {
    try {
      return parseObjectName(objectName).className;
    } catch (err) {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 身份映射（identity map，opt-in）
  // -------------------------------------------------------------------------

  /** 清空身份映射缓存 */
  clearIdentityMap() {
    this._identityMap.clear();
    return this;
  }

  /**
   * 让某个对象在身份映射中的缓存失效
   *
   * 设计上对所有写入路径（put / destroy / migrate）都调用，确保缓存永远不
   * 会返回比数据库旧的数据。不开身份映射时 _identityMap 为空，安全无操作。
   */
  _invalidateIdentity(objectName) {
    if (this._identityMap && this._identityMap.has(objectName)) {
      this._identityMap.delete(objectName);
    }
    return this;
  }

  // -------------------------------------------------------------------------
  // 自省（供 AI 与工具链理解当前数据库）
  // -------------------------------------------------------------------------

  /**
   * 全库自省快照
   * @param {object} [options]
   * @param {number} [options.treeDepth=2] 对象树展开层数
   * @param {boolean} [options.includeSample=true] 是否给出示例路径与示例对象
   * @param {boolean} [options.includeViews=true] 是否附带视图与路由信息
   */
  introspect(options = {}) {
    const treeDepth = Number.isInteger(options.treeDepth) ? options.treeDepth : 2;
    const includeSample = options.includeSample !== false;
    const includeViews = options.includeViews !== false;

    const classes = this.meta.listClasses().map((cls) => {
      const entry = {
        className: cls.className,
        version: cls.version,
        table: cls.table,
        parentClass: cls.parentClass || null,
        schema: cls.schema,
        columns: Object.fromEntries(
          Object.entries(cls.schema).map(([attr, type]) => [attr, TYPE_TO_COLUMN[type]])
        ),
        instanceCount: this.meta.countInstances(cls.className, cls.version),
      };

      // 引用属性单独列出，AI 一眼能看出对象之间的关系
      const refs = Object.entries(cls.schema)
        .filter(([, type]) => type === 'ref' || type === 'refs')
        .map(([attr, type]) => ({ attribute: attr, kind: type }));
      if (refs.length > 0) entry.references = refs;

      if (includeSample) {
        entry.samplePath = this._samplePathFor(cls.className, cls.version);
        entry.sampleObject = this._sampleObjectFor(cls.className, cls.version);
      }
      return entry;
    });

    const snapshot = {
      root: 'Root',
      odlSyntax: "Root.ClassName['Key'].ChildClass['ChildKey']",
      version: this.version,
      maxDepth: this.maxDepth,
      strict: this.strict,
      classes,
      tree: this._treeOutline(treeDepth),
      stats: this._stats(),
    };

    if (includeViews) {
      snapshot.views = this.meta.listViews();
    }

    return snapshot;
  }

  /** 单个类的自省详情 */
  introspectClass(className, version) {
    const resolvedVersion = version || this._latestVersionOf(className);
    const schema = this.meta.getSchema(className, resolvedVersion);
    if (!schema) {
      throw new ODDMNotFoundError(`未注册的类型: ${className} V${resolvedVersion}`);
    }

    const def = this.meta.getClassDef(className, resolvedVersion);

    return {
      className,
      version: resolvedVersion,
      table: this.meta.resolveTable(className, resolvedVersion),
      parentClass: def ? def.parentClass : null,
      ancestorChain: this.meta.ancestorChain(className, resolvedVersion),
      // 多态：查这个类名时会命中的全部真实类名（含子类）
      polymorphicScope: this.meta
        .polymorphicClassNames(className, resolvedVersion)
        .map((s) => s.className),
      schema,
      attributes: Object.entries(schema).map(([name, type]) => ({
        name,
        type,
        column: TYPE_TO_COLUMN[type],
        rangeComparable: supportsRangeOperator(type),
      })),
      instanceCount: this.meta.countInstances(className, resolvedVersion),
      samplePath: this._samplePathFor(className, resolvedVersion),
      sampleObject: this._sampleObjectFor(className, resolvedVersion),
    };
  }

  _samplePathFor(className, version) {
    const table = this.meta.resolveTable(className, version);
    const row = this.db
      .prepare(`SELECT DISTINCT object_name FROM ${table} LIMIT 1`)
      .get();
    if (!row) return `Root.${className}['<key>']`;
    return TreeNavigator.resolveCanonicalPath(this.db, row.object_name);
  }

  _sampleObjectFor(className, version) {
    const names = this.scope(className, { version }).objectNames();
    if (names.length === 0) return null;
    return this.get(names[0]);
  }

  /** 对象树概要：从 Root 逐层展开，给出每层的类与 key */
  _treeOutline(maxDepth) {
    const build = (parentName, depth) => {
      if (depth > maxDepth) return [];
      const rows = this.db
        .prepare(
          `SELECT object_name, class_name FROM ${SYS_TABLE.ROOT_INDEX}
           WHERE parent_name = ? ORDER BY object_name`
        )
        .all(parentName);

      return rows.map((row) => ({
        objectName: row.object_name,
        className: row.class_name,
        path: TreeNavigator.resolveCanonicalPath(this.db, row.object_name),
        children: build(row.object_name, depth + 1),
      }));
    };

    return {
      root: 'Root',
      depth: maxDepth,
      nodes: build('Root', 1),
    };
  }

  _stats() {
    const total = this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${SYS_TABLE.ROOT_INDEX}`)
      .get().n;

    const rows = this.db.prepare(`SELECT object_name FROM ${SYS_TABLE.ROOT_INDEX}`).all();
    let maxDepth = 0;
    for (const row of rows) {
      const d = TreeNavigator.depthOf(this.db, row.object_name);
      if (d > maxDepth) maxDepth = d;
    }

    return { totalObjects: total - 1, maxDepth }; // 扣掉 Root 自身
  }
}

/**
 * Client 的 Proxy 拦截：实现 db.User -> ClassScope 的属性式访问
 *
 * 只在「属性确实不存在于 Client 上」时才尝试解析成类作用域，
 * 因此不会干扰 client.db / client.meta / client.put 等既有成员。
 */
const ClientHandler = {
  get(target, prop, receiver) {
    // 既有成员（含原型链上的方法）优先，避免任何遮蔽
    if (prop in target) return Reflect.get(target, prop, receiver);

    // 绝不能把 Client 变成 thenable，否则 await client 会行为异常
    if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;

    // 属性名可能是已注册的类（支持复数写法）
    if (typeof prop === 'string') {
      const scope = target._tryScope(prop);
      if (scope) return scope;
    }

    return Reflect.get(target, prop, receiver);
  },

  // 保持 instanceof Client 成立（DBHelper 的类型校验依赖它）
  getPrototypeOf() {
    return Client.prototype;
  },
};

// ---------------------------------------------------------------------------
// 高级扩展：DBHelper（读写辅助）
// ---------------------------------------------------------------------------

/**
 * DBHelper —— 日常读写辅助
 *
 * 与 Helper（client.helper，管理辅助）分工不同，这里放的是业务读写操作：
 * 条件查询、拓扑导航、差量更新、级联删除、事务。
 */
class DBHelper {
  constructor(client) {
    if (!client || !(client instanceof Client)) {
      throw new ODDMValidationError('DBHelper 需要一个 Client 实例');
    }
    this.client = client;
    this.db = client.db;
    this.apl = client.apl;
  }

  transaction(fn) {
    // 事务深度计数：嵌套事务只在最外层真正提交；身份映射也只在外层结束时清空，
    // 保证「同一事务内重复 get 命中缓存、跨事务再拿新快照」与 Ruby 一致。
    this.client._transactionDepth += 1;
    try {
      const tx = this.db.transaction(fn);
      return tx();
    } catch (err) {
      this.apl.error({ op: 'transaction', message: `事务回滚: ${err.message}` });
      throw err;
    } finally {
      this.client._transactionDepth -= 1;
      if (this.client._transactionDepth <= 0) {
        this.client._transactionDepth = 0;
        if (this.client.identityMapEnabled) this.client.clearIdentityMap();
      }
    }
  }

  /**
   * 差量更新：仅写入真正变化的字段
   * @returns {boolean} 是否触发了落盘
   */
  updateDiff(pathOrObjectName, newAttributes, options = {}) {
    const objectName = this.client.resolveToObjectName(pathOrObjectName);
    const current = this.client.get(objectName) || {};

    const diff = {};
    for (const [key, value] of Object.entries(newAttributes)) {
      if (!Object.prototype.hasOwnProperty.call(current, key) || !diffEqual(current[key], value)) {
        diff[key] = value;
      }
    }

    if (Object.keys(diff).length === 0) {
      this.apl.debug({ path: pathOrObjectName, op: 'update_diff', message: '无变更，跳过落盘' });
      return false;
    }

    this.client.put(objectName, diff, options);
    return true;
  }

  /**
   * 多属性条件查询（AND 语义）—— 底层 API
   *
   * 条件值写法：
   *   { age: 30 }              等值
   *   { age: '> 30' }          操作符：> >= < <= !=
   *   { score: [90, 100] }     区间（BETWEEN，闭区间）
   *   { age: { $gte: 18 } }    操作符对象（v0.3.1 新增，与查询 DSL 一致）
   *
   * 【注意历史约定】本方法的两元素数组是 BETWEEN（v0.2.0 起如此，保持不变）；
   * 而新的链式查询 DSL（db.User.where(...)）中数组是 IN 语义。两者不同，
   * 详见文档「查询语义对照表」。若想统一，推荐使用链式 DSL。
   *
   * @returns {string[]} 命中的 object_name 列表
   */
  where(className, conditions, options = {}) {
    assertValidClassName(className);
    if (!conditions || typeof conditions !== 'object' || Array.isArray(conditions)) {
      throw new ODDMQueryError('where 需要一个条件对象', { layer: className });
    }

    const version = options.version || this.client._latestVersionOf(className);
    const schema = this.client.meta.getSchema(className, version);
    if (!schema) {
      throw new ODDMValidationError(`未注册的类型: ${className} V${version}`, { layer: className });
    }

    // 继承场景下对象存在父类表里
    const table = this.client.meta.resolveTable(className, version);
    Schema.ensureTableByName(this.db, table);

    const clauses = [];
    const params = [];
    const unknown = [];

    for (const [attrName, expr] of Object.entries(conditions)) {
      const type = schema[attrName];
      if (!type) {
        unknown.push(attrName);
        continue;
      }
      const column = TYPE_TO_COLUMN[type];

      // ---- v0.3.1：操作符对象，与查询 DSL 保持一致的写法 ----
      if (expr && typeof expr === 'object' && !Array.isArray(expr) && !(expr instanceof Date)) {
        const parts = [];
        for (const [op, value] of Object.entries(expr)) {
          const sqlOp = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=', $ne: '!=' }[op];
          if (sqlOp) {
            if (!supportsRangeOperator(type)) {
              throw new ODDMQueryError(`${type} 类型不支持比较运算: ${attrName}`, {
                layer: `${className}.${attrName}`,
              });
            }
            parts.push(`${column} ${sqlOp} ?`);
            params.push(coerceLiteral(value, type, { layer: `${className}.${attrName}` }));
          } else if (op === '$in' || op === '$nin') {
            const list = Array.isArray(value) ? value : [value];
            const placeholders = list.map(() => '?').join(', ');
            parts.push(`${column} ${op === '$in' ? 'IN' : 'NOT IN'} (${placeholders})`);
            params.push(
              ...list.map((v) => coerceLiteral(v, type, { layer: `${className}.${attrName}` }))
            );
          } else if (op === '$like') {
            parts.push(`${column} LIKE ?`);
            params.push(String(value));
          } else {
            throw new ODDMQueryError(`不支持的查询操作符: ${op}`, {
              layer: `${className}.${attrName}`,
            });
          }
        }
        clauses.push(`(attribute_name = ? AND ${parts.join(' AND ')})`);
        params.splice(params.length - parts.length, 0, attrName);
        continue;
      }

      // ---- 数组：BETWEEN（v0.2.0 的历史约定，保持不变） ----
      if (Array.isArray(expr) && expr.length === 2) {
        if (!supportsRangeOperator(type)) {
          throw new ODDMQueryError(`${type} 类型不支持区间查询: ${attrName}`, {
            layer: `${className}.${attrName}`,
          });
        }
        clauses.push(`(attribute_name = ? AND ${column} BETWEEN ? AND ?)`);
        params.push(
          attrName,
          coerceLiteral(expr[0], type, { layer: `${className}.${attrName}` }),
          coerceLiteral(expr[1], type, { layer: `${className}.${attrName}` })
        );
      } else if (typeof expr === 'string' && /^(>=|<=|!=|>|<)\s*(.+)$/.test(expr)) {
        // ---- 字符串操作符：'> 30' ----
        const match = expr.match(/^(>=|<=|!=|>|<)\s*(.+)$/);
        const op = match[1];
        if (!supportsRangeOperator(type)) {
          throw new ODDMQueryError(`${type} 类型不支持比较运算: ${attrName}`, {
            layer: `${className}.${attrName}`,
          });
        }
        clauses.push(`(attribute_name = ? AND ${column} ${op} ?)`);
        params.push(attrName, coerceLiteral(match[2].trim(), type, { layer: `${className}.${attrName}` }));
      } else {
        // ---- 等值 ----
        clauses.push(`(attribute_name = ? AND ${column} = ?)`);
        params.push(attrName, coerceLiteral(expr, type, { layer: `${className}.${attrName}` }));
      }
    }

    if (clauses.length === 0) {
      if (unknown.length > 0) {
        throw new ODDMQueryError(
          `条件属性均未在 schema 中定义: ${unknown.join(', ')}（可选属性: ${Object.keys(schema).join(', ')}）`,
          { layer: className }
        );
      }
      return [];
    }

    if (unknown.length > 0) {
      this.apl.warn({
        path: className,
        layer: className,
        op: 'where',
        message: `忽略未定义的条件属性: ${unknown.join(', ')}`,
      });
    }

    // HAVING 计数必须用实际生成的子句数，而非传入的条件数：
    // 原实现用 conditions 的长度，一旦有属性未注册就会永远匹配不上，静默返回空。
    params.push(clauses.length);

    const sql = `
      SELECT object_name FROM ${table}
      WHERE ${clauses.join(' OR ')}
      GROUP BY object_name
      HAVING COUNT(DISTINCT attribute_name) = ?;
    `;

    const ctx = { apl: this.apl, path: `Root.${className}[*]`, layer: className, table };
    const rows = this._runLogged(ctx, 'where', sql, params);

    return rows.map((r) => r.object_name);
  }

  _runLogged(ctx, op, sql, params) {
    const start = Date.now();
    try {
      const rows = this.db.prepare(sql).all(...params);
      this.apl.debug({ ...ctx, op, sql, params, durationMs: Date.now() - start });
      return rows;
    } catch (err) {
      this.apl.error({ ...ctx, op, sql, params, message: err.message });
      throw err;
    }
  }

  children(pathOrObjectName) {
    const objectName = this.client.resolveToObjectName(pathOrObjectName);
    return this.db
      .prepare(
        `SELECT object_name, class_name, version FROM ${SYS_TABLE.ROOT_INDEX}
         WHERE parent_name = ? ORDER BY object_name`
      )
      .all(objectName);
  }

  siblings(pathOrObjectName) {
    const objectName = this.client.resolveToObjectName(pathOrObjectName);
    const row = this.client._indexRow(objectName);
    if (!row || !row.parent_name) return [];

    return this.db
      .prepare(
        `SELECT object_name, class_name, version FROM ${SYS_TABLE.ROOT_INDEX}
         WHERE parent_name = ? AND object_name != ? ORDER BY object_name`
      )
      .all(row.parent_name, objectName);
  }

  /**
   * 节点重挂载
   * 增加环检测：把节点挂到自身或其后代之下会形成环，使递归 CTE 失控。
   */
  moveTo(target, newParent, options = {}) {
    const targetName = this.client.resolveToObjectName(target);
    const newParentName = this.client.resolveToObjectName(newParent);

    if (newParentName !== 'Root' && !this.client.exists(newParentName)) {
      throw new ODDMNotFoundError(`目标父节点不存在: ${newParentName}`, { path: newParent });
    }

    if (TreeNavigator.isSelfOrDescendant(this.db, newParentName, targetName)) {
      throw new ODDMCycleError(
        `不能把 ${targetName} 挂载到 ${newParentName}：后者位于前者的子树内，会形成环`,
        { path: target, layer: targetName }
      );
    }

    if (!options.skipDepthCheck) {
      const parentDepth = newParentName === 'Root'
        ? 0
        : TreeNavigator.depthOf(this.db, newParentName);
      const subtreeHeight = this._subtreeHeight(targetName);
      if (parentDepth + 1 + subtreeHeight > this.client.maxDepth) {
        throw new ODDMDepthLimitError(
          `重挂载后子树深度为 ${parentDepth + 1 + subtreeHeight}，超过上限 ${this.client.maxDepth}`,
          { path: target, layer: targetName }
        );
      }
    }

    const sql = `UPDATE ${SYS_TABLE.ROOT_INDEX} SET parent_name = ? WHERE object_name = ?;`;
    this.transaction(() => {
      this.db.prepare(sql).run(newParentName, targetName);
    });

    this.apl.info({
      path: target,
      layer: targetName,
      op: 'move_to',
      message: `${targetName} -> ${newParentName}`,
    });

    return true;
  }

  _subtreeHeight(objectName) {
    const descendants = TreeNavigator.descendants(this.db, objectName);
    if (descendants.length === 0) return 0;
    return Math.max(...descendants.map((n) => n.depth));
  }

  /** 级联删除：先删子孙（按深度倒序），再删自身 */
  destroy(pathOrObjectName, options = {}) {
    const recursive = options.recursive !== false;
    const targetName = this.client.resolveToObjectName(pathOrObjectName);

    const targets = [{ object_name: targetName, depth: 0 }];
    if (recursive) {
      targets.push(...TreeNavigator.descendants(this.db, targetName));
    }

    const ordered = targets.sort((a, b) => b.depth - a.depth);

    this.transaction(() => {
      for (const node of ordered) {
        const row = this.client._indexRow(node.object_name);
        if (!row) continue;
        const table = this.client.meta.resolveTable(row.class_name, row.version);
        Schema.ensureTableByName(this.db, table);

        Repository.deleteObject(this.db, {
          objectName: node.object_name,
          table,
          ctx: { apl: this.apl, path: pathOrObjectName, layer: row.class_name, table },
        });

        // 删除即让缓存失效（含被级联删掉的子孙节点）
        this.client._invalidateIdentity(node.object_name);
      }
    });

    this.apl.info({
      path: pathOrObjectName,
      op: 'destroy',
      message: `删除 ${ordered.length} 个节点（recursive=${recursive}）`,
    });

    return true;
  }

  /** 便捷：反解完整 ODL 路径 */
  canonicalPath(pathOrObjectName) {
    const objectName = this.client.resolveToObjectName(pathOrObjectName);
    return TreeNavigator.resolveCanonicalPath(this.db, objectName);
  }

  ancestors(pathOrObjectName) {
    const objectName = this.client.resolveToObjectName(pathOrObjectName);
    return TreeNavigator.ancestors(this.db, objectName);
  }

  descendants(pathOrObjectName) {
    const objectName = this.client.resolveToObjectName(pathOrObjectName);
    return TreeNavigator.descendants(this.db, objectName);
  }
}

module.exports = {
  Client,
  DBHelper,
  DEFAULT_MAX_DEPTH,
  stableStringify,
  SYS_ATTR,
  SYS_TABLE,
  ALL_COLUMNS,
  tableNameFor,
};
