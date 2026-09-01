'use strict';

const {
  assertValidClassName,
  assertValidVersion,
  assertValidAttributeName,
  assertValidDataType,
  tableNameFor,
  TYPE_TO_COLUMN,
} = require('./naming');
const { ODDMValidationError } = require('./errors');

/**
 * 物理表管理
 *
 * 两张系统表 + 每（类, 版本）一张属性表：
 *   oddm_root_index    —— 全库唯一拓扑索引，树的形状完全由 parent_name 一列维系
 *   ODDM_Meta_Classes  —— 元类型定义（类 -> 版本 -> 属性 -> 类型）
 *   <Class>_V<Major>_<Minor> —— EAV 属性表，六类型各占一列
 */
class Schema {
  static initSystemTables(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS oddm_root_index (
        object_name TEXT PRIMARY KEY,
        class_name  TEXT NOT NULL,
        version     TEXT NOT NULL,
        parent_name TEXT,
        created_at  TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS ODDM_Meta_Classes (
        class_name     TEXT NOT NULL,
        version        TEXT NOT NULL,
        attribute_name TEXT NOT NULL,
        data_type      TEXT NOT NULL,
        PRIMARY KEY (class_name, version, attribute_name)
      );
      INSERT INTO oddm_root_index (object_name, class_name, version, parent_name)
      VALUES ('Root', 'System', '1.0', NULL)
      ON CONFLICT(object_name) DO NOTHING;
    `);

    // children / descendants 的递归 CTE 每一层都要按 parent_name 过滤，无索引即全表扫描
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_root_index_parent
        ON oddm_root_index(parent_name);
      CREATE INDEX IF NOT EXISTS idx_root_index_class
        ON oddm_root_index(class_name, version);
    `);
  }

  /**
   * 确保 (类, 版本) 对应的属性表存在，并建好 EAV 查询必需的复合索引。
   * 表名经 naming 层白名单校验后才允许拼进 SQL。
   */
  static ensureClassTable(db, className, version) {
    const table = tableNameFor(className, version);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        object_name    TEXT NOT NULL,
        attribute_name TEXT NOT NULL,
        v_string       TEXT,
        v_int          INTEGER,
        v_float        REAL,
        v_boolean      INTEGER,
        v_datetime     TEXT,
        v_json         TEXT,
        PRIMARY KEY (object_name, attribute_name)
      );
    `);

    // where 的形态恒为 (attribute_name = ? AND v_xxx <op> ?)，故建 (属性, 值) 复合索引
    for (const column of Object.values(TYPE_TO_COLUMN)) {
      if (column === 'v_json') continue; // json 以文本存，索引无实际收益
      const indexName = `idx_${table}_${column}`;
      db.exec(`
        CREATE INDEX IF NOT EXISTS ${indexName}
          ON ${table}(attribute_name, ${column});
      `);
    }

    return table;
  }
}

/**
 * 元类型管理器
 *
 * 重要修正：schema 缓存从「进程级静态字典」降为「实例级」。
 * 原实现用 static 字段缓存，同一进程内多个 Client 指向不同数据库时会互相串 schema，
 * 导致按错误的类型列落盘。现在每个 Client 持有自己的 MetaClassManager 实例。
 */
class MetaClassManager {
  constructor(db) {
    this.db = db;
    this._cache = new Map();
  }

  static _key(className, version) {
    return `${className}:${version}`;
  }

  clearCache() {
    this._cache.clear();
    return this;
  }

  getSchema(className, version) {
    assertValidClassName(className);
    assertValidVersion(version);

    const key = MetaClassManager._key(className, version);
    if (this._cache.has(key)) return this._cache.get(key);

    const rows = this.db
      .prepare(
        `SELECT attribute_name, data_type FROM ODDM_Meta_Classes
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

  defineClass(className, schemaHash, version = '1.0') {
    assertValidClassName(className);
    assertValidVersion(version);

    if (!schemaHash || typeof schemaHash !== 'object' || Array.isArray(schemaHash)) {
      throw new ODDMValidationError(`defineClass 需要一个属性定义对象: ${className}`);
    }
    const entries = Object.entries(schemaHash);
    if (entries.length === 0) {
      throw new ODDMValidationError(`defineClass 的属性定义不能为空: ${className}`);
    }

    const normalized = {};
    for (const [attrName, dataType] of entries) {
      assertValidAttributeName(attrName);
      assertValidDataType(dataType);
      normalized[attrName] = dataType;
    }

    const stmt = this.db.prepare(`
      INSERT INTO ODDM_Meta_Classes (class_name, version, attribute_name, data_type)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(class_name, version, attribute_name)
      DO UPDATE SET data_type = excluded.data_type;
    `);

    const tx = this.db.transaction(() => {
      for (const [attrName, dataType] of Object.entries(normalized)) {
        stmt.run(className, version, attrName, dataType);
      }
    });
    tx();

    // 注册即建表：类一旦定义，其属性表与索引随即存在，
    // 避免自省 / countInstances 在尚无实例时撞上 "no such table"。
    Schema.ensureClassTable(this.db, className, version);

    this._cache.set(MetaClassManager._key(className, version), normalized);
    return normalized;
  }

  /** 列出全部已注册的 (类, 版本) 及其属性定义 —— 自省接口的数据来源 */
  listClasses() {
    const rows = this.db
      .prepare(
        `SELECT class_name, version, attribute_name, data_type
         FROM ODDM_Meta_Classes
         ORDER BY class_name, version, attribute_name`
      )
      .all();

    const byKey = new Map();
    for (const row of rows) {
      const key = MetaClassManager._key(row.class_name, row.version);
      if (!byKey.has(key)) {
        byKey.set(key, {
          className: row.class_name,
          version: row.version,
          table: tableNameFor(row.class_name, row.version),
          schema: {},
        });
      }
      byKey.get(key).schema[row.attribute_name] = row.data_type;
    }
    return Array.from(byKey.values());
  }

  /** 某类某版本在库中的实例数 —— 自省接口用 */
  countInstances(className, version) {
    const table = tableNameFor(className, version);
    const exists = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!exists) return 0;

    const row = this.db.prepare(`SELECT COUNT(DISTINCT object_name) AS n FROM ${table}`).get();
    return row ? row.n : 0;
  }
}

module.exports = { Schema, MetaClassManager };
