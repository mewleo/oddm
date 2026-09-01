'use strict';

const {
  TYPE_TO_COLUMN,
  encodeValue,
  decodeValue,
  objectNameFor,
} = require('./naming');
const { ODDMValidationError } = require('./errors');

const ALL_COLUMNS = ['v_string', 'v_int', 'v_float', 'v_boolean', 'v_datetime', 'v_json'];

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
 * 物理读写层
 *
 * 一次属性写入会覆盖全部六个类型列（目标列赋值、其余置 NULL），
 * 因此不存在「属性类型变更后旧值残留」的问题，且写入是幂等的。
 */
class Repository {
  /**
   * @param {object} args
   * @param {string} args.className
   * @param {string} args.objectName
   * @param {object} args.attributes
   * @param {string} [args.parentName]
   * @param {string} [args.version]
   * @param {object} args.schema
   * @param {boolean} [args.strict]
   * @param {object} [args.ctx]
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
    } = args;

    const table = ctx.table;

    // 拓扑索引：冲突时只更新 class/version，绝不覆写 parent_name。
    // 原实现在此处覆写 parent，导致对子节点用物理名 put 会把节点重挂回 Root。
    const indexSql = `
      INSERT INTO oddm_root_index (object_name, class_name, version, parent_name)
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
      INSERT INTO ${table} (object_name, attribute_name, ${ALL_COLUMNS.join(', ')})
      VALUES (?, ?, ${ALL_COLUMNS.map(() => '?').join(', ')})
      ON CONFLICT(object_name, attribute_name) DO UPDATE SET
        ${ALL_COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')};
    `;

    const stmt = db.prepare(upsertSql);

    for (const [attrName, rawValue] of Object.entries(attributes)) {
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

      const values = ALL_COLUMNS.map((col) =>
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

    return { objectName, className, version, table, written, skipped };
  }

  static findObject(db, args) {
    const { objectName, className, version, schema, ctx = {} } = args;
    const table = ctx.table;

    const sql = `
      SELECT attribute_name, ${ALL_COLUMNS.join(', ')}
      FROM ${table} WHERE object_name = ?;
    `;

    const rows = logged(ctx, 'get', sql, [objectName], () =>
      db.prepare(sql).all(objectName)
    );

    const result = {};
    for (const row of rows) {
      const type = schema[row.attribute_name];
      if (!type) continue; // schema 已变更的残留属性，跳过而非崩溃
      const raw = row[TYPE_TO_COLUMN[type]];
      result[row.attribute_name] = decodeValue(raw, type);
    }
    return result;
  }

  static deleteObject(db, args) {
    const { objectName, table, ctx = {} } = args;

    const attrSql = `DELETE FROM ${table} WHERE object_name = ?;`;
    logged(ctx, 'delete_attributes', attrSql, [objectName], () =>
      db.prepare(attrSql).run(objectName)
    );

    const idxSql = `DELETE FROM oddm_root_index WHERE object_name = ?;`;
    logged(ctx, 'delete_index', idxSql, [objectName], () =>
      db.prepare(idxSql).run(objectName)
    );
    return true;
  }
}

module.exports = { Repository, logged, ALL_COLUMNS, objectNameFor };
