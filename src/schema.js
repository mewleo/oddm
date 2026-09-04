'use strict';

/**
 * 作者：双子-阿攀达 | schema.js | v0.3.1
 *
 * ============================================================================
 * 物理表管理与元类型管理
 *
 * 【系统表清单（v0.3.1）】
 *   oddm_root_index    拓扑索引：对象 -> (类, 版本, 父节点)
 *                      · parent_name 一列维系整棵树的形状
 *                      · class_name 一列用于继承多态时判别真实类型
 *   ODDM_Meta_Classes  属性级元定义（类 -> 版本 -> 属性 -> 类型）
 *   ODDM_Class_Defs    类级定义（类 -> 版本 -> 父类 / 物理表名）【v0.3.1 新增】
 *   oddm_root_views    视图路由表【v0.3.1 新增】
 *   <Class>_V<M>_<m>   EAV 属性表，8 个抽屉列
 *
 * 【v0.3.1 三处结构变更】
 *   1. EAV 属性表新增 v_ref / v_refs 两个抽屉列（支持引用类型）
 *   2. 新增 ODDM_Class_Defs（支持继承多态：子类复用父类表）
 *   3. 新增 oddm_root_views（视图路由，对齐 Ruby 版 oddm_root 表）
 *
 * 【关于旧库迁移】
 *   第 1 项是破坏性的：v0.2.0 建的 EAV 表只有 6 个抽屉列。为此
 *   migrateClassTable() 会在每次 ensureClassTable 时检查实际列，
 *   缺哪个补哪个（ALTER TABLE ADD COLUMN），保证老库打开即自动升级，
 *   无需手工干预。ALTER ADD COLUMN 对已有行填 NULL，语义上等价于
 *   「这些老对象没有引用属性」，是安全的。
 * ============================================================================
 */

const {
  assertValidClassName,
  assertValidVersion,
  assertValidAttributeName,
  assertValidDataType,
  tableNameFor,
  TYPE_TO_COLUMN,
  ALL_DRAWER_COLUMNS,
  IDENTIFIER_RE,
} = require('./naming');
const {
  ODDMValidationError,
  ODDMNotFoundError,
} = require('./errors');
const {
  SYS_TABLE,
  VIEW_TYPE,
  isSystemAttribute,
} = require('./constants');

/**
 * 抽屉列 -> SQLite 列类型
 * 只有数值/布尔用 INTEGER、浮点用 REAL，其余（含日期、JSON、引用）统一 TEXT。
 * 日期用 TEXT 是为了存 ISO8601 字符串，可直接做字符串比较（等价于时间序比较）。
 */
const COLUMN_SQL_TYPE = Object.freeze({
  v_string: 'TEXT',
  v_int: 'INTEGER',
  v_float: 'REAL',
  v_boolean: 'INTEGER',
  v_datetime: 'TEXT',
  v_json: 'TEXT',
  v_ref: 'TEXT',
  v_refs: 'TEXT',
});

class Schema {
  static initSystemTables(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${SYS_TABLE.ROOT_INDEX} (
        object_name TEXT PRIMARY KEY,
        class_name  TEXT NOT NULL,
        version     TEXT NOT NULL,
        parent_name TEXT,
        created_at  TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS ${SYS_TABLE.META_CLASSES} (
        class_name     TEXT NOT NULL,
        version        TEXT NOT NULL,
        attribute_name TEXT NOT NULL,
        data_type      TEXT NOT NULL,
        PRIMARY KEY (class_name, version, attribute_name)
      );
      INSERT INTO ${SYS_TABLE.ROOT_INDEX} (object_name, class_name, version, parent_name)
      VALUES ('Root', 'System', '1.0', NULL)
      ON CONFLICT(object_name) DO NOTHING;
    `);

    // children / descendants 的递归 CTE 每一层都要按 parent_name 过滤，无索引即全表扫描
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_root_index_parent
        ON ${SYS_TABLE.ROOT_INDEX}(parent_name);
      CREATE INDEX IF NOT EXISTS idx_root_index_class
        ON ${SYS_TABLE.ROOT_INDEX}(class_name, version);
    `);

    Schema.initClassDefsTable(db);
    Schema.initViewsTable(db);
  }

  /**
   * 类级定义表（v0.3.1 新增）
   *
   * 【为什么属性级定义不够用】
   *   ODDM_Meta_Classes 的主键是 (类, 版本, 属性)，每个属性一行。
   *   如果把 parent_class 塞进去，同一个类的每一行都要重复一遍父类名，
   *   改一次父类要更新 N 行，且无法表达「某版本下还没有任何属性」的类。
   *   因此类级信息（父类、物理表名）单独成表，与 Ruby 版 metaclass 表对齐。
   */
  static initClassDefsTable(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${SYS_TABLE.CLASS_DEFS} (
        class_name   TEXT NOT NULL,
        version      TEXT NOT NULL,
        parent_class TEXT,
        parent_version TEXT,
        table_name   TEXT NOT NULL,
        created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (class_name, version)
      );
    `);
  }

  /**
   * 视图路由表（v0.3.1 新增）
   *
   * 对齐 Ruby 版的 oddm_root 表。视图在 ODDM 里是一等公民：
   * 数据库里真的 CREATE VIEW，同时在这里登记一条路由，之后就能用
   * root.query('active_users') 这样的具名方式访问。
   */
  static initViewsTable(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${SYS_TABLE.ROOT_VIEWS} (
        name       TEXT PRIMARY KEY,
        view_name  TEXT NOT NULL,
        view_type  TEXT NOT NULL,
        class_name TEXT,
        version    TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  /**
   * 确保 (类, 版本) 对应的属性表存在，并建好 EAV 查询必需的复合索引。
   * 表名经 naming 层白名单校验后才允许拼进 SQL。
   *
   * v0.3.1：建表后追加一次列迁移，兼容 v0.2.0 留下的 6 列老表。
   */
  /**
   * 确保 (类, 版本) 对应的属性表存在，并建好 EAV 查询必需的复合索引。
   *
   * 注意：继承场景下子类复用父类的表，因此这里会解析出真正的物理表名，
   * 再交给 ensureTableByName 处理，避免为子类误建一张永远不会用的空表。
   */
  static ensureClassTable(db, metaOrDb, className, version) {
    // 支持两种调用形态：
    //   ensureClassTable(db, className, version)            —— 内部按类名推算表
    //   ensureClassTable(db, metaManager, className, version) —— 走继承解析
    let meta = null;
    let cls = className;
    let ver = version;

    if (metaOrDb && typeof metaOrDb.resolveTable === 'function') {
      meta = metaOrDb;
    } else {
      cls = metaOrDb;
      ver = className;
    }

    const table = meta ? meta.resolveTable(cls, ver) : tableNameFor(cls, ver);
    return Schema.ensureTableByName(db, table);
  }

  /**
   * 按物理表名确保表存在（建表 + 补列 + 建索引）
   *
   * 表名来自 tableNameFor 或类定义表，均经过标识符白名单校验；
   * 这里再校验一次，因为表名最终要字符串插值拼进 DDL。
   */
  static ensureTableByName(db, table) {
    if (typeof table !== 'string' || !IDENTIFIER_RE.test(table)) {
      throw new ODDMValidationError(`非法的表名: ${JSON.stringify(table)}`);
    }

    const columnDefs = ALL_DRAWER_COLUMNS.map(
      (col) => `${col} ${COLUMN_SQL_TYPE[col]}`
    ).join(',\n        ');

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        object_name    TEXT NOT NULL,
        attribute_name TEXT NOT NULL,
        ${columnDefs},
        PRIMARY KEY (object_name, attribute_name)
      );
    `);

    // 老库补列：v0.2.0 的 EAV 表缺 v_ref / v_refs
    Schema.migrateClassTable(db, table);

    // where 的形态恒为 (attribute_name = ? AND v_xxx <op> ?)，故建 (属性, 值) 复合索引
    for (const column of ALL_DRAWER_COLUMNS) {
      // json 与 refs 以文本存，索引无实际收益（refs 的包含匹配走不到索引）
      if (column === 'v_json' || column === 'v_refs') continue;
      const indexName = `idx_${table}_${column}`;
      db.exec(`
        CREATE INDEX IF NOT EXISTS ${indexName}
          ON ${table}(attribute_name, ${column});
      `);
    }

    return table;
  }

  /**
   * 老库迁移：为已存在的 EAV 表补齐缺失的抽屉列
   *
   * PRAGMA table_info 不接受参数绑定，表名只能字符串插值，
   * 因此这里先做一次标识符白名单校验，杜绝表名注入。
   */
  static migrateClassTable(db, table) {
    if (typeof table !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new ODDMValidationError(`非法的表名: ${JSON.stringify(table)}`);
    }

    const exists = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table);
    if (!exists) return [];

    const existing = new Set(
      db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    );

    const added = [];
    for (const column of ALL_DRAWER_COLUMNS) {
      if (existing.has(column)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${COLUMN_SQL_TYPE[column]};`);
      added.push(column);
    }
    return added;
  }
}

/**
 * 元类型管理器
 *
 * 重要修正（v0.2.0）：schema 缓存从「进程级静态字典」降为「实例级」。
 * 原实现用 static 字段缓存，同一进程内多个 Client 指向不同数据库时会互相串
 * schema，导致按错误的类型列落盘。现在每个 Client 持有自己的实例。
 *
 * v0.3.1 新增职责：
 *   - 类级定义（父类、物理表名）的读写
 *   - 继承链解析与多态类集合计算
 *   - 视图路由的登记与查询
 */
class MetaClassManager {
  constructor(db) {
    this.db = db;
    this._cache = new Map();
    this._defCache = new Map();
  }

  static _key(className, version) {
    return `${className}:${version}`;
  }

  clearCache() {
    this._cache.clear();
    this._defCache.clear();
    return this;
  }

  // -------------------------------------------------------------------------
  // 属性级 schema
  // -------------------------------------------------------------------------

  getSchema(className, version) {
    assertValidClassName(className);
    assertValidVersion(version);

    const key = MetaClassManager._key(className, version);
    if (this._cache.has(key)) return this._cache.get(key);

    const rows = this.db
      .prepare(
        `SELECT attribute_name, data_type FROM ${SYS_TABLE.META_CLASSES}
         WHERE class_name = ? AND version = ?`
      )
      .all(className, version);

    if (rows.length === 0) return null;

    const schema = {};
    for (const row of rows) schema[row.attribute_name] = row.data_type;
    this._cache.set(key, schema);
    return schema;
  }

  /** 读取时若类未注册，直接建表会造成“无 schema 的空表”，故强制要求已注册 */
  requireSchema(className, version, context = {}) {
    const schema = this.getSchema(className, version);
    if (!schema) {
      throw new ODDMValidationError(
        `未定义的类型 ${className}（版本 ${version}），请先调用 defineClass`,
        context
      );
    }
    return schema;
  }

  // -------------------------------------------------------------------------
  // 类级定义（继承支持）
  // -------------------------------------------------------------------------

  /** 读取类级定义；老库没有记录时返回 null（视为无父类的根类） */
  getClassDef(className, version) {
    const key = MetaClassManager._key(className, version);
    if (this._defCache.has(key)) return this._defCache.get(key);

    const row = this.db
      .prepare(
        `SELECT class_name, version, parent_class, parent_version, table_name
         FROM ${SYS_TABLE.CLASS_DEFS} WHERE class_name = ? AND version = ?`
      )
      .get(className, version);

    const def = row
      ? {
          className: row.class_name,
          version: row.version,
          parentClass: row.parent_class || null,
          parentVersion: row.parent_version || null,
          table: row.table_name,
        }
      : null;

    this._defCache.set(key, def);
    return def;
  }

  /**
   * 该类实际使用的物理表名
   *
   * 子类复用父类（最终是根祖先）的表，这是继承多态的基础：
   * 同一张表里混放 Article 与 TechArticle 的行，靠 oddm_root_index.class_name
   * 判别真实类型。
   */
  resolveTable(className, version) {
    const def = this.getClassDef(className, version);
    if (def && def.table) return def.table;
    return tableNameFor(className, version);
  }

  /**
   * 继承链（不含自身），如 TechArticle -> [Article, Document]
   *
   * 用 visited 集合防止将来有人手改数据库造成循环继承导致死循环。
   */
  ancestorChain(className, version) {
    const chain = [];
    const visited = new Set();
    let currentName = className;
    let currentVersion = version;

    while (true) {
      const key = MetaClassManager._key(currentName, currentVersion);
      if (visited.has(key)) {
        throw new ODDMValidationError(
          `检测到循环继承: ${[...visited, key].join(' -> ')}`
        );
      }
      visited.add(key);

      const def = this.getClassDef(currentName, currentVersion);
      if (!def || !def.parentClass) break;

      chain.push({ className: def.parentClass, version: def.parentVersion || currentVersion });
      currentName = def.parentClass;
      currentVersion = def.parentVersion || currentVersion;
    }

    return chain;
  }

  /**
   * 多态类集合：查询某类时应当包含哪些 class_name
   *
   * 查父类 -> 返回 [父类, ...所有子孙类]（多态）
   * 查子类 -> 只返回 [子类] 自身
   *
   * 【为什么不照搬 Ruby 的 __class__ 属性方案】
   *   Ruby 版把 __class__ 存成 EAV 属性来判别；但 Node 版的 oddm_root_index
   *   本来就有 class_name 列，再存一份就是双份真相。Node 版以索引表为准，
   *   查询时直接按 class_name 集合过滤即可，既省一列又不会不一致。
   */
  polymorphicClassNames(className, version = '1.0') {
    const allDefs = this.listClassDefs();
    const self = { className, version };
    const result = [self];

    // BFS 收集所有以 className 为祖先的类
    const queue = [self];
    const visited = new Set([MetaClassManager._key(className, version)]);

    while (queue.length > 0) {
      const current = queue.shift();
      for (const def of allDefs) {
        if (!def.parentClass) continue;
        if (def.parentClass !== current.className) continue;
        // 版本不同则视为不同继承线，不参与多态
        if ((def.parentVersion || def.version) !== current.version) continue;

        const key = MetaClassManager._key(def.className, def.version);
        if (visited.has(key)) continue;
        visited.add(key);

        const child = { className: def.className, version: def.version };
        result.push(child);
        queue.push(child);
      }
    }

    return result;
  }

  /** 列出全部类级定义 */
  listClassDefs() {
    const rows = this.db
      .prepare(
        `SELECT class_name, version, parent_class, parent_version, table_name
         FROM ${SYS_TABLE.CLASS_DEFS} ORDER BY class_name, version`
      )
      .all();

    return rows.map((row) => ({
      className: row.class_name,
      version: row.version,
      parentClass: row.parent_class || null,
      parentVersion: row.parent_version || null,
      table: row.table_name,
    }));
  }

  /**
   * 注册类定义（支持继承）
   *
   * @param {string} className
   * @param {object} schemaHash 属性 -> 类型
   * @param {string} [version='1.0']
   * @param {object} [options]
   * @param {string} [options.parentClass] 父类名，设置后本类复用父类的物理表
   * @param {string} [options.parentVersion] 父类版本，默认与子类版本相同
   */
  defineClass(className, schemaHash, version = '1.0', options = {}) {
    assertValidClassName(className);
    assertValidVersion(version);

    if (!schemaHash || typeof schemaHash !== 'object' || Array.isArray(schemaHash)) {
      throw new ODDMValidationError(`defineClass 需要一个属性定义对象: ${className}`);
    }
    const entries = Object.entries(schemaHash);
    if (entries.length === 0) {
      throw new ODDMValidationError(`defineClass 的属性定义不能为空: ${className}`);
    }

    for (const [attrName] of entries) {
      // 系统元数据属性由框架独占，业务不得占用，否则会与框架写入冲突
      if (isSystemAttribute(attrName)) {
        throw new ODDMValidationError(
          `属性名 "${attrName}" 是 ODDM 保留的系统属性，不能使用`
        );
      }
    }

    const normalized = {};
    for (const [attrName, dataType] of entries) {
      assertValidAttributeName(attrName);
      assertValidDataType(dataType);
      normalized[attrName] = dataType;
    }

    const parentClass = options.parentClass || null;
    const parentVersion = options.parentVersion || (parentClass ? version : null);

    // ---- 继承处理：子类复用父类表，属性清单 = 父类属性 + 子类扩展属性 ----
    let table;
    let mergedAttributes = { ...normalized };

    if (parentClass) {
      assertValidClassName(parentClass);
      const parentDef = this.getClassDef(parentClass, parentVersion);
      if (!parentDef) {
        throw new ODDMNotFoundError(
          `父类未注册: ${parentClass} V${parentVersion}（定义 ${className} 前请先定义父类）`
        );
      }
      const parentSchema = this.getSchema(parentClass, parentVersion);
      if (!parentSchema) {
        throw new ODDMNotFoundError(
          `父类 ${parentClass} V${parentVersion} 缺少属性定义`
        );
      }
      // 父类属性在前，子类同名属性覆盖父类（属性收窄/改类型）
      table = parentDef.table;
      mergedAttributes = { ...parentSchema, ...normalized };
    } else {
      table = tableNameFor(className, version);
    }

    const stmt = this.db.prepare(`
      INSERT INTO ${SYS_TABLE.META_CLASSES} (class_name, version, attribute_name, data_type)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(class_name, version, attribute_name)
      DO UPDATE SET data_type = excluded.data_type;
    `);

    const defStmt = this.db.prepare(`
      INSERT INTO ${SYS_TABLE.CLASS_DEFS}
        (class_name, version, parent_class, parent_version, table_name)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(class_name, version) DO UPDATE SET
        parent_class   = excluded.parent_class,
        parent_version = excluded.parent_version,
        table_name     = excluded.table_name;
    `);

    const tx = this.db.transaction(() => {
      for (const [attrName, dataType] of Object.entries(mergedAttributes)) {
        stmt.run(className, version, attrName, dataType);
      }
      defStmt.run(className, version, parentClass, parentVersion, table);
    });
    tx();

    // 注册即建表：父类才需要建（子类复用父类表）；
    // 由于子类已把表设为父类表，这里统一 ensure 一次即可，重复调用是幂等的。
    Schema.ensureClassTable(this.db, className, version);
    if (parentClass) Schema.migrateClassTable(this.db, table);

    const key = MetaClassManager._key(className, version);
    this._cache.set(key, mergedAttributes);
    this._defCache.set(key, {
      className,
      version,
      parentClass,
      parentVersion,
      table,
    });

    return mergedAttributes;
  }

  /** 列出全部已注册的 (类, 版本) 及其属性定义 —— 自省接口的数据来源 */
  listClasses() {
    const rows = this.db
      .prepare(
        `SELECT class_name, version, attribute_name, data_type
         FROM ${SYS_TABLE.META_CLASSES}
         ORDER BY class_name, version, attribute_name`
      )
      .all();

    const byKey = new Map();
    for (const row of rows) {
      const key = MetaClassManager._key(row.class_name, row.version);
      if (!byKey.has(key)) {
        const def = this.getClassDef(row.class_name, row.version);
        byKey.set(key, {
          className: row.class_name,
          version: row.version,
          table: def ? def.table : tableNameFor(row.class_name, row.version),
          parentClass: def ? def.parentClass : null,
          schema: {},
        });
      }
      byKey.get(key).schema[row.attribute_name] = row.data_type;
    }
    return Array.from(byKey.values());
  }

  /**
   * 某类某版本在库中的实例数
   *
   * v0.3.1 改为按拓扑索引统计：继承场景下对象可能落在父类的表里，
   * 直接数属性表会数错（把兄弟子类的对象也算进来），而索引表的 class_name
   * 才是真实类型，用它统计既准确又能走 idx_root_index_class 索引。
   */
  countInstances(className, version) {
    const scope = this.polymorphicClassNames(className, version);
    const names = scope.map((s) => s.className);
    const placeholders = names.map(() => '?').join(', ');

    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${SYS_TABLE.ROOT_INDEX}
         WHERE class_name IN (${placeholders})`
      )
      .get(...names);

    return row ? row.n : 0;
  }

  /** 列出某个类的全部已注册版本 */
  listVersions(className) {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT version FROM ${SYS_TABLE.META_CLASSES}
         WHERE class_name = ? ORDER BY version DESC`
      )
      .all(className);
    return rows.map((r) => r.version);
  }

  // -------------------------------------------------------------------------
  // 视图路由（v0.3.1 新增）
  // -------------------------------------------------------------------------

  /** 登记一条视图路由 */
  registerView(name, viewName, viewType, className = null, version = null) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ODDMValidationError('视图路由名不能为空');
    }
    this.db
      .prepare(
        `INSERT INTO ${SYS_TABLE.ROOT_VIEWS}
           (name, view_name, view_type, class_name, version)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           view_name  = excluded.view_name,
           view_type  = excluded.view_type,
           class_name = excluded.class_name,
           version    = excluded.version;`
      )
      .run(name, viewName, viewType, className, version);
    return true;
  }

  /** 查询单条视图路由，不存在返回 null */
  findView(name) {
    const row = this.db
      .prepare(
        `SELECT name, view_name, view_type, class_name, version
         FROM ${SYS_TABLE.ROOT_VIEWS} WHERE name = ?`
      )
      .get(name);
    if (!row) return null;
    return {
      name: row.name,
      viewName: row.view_name,
      viewType: row.view_type,
      className: row.class_name || null,
      version: row.version || null,
    };
  }

  /** 注销视图路由 */
  unregisterView(name) {
    this.db.prepare(`DELETE FROM ${SYS_TABLE.ROOT_VIEWS} WHERE name = ?`).run(name);
    return true;
  }

  /** 列出视图路由，可按类型筛选 */
  listViews(viewType = null) {
    const sql = viewType
      ? `SELECT name, view_name, view_type, class_name, version
         FROM ${SYS_TABLE.ROOT_VIEWS} WHERE view_type = ? ORDER BY name`
      : `SELECT name, view_name, view_type, class_name, version
         FROM ${SYS_TABLE.ROOT_VIEWS} ORDER BY name`;
    const rows = viewType ? this.db.prepare(sql).all(viewType) : this.db.prepare(sql).all();

    return rows.map((row) => ({
      name: row.name,
      viewName: row.view_name,
      viewType: row.view_type,
      className: row.class_name || null,
      version: row.version || null,
    }));
  }
}

module.exports = { Schema, MetaClassManager, COLUMN_SQL_TYPE, VIEW_TYPE, TYPE_TO_COLUMN };
