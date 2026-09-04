'use strict';

/**
 * 作者：双子-阿攀达 | repository.js | v0.3.1
 *
 * ============================================================================
 * 物理读写层（机制层）
 *
 * 【职责边界】
 *   本层只负责「一条 SQL 怎么落到一个对象上」，不关心路径怎么解析、类之间
 *   怎么继承。策略（寻址、校验、事务编排）在 Client / DBHelper，机制在这里，
 *   两者分离便于各自独立演进与测试。
 *
 * 【写入的幂等性】
 *   一次属性写入会覆盖全部八个抽屉列（目标列赋值、其余置 NULL），
 *   因此不存在「属性类型变更后旧值残留」的问题，重复写入结果一致。
 *
 * 【v0.3.1：系统元数据落盘】
 *   每个对象除了业务属性，还会写入 4 个框架级元数据行：
 *     __name__       对象的 key（string）
 *     __version__    落盘时的类版本（string）
 *     __created_at__ 首次写入时间（datetime，仅首次）
 *     __updated_at__ 最近写入时间（datetime，每次）
 *   它们与业务属性同表共存（双下划线前缀区分），好处是可以直接被
 *   where / order 的 SQL 下推命中，「最近更新的文档」这类需求无需另开接口。
 *   读取时默认过滤掉，需要时用 { includeMeta: true } 取回。
 * ============================================================================
 */

const {
  TYPE_TO_COLUMN,
  ALL_DRAWER_COLUMNS,
  encodeValue,
  decodeValue,
  parseObjectName,
  isSystemAttribute,
} = require('./naming');
const { SYS_TABLE, SYS_ATTR, isSystemAttribute: isSys } = require('./constants');
const { ODDMValidationError } = require('./errors');

/** 兼容旧名称：抽屉列清单已收口到 naming.js，这里转出以保持不变的对外接口 */
const ALL_COLUMNS = ALL_DRAWER_COLUMNS;

/**
 * 系统元数据属性的声明类型
 *
 * 它们不在业务 schema 里（业务也不能占用这些名字），所以读取时要凭这张表
 * 才知道该从哪个抽屉列取值、该解码成什么 JS 类型。
 */
const SYSTEM_ATTR_TYPES = Object.freeze({
  [SYS_ATTR.NAME]: 'string',
  [SYS_ATTR.VERSION]: 'string',
  [SYS_ATTR.CREATED_AT]: 'datetime',
  [SYS_ATTR.UPDATED_AT]: 'datetime',
});

/**
 * 带 APL 日志与耗时统计的 SQL 执行包装
 * 失败时输出 ERROR 级日志，携带 ODL 路径与失败层级。
 */
function logged(ctx, op, sql, params, fn) {
  const apl = ctx && ctx.apl;
  const start = apl ? Date.now() : 0;
  try {
    const result = fn();
    if (apl) {
      apl.debug({
        path: ctx.path,
        layer: ctx.layer,
        op,
        sql,
        params,
        durationMs: Date.now() - start,
      });
    }
    return result;
  } catch (err) {
    if (apl) {
      apl.error({
        path: ctx.path,
        layer: ctx.layer,
        op,
        sql,
        params,
        durationMs: Date.now() - start,
        message: err.message,
      });
    }
    throw err;
  }
}

/**
 * 写入单个系统元数据属性
 *
 * 与业务属性分开走这条路径，是为了绕开 schema 校验：
 * 系统属性按定义就不在业务 schema 内，若走业务路径会被 strict 模式拒绝。
 */
function writeSystemAttr(db, table, objectName, attrName, rawValue, ctx = {}) {
  const type = SYSTEM_ATTR_TYPES[attrName];
  if (!type) {
    throw new ODDMValidationError(`未知的系统属性: ${attrName}`, { path: ctx.path });
  }

  const encoded = encodeValue(rawValue, type, { path: ctx.path, layer: attrName });
  const column = TYPE_TO_COLUMN[type];

  // 与业务属性一样：一次覆盖全部抽屉列，保证幂等、不留旧值
  const values = ALL_DRAWER_COLUMNS.map((col) => (col === column ? encoded : null));
  const sql = `
    INSERT INTO ${table} (object_name, attribute_name, ${ALL_DRAWER_COLUMNS.join(', ')})
    VALUES (?, ?, ${ALL_DRAWER_COLUMNS.map(() => '?').join(', ')})
    ON CONFLICT(object_name, attribute_name) DO UPDATE SET
      ${ALL_DRAWER_COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')};
  `;

  logged(ctx, 'write_system_attr', sql, [objectName, attrName, ...values], () =>
    db.prepare(sql).run(objectName, attrName, ...values)
  );
}

class Repository {
  /**
   * 写入对象（含拓扑索引与系统元数据）
   *
   * @param {object} args
   * @param {string} args.className
   * @param {string} args.objectName   物理标识 Class/key
   * @param {object} args.attributes   业务属性
   * @param {string} [args.parentName]
   * @param {string} [args.version]
   * @param {object} args.schema
   * @param {boolean} [args.strict]
   * @param {object} [args.ctx]        { apl, path, layer, table }
   * @param {boolean} [args.skipMeta=false] 仅写业务属性（供内部迁移等场景使用）
   * @param {string}  [args.createdAt] 强制写入的创建时间（ISO8601）。
   *        正常写入只在「对象首次入库」时落定创建时间；但版本迁移会把对象从
   *        旧表搬到新表，此时对象在索引里已存在（existedBefore=true），若不加
   *        这个开关，新表将缺失 __created_at__ 行、清理旧表后又会彻底丢失。
   *        迁移流程读取旧表的创建时间后通过本参数显式带过，保证时间不变。
   */
  static saveObject(db, args) {
    const {
      className,
      objectName,
      attributes,
      parentName = 'Root',
      version = '1.0',
      schema,
      strict = true,
      ctx = {},
      skipMeta = false,
      createdAt = null,
    } = args;

    const table = ctx.table;

    // 先判定是否为首次写入，决定要不要写 __created_at__
    const existedBefore = Boolean(
      db
        .prepare(`SELECT 1 FROM ${SYS_TABLE.ROOT_INDEX} WHERE object_name = ?`)
        .get(objectName)
    );

    // 拓扑索引：冲突时只更新 class/version，绝不覆写 parent_name。
    // 原实现在此处覆写 parent，导致对子节点用物理名 put 会把节点重挂回 Root。
    const indexSql = `
      INSERT INTO ${SYS_TABLE.ROOT_INDEX} (object_name, class_name, version, parent_name)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(object_name) DO UPDATE SET
        class_name = excluded.class_name,
        version    = excluded.version;
    `;
    logged(ctx, 'upsert_index', indexSql, [objectName, className, version, parentName], () =>
      db.prepare(indexSql).run(objectName, className, version, parentName)
    );

    const written = [];
    const skipped = [];

    const upsertSql = `
      INSERT INTO ${table} (object_name, attribute_name, ${ALL_DRAWER_COLUMNS.join(', ')})
      VALUES (?, ?, ${ALL_DRAWER_COLUMNS.map(() => '?').join(', ')})
      ON CONFLICT(object_name, attribute_name) DO UPDATE SET
        ${ALL_DRAWER_COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')};
    `;

    const stmt = db.prepare(upsertSql);

    for (const [attrName, rawValue] of Object.entries(attributes)) {
      // 系统属性由框架独占：业务侧传入时直接报错，避免与框架写入互相覆盖
      if (isSystemAttribute(attrName)) {
        throw new ODDMValidationError(
          `属性 "${attrName}" 是 ODDM 保留的系统属性，不能由业务写入`,
          { path: ctx.path, layer: className }
        );
      }

      const expectedType = schema[attrName];

      if (!expectedType) {
        if (strict) {
          throw new ODDMValidationError(
            `属性 "${attrName}" 未在 ${className} V${version} 的 schema 中定义`,
            { path: ctx.path, layer: className }
          );
        }
        skipped.push(attrName);
        continue;
      }

      const encoded = encodeValue(rawValue, expectedType, {
        path: ctx.path,
        layer: `${className}.${attrName}`,
      });

      const values = ALL_DRAWER_COLUMNS.map((col) =>
        col === TYPE_TO_COLUMN[expectedType] ? encoded : null
      );

      logged(
        ctx,
        'put_attribute',
        upsertSql,
        [objectName, attrName, ...values],
        () => stmt.run(objectName, attrName, ...values)
      );

      written.push(attrName);
    }

    // ---- 系统元数据 ----
    const now = new Date().toISOString();
    const metaWritten = [];

    if (!skipMeta) {
      let key = null;
      try {
        key = parseObjectName(objectName).key;
      } catch (err) {
        // Root 这类没有 / 的标识没有 key，元数据里就留空
        key = objectName;
      }

      writeSystemAttr(db, table, objectName, SYS_ATTR.NAME, key, ctx);
      writeSystemAttr(db, table, objectName, SYS_ATTR.VERSION, version, ctx);
      writeSystemAttr(db, table, objectName, SYS_ATTR.UPDATED_AT, now, ctx);
      metaWritten.push(SYS_ATTR.NAME, SYS_ATTR.VERSION, SYS_ATTR.UPDATED_AT);

      // created_at 只在首次写入时落定，之后永不改写；
      // 但若调用方显式传入 createdAt（版本迁移场景），则强制把这条时间带过，
      // 保证对象「搬家」到新表后创建时间不变。
      if (createdAt) {
        writeSystemAttr(db, table, objectName, SYS_ATTR.CREATED_AT, createdAt, ctx);
        metaWritten.push(SYS_ATTR.CREATED_AT);
      } else if (!existedBefore) {
        writeSystemAttr(db, table, objectName, SYS_ATTR.CREATED_AT, now, ctx);
        metaWritten.push(SYS_ATTR.CREATED_AT);
      }
    }

    return {
      objectName,
      className,
      version,
      table,
      written,
      skipped,
      metaWritten,
      created: !existedBefore,
    };
  }

  /**
   * 读取对象
   *
   * @param {object} args
   * @param {boolean} [args.includeMeta=false] 是否一并返回系统元数据
   * @param {boolean} [args.onlyMeta=false]    只返回系统元数据
   */
  static findObject(db, args) {
    const {
      objectName,
      schema,
      ctx = {},
      includeMeta = false,
      onlyMeta = false,
    } = args;
    const table = ctx.table;

    const sql = `
      SELECT attribute_name, ${ALL_DRAWER_COLUMNS.join(', ')}
      FROM ${table} WHERE object_name = ?;
    `;

    const rows = logged(ctx, 'get', sql, [objectName], () =>
      db.prepare(sql).all(objectName)
    );

    const result = {};
    const meta = {};

    for (const row of rows) {
      const attrName = row.attribute_name;

      if (isSys(attrName)) {
        if (!includeMeta && !onlyMeta) continue; // 默认对业务隐藏系统属性
        const type = SYSTEM_ATTR_TYPES[attrName];
        if (!type) continue; // 未知的系统属性，跳过而非崩溃
        meta[attrName] = decodeValue(row[TYPE_TO_COLUMN[type]], type);
        continue;
      }

      if (onlyMeta) continue;

      const type = schema[attrName];
      if (!type) continue; // schema 已变更的残留属性，跳过而非崩溃
      const raw = row[TYPE_TO_COLUMN[type]];
      result[attrName] = decodeValue(raw, type);
    }

    if (onlyMeta) return meta;
    return includeMeta ? { ...result, ...meta } : result;
  }

  /** 只读取系统元数据（供 meta() 等轻量调用，避免解码全部业务属性） */
  static findMeta(db, args) {
    return Repository.findObject(db, { ...args, onlyMeta: true });
  }

  static deleteObject(db, args) {
    const { objectName, table, ctx = {} } = args;

    const attrSql = `DELETE FROM ${table} WHERE object_name = ?;`;
    logged(ctx, 'delete_attributes', attrSql, [objectName], () =>
      db.prepare(attrSql).run(objectName)
    );

    const idxSql = `DELETE FROM ${SYS_TABLE.ROOT_INDEX} WHERE object_name = ?;`;
    logged(ctx, 'delete_index', idxSql, [objectName], () =>
      db.prepare(idxSql).run(objectName)
    );
    return true;
  }

  /**
   * 仅删除对象的 EAV 属性行，不动拓扑索引
   *
   * 与 deleteObject 的区别：deleteObject 会把对象从索引里彻底移除（相当于
   * 「销毁」），而本方法只清掉属性表里的行，索引条目保留。
   *
   * 典型用途是版本迁移：对象从旧表（User_V1_0）搬到新表（User_V2_0）后，
   * 旧表里会留下一批以同一 object_name 为键的孤儿行——它们不再被任何查询
   * 读到，但白占空间。调用本方法按 object_name 精准清理，且绝不误删索引，
   * 因此即便传入了错误的表名也只是少清一点，不会破坏拓扑结构。
   */
  static deleteAttributeRows(db, args) {
    const { objectName, table, ctx = {} } = args;
    const sql = `DELETE FROM ${table} WHERE object_name = ?;`;
    return logged(ctx, 'delete_attribute_rows', sql, [objectName], () =>
      db.prepare(sql).run(objectName)
    );
  }
}

module.exports = {
  Repository,
  logged,
  ALL_COLUMNS,
  ALL_DRAWER_COLUMNS,
  SYSTEM_ATTR_TYPES,
  writeSystemAttr,
  deleteAttributeRows: Repository.deleteAttributeRows,
};
