'use strict';

const Database = require('better-sqlite3');

const { Schema, MetaClassManager } = require('./schema');
const { PathParser, TreeNavigator } = require('./path');
const { Repository, ALL_COLUMNS } = require('./repository');
const { APL } = require('./apl');
const {
  TYPE_TO_COLUMN,
  assertValidClassName,
  assertValidVersion,
  tableNameFor,
  coerceLiteral,
  supportsRangeOperator,
  isPath,
} = require('./naming');
const {
  ODDMValidationError,
  ODDMNotFoundError,
  ODDMQueryError,
  ODDMCycleError,
  ODDMDepthLimitError,
} = require('./errors');

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
   */
  constructor(options = {}) {
    const opts = typeof options === 'string' ? { path: options } : options || {};

    this.path = opts.path ?? ':memory:';
    this.strict = opts.strict !== false;
    this.maxDepth = Number.isInteger(opts.maxDepth) ? opts.maxDepth : DEFAULT_MAX_DEPTH;

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
  }

  close() {
    if (this.db && this.db.open) this.db.close();
    return this;
  }

  // -------------------------------------------------------------------------
  // 元类型
  // -------------------------------------------------------------------------

  defineClass(className, schemaHash, version = '1.0') {
    assertValidClassName(className);
    assertValidVersion(version);
    return this.meta.defineClass(className, schemaHash, version);
  }

  /** 取该类已注册的最大版本，用于路径中间节点占位 */
  _latestVersionOf(className) {
    const row = this.db
      .prepare(
        `SELECT version FROM ODDM_Meta_Classes
         WHERE class_name = ? ORDER BY version DESC LIMIT 1`
      )
      .get(className);
    return row ? row.version : '1.0';
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
        'SELECT object_name, class_name, version, parent_name FROM oddm_root_index WHERE object_name = ?'
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
      INSERT INTO oddm_root_index (object_name, class_name, version, parent_name)
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
   */
  put(pathOrObjectName, attributes, options = {}) {
    if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
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

    const table = tableNameFor(className, version);
    Schema.ensureClassTable(this.db, className, version);

    const ctx = { apl: this.apl, path: pathOrObjectName, layer: className, table };

    return Repository.saveObject(this.db, {
      className,
      objectName,
      attributes,
      parentName,
      version,
      schema,
      strict,
      ctx,
    });
  }

  get(pathOrObjectName) {
    const objectName = this.resolveToObjectName(pathOrObjectName);
    const row = this._indexRow(objectName);
    if (!row) return null;

    const schema = this.meta.getSchema(row.class_name, row.version);
    if (!schema) {
      throw new ODDMValidationError(
        `对象 ${objectName} 的类型 ${row.class_name} V${row.version} 未注册`,
        { path: pathOrObjectName, layer: row.class_name }
      );
    }

    const table = tableNameFor(row.class_name, row.version);
    Schema.ensureClassTable(this.db, row.class_name, row.version);

    const ctx = { apl: this.apl, path: pathOrObjectName, layer: row.class_name, table };

    return Repository.findObject(this.db, {
      objectName,
      className: row.class_name,
      version: row.version,
      schema,
      ctx,
    });
  }

  // -------------------------------------------------------------------------
  // 自省（供 AI 与工具链理解当前数据库）
  // -------------------------------------------------------------------------

  /**
   * 全库自省快照
   * @param {object} [options]
   * @param {number} [options.treeDepth=2] 对象树展开层数
   * @param {boolean} [options.includeSample=true] 是否给出示例路径与示例对象
   */
  introspect(options = {}) {
    const treeDepth = Number.isInteger(options.treeDepth) ? options.treeDepth : 2;
    const includeSample = options.includeSample !== false;

    const classes = this.meta.listClasses().map((cls) => {
      const entry = {
        className: cls.className,
        version: cls.version,
        table: cls.table,
        schema: cls.schema,
        columns: Object.fromEntries(
          Object.entries(cls.schema).map(([attr, type]) => [attr, TYPE_TO_COLUMN[type]])
        ),
        instanceCount: this.meta.countInstances(cls.className, cls.version),
      };
      if (includeSample) {
        entry.samplePath = this._samplePathFor(cls.className, cls.version);
        entry.sampleObject = this._sampleObjectFor(cls.className, cls.version);
      }
      return entry;
    });

    return {
      root: 'Root',
      odlSyntax: "Root.ClassName['Key'].ChildClass['ChildKey']",
      maxDepth: this.maxDepth,
      strict: this.strict,
      classes,
      tree: this._treeOutline(treeDepth),
      stats: this._stats(),
    };
  }

  /** 单个类的自省详情 */
  introspectClass(className, version) {
    const resolvedVersion = version || this._latestVersionOf(className);
    const schema = this.meta.getSchema(className, resolvedVersion);
    if (!schema) {
      throw new ODDMNotFoundError(`未注册的类型: ${className} V${resolvedVersion}`);
    }

    return {
      className,
      version: resolvedVersion,
      table: tableNameFor(className, resolvedVersion),
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
    const table = tableNameFor(className, version);
    const row = this.db
      .prepare(`SELECT DISTINCT object_name FROM ${table} LIMIT 1`)
      .get();
    if (!row) return `Root.${className}['<key>']`;
    return TreeNavigator.resolveCanonicalPath(this.db, row.object_name);
  }

  _sampleObjectFor(className, version) {
    const table = tableNameFor(className, version);
    const row = this.db
      .prepare(`SELECT DISTINCT object_name FROM ${table} LIMIT 1`)
      .get();
    if (!row) return null;
    return this.get(row.object_name);
  }

  /** 对象树概要：从 Root 逐层展开，给出每层的类与 key */
  _treeOutline(maxDepth) {
    const build = (parentName, depth) => {
      if (depth > maxDepth) return [];
      const rows = this.db
        .prepare(
          `SELECT object_name, class_name FROM oddm_root_index WHERE parent_name = ? ORDER BY object_name`
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
      .prepare('SELECT COUNT(*) AS n FROM oddm_root_index')
      .get().n;

    const rows = this.db.prepare('SELECT object_name FROM oddm_root_index').all();
    let maxDepth = 0;
    for (const row of rows) {
      const d = TreeNavigator.depthOf(this.db, row.object_name);
      if (d > maxDepth) maxDepth = d;
    }

    return { totalObjects: total - 1, maxDepth }; // 扣掉 Root 自身
  }
}

// ---------------------------------------------------------------------------
// 高级扩展
// ---------------------------------------------------------------------------

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
    const tx = this.db.transaction(fn);
    try {
      return tx();
    } catch (err) {
      this.apl.error({ op: 'transaction', message: `事务回滚: ${err.message}` });
      throw err;
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
   * 多属性条件查询（AND 语义）
   *
   * 条件值写法：
   *   { age: 30 }              等值
   *   { age: '> 30' }          操作符：> >= < <= !=
   *   { score: [90, 100] }     区间（BETWEEN，闭区间）
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

    const table = tableNameFor(className, version);
    Schema.ensureClassTable(this.db, className, version);

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
        'SELECT object_name, class_name, version FROM oddm_root_index WHERE parent_name = ? ORDER BY object_name'
      )
      .all(objectName);
  }

  siblings(pathOrObjectName) {
    const objectName = this.client.resolveToObjectName(pathOrObjectName);
    const row = this.client._indexRow(objectName);
    if (!row || !row.parent_name) return [];

    return this.db
      .prepare(
        `SELECT object_name, class_name, version FROM oddm_root_index
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

    const sql = 'UPDATE oddm_root_index SET parent_name = ? WHERE object_name = ?;';
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
        const table = tableNameFor(row.class_name, row.version);
        Schema.ensureClassTable(this.db, row.class_name, row.version);

        Repository.deleteObject(this.db, {
          objectName: node.object_name,
          table,
          ctx: { apl: this.apl, path: pathOrObjectName, layer: row.class_name, table },
        });
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

module.exports = { Client, DBHelper, DEFAULT_MAX_DEPTH, stableStringify };
