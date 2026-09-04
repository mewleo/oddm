'use strict';

/**
 * 作者：双子-阿攀达 | views.js | v0.3.1
 *
 * ============================================================================
 * 视图管理（ViewManager）
 *
 * 【视图在 ODDM 里的地位】
 *   ODDM 主张「禁 JOIN，用路径寻址」。但有些查询用路径表达很啰嗦
 *   （比如「所有已发布且阅读过千的文章」），这时允许开发者用一段 SQL
 *   定义一个命名视图，之后就能像访问一个具名集合那样反复使用它：
 *
 *     db.views.create('hotArticles', {
 *       className: 'Article',
 *       sql: "SELECT object_name FROM Article_V1_0 WHERE attribute_name='views' AND v_int > 1000"
 *     });
 *     db.views.queryObjects('hotArticles');
 *
 *   视图信息登记在 oddm_root_views 路由表里（对齐 Ruby 版的 oddm_root 表），
 *   因此数据库里既有真的 SQL VIEW，也有可被自省接口读出的元数据。
 *
 * 【三种创建方式】
 *   ① 原始 SQL：   create(name, { className, sql })       —— 最灵活
 *   ② where DSL：  create(name, { className, where: {...} }) —— 无需手写 SQL
 *   ③ 集合视图：   registerCollection(...)                —— 父对象下的子对象集合
 *
 * 【为什么视图 SQL 里必须内联字面量】
 *   SQLite 的 CREATE VIEW 不支持参数绑定（? 占位符），所以 DSL 生成的 SQL
 *   只能把值内联进去。这是 SQL 注入的高风险点，因此所有内联值一律经过
 *   sqlLiteral() 转义（单引号翻倍、数值强转、布尔转 0/1），
 *   并对传入的原始 SQL 做白名单校验（必须是单条 SELECT，不得含分号）。
 * ============================================================================
 */

const { TYPE_TO_COLUMN, supportsRangeOperator, IDENTIFIER_RE } = require('./naming');
const { SYS_ATTR, SYS_TABLE } = require('./constants');
const { ODDMValidationError, ODDMNotFoundError, ODDMQueryError } = require('./errors');

/**
 * 把 JS 值安全地内联进 SQL
 *
 * 视图无法用参数绑定，只能内联，所以这里是整个视图模块的注入防线：
 *   - 数值：强转 Number，非法值直接报错（杜绝 '1; DROP TABLE' 这类串入）
 *   - 布尔：转 1 / 0
 *   - 其余：当字符串处理，单引号翻倍转义
 */
function sqlLiteral(value, type) {
  if (value === null || value === undefined) return 'NULL';

  switch (type) {
    case 'int':
    case 'float': {
      const num = Number(value);
      if (!Number.isFinite(num)) {
        throw new ODDMValidationError(`视图条件需要数值，收到: ${JSON.stringify(value)}`);
      }
      return String(num);
    }
    case 'boolean':
      return value ? '1' : '0';
    default:
      // 字符串/日期/JSON：单引号翻倍是 SQL 标准转义方式
      return `'${String(value).replace(/'/g, "''")}'`;
  }
}

/** 校验视图名，只允许合法标识符（会拼进 DDL，必须白名单） */
function assertValidViewName(name) {
  if (typeof name !== 'string' || !IDENTIFIER_RE.test(name)) {
    throw new ODDMValidationError(
      `非法的视图名: ${JSON.stringify(name)}（只允许字母/数字/下划线，且不以数字开头）`
    );
  }
  return name;
}

/**
 * 把任意字符串收敛成合法的视图名（白名单字符之外的全部替换为下划线）
 *
 * 集合视图常需要把「父对象 + 子类」编码进名字（如 User_apanda_Posts），
 * 而父对象的 key 可能含连字符、点号等；这里统一归一，既满足 DDL 白名单，
 * 又保证同一对 (父, 子) 得到确定且唯一的视图名。
 */
function sanitizeViewName(name) {
  return String(name).replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * 校验外部传入的原始视图 SQL
 *
 * 只允许单条 SELECT：视图本质是只读查询，且不得夹带分号拼接第二条语句。
 */
function assertSafeViewSql(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new ODDMValidationError('视图 SQL 不能为空');
  }
  const normalized = sql.trim().replace(/\s+/g, ' ');

  if (!/^select\b/i.test(normalized)) {
    throw new ODDMValidationError('视图 SQL 必须是 SELECT 语句');
  }
  if (normalized.includes(';')) {
    throw new ODDMValidationError('视图 SQL 不得包含分号（防止拼接多条语句）');
  }
  return normalized;
}

class ViewManager {
  constructor(client) {
    this.client = client;
    this.db = client.db;
    this.apl = client.apl;
  }

  /** 视图在数据库中的实际名字（统一加 v_ 前缀，避免与业务表混淆） */
  static viewNameOf(name) {
    return `v_${name}`;
  }

  // -------------------------------------------------------------------------
  // 创建视图
  // -------------------------------------------------------------------------

  /**
   * 创建视图
   *
   * @param {string} name 视图路由名
   * @param {object} options
   * @param {string} [options.className] 关联类名
   * @param {string} [options.sql]   原始 SELECT（必须选出 object_name 列）
   * @param {object} [options.where] where 条件（与 sql 二选一）
   * @param {string} [options.viewType='custom'] 路由类型
   * @param {boolean} [options.replace=true] 同名视图存在时是否重建
   */
  create(name, options = {}) {
    assertValidViewName(name);

    const className = options.className || null;
    const viewType = options.viewType || 'custom';
    const replace = options.replace !== false;

    let sql;
    if (options.sql) {
      sql = assertSafeViewSql(options.sql);
    } else if (options.where) {
      if (!className) {
        throw new ODDMValidationError(`用 where 创建视图时必须指定 className: ${name}`);
      }
      sql = this._buildWhereSql(className, options.where, options.version);
    } else {
      throw new ODDMValidationError(`创建视图需要提供 sql 或 where 之一: ${name}`);
    }

    const viewName = ViewManager.viewNameOf(name);

    if (replace) {
      this.db.exec(`DROP VIEW IF EXISTS ${viewName};`);
    }
    this.db.exec(`CREATE VIEW ${viewName} AS ${sql};`);

    // 登记路由，使自省接口与 Helper 能列出它
    this.client.meta.registerView(name, viewName, viewType, className, options.version || null);

    this.apl.info({
      path: `Root.${name}`,
      op: 'create_view',
      message: `视图 ${name} -> ${viewName}`,
      sql,
    });

    return { name, viewName, viewType, className, sql };
  }

  /**
   * 由 where 条件生成视图 SQL（需内联字面量）
   *
   * 只支持等值 / 比较 / IN 这几种能安全内联的条件；复杂需求请用原始 sql。
   */
  _buildWhereSql(className, conditions, version = null) {
    const resolvedVersion = version || this.client._latestVersionOf(className);
    const schema = this.client.meta.getSchema(className, resolvedVersion);
    if (!schema) {
      throw new ODDMNotFoundError(`未注册的类型: ${className} V${resolvedVersion}`);
    }
    const table = this.client.meta.resolveTable(className, resolvedVersion);

    const branches = [];
    for (const [attr, expr] of Object.entries(conditions)) {
      const type = schema[attr];
      if (!type) {
        throw new ODDMQueryError(
          `视图条件属性 "${attr}" 未在 ${className} 的 schema 中定义`,
          { layer: `${className}.${attr}` }
        );
      }
      const column = TYPE_TO_COLUMN[type];

      if (Array.isArray(expr)) {
        // 数组 = IN
        const list = expr.map((v) => sqlLiteral(v, type)).join(', ');
        branches.push(`(attribute_name = '${attr}' AND ${column} IN (${list}))`);
      } else if (expr && typeof expr === 'object' && !(expr instanceof Date)) {
        // 操作符对象，目前支持 $gt/$gte/$lt/$lte/$ne/$in
        const parts = [];
        for (const [op, value] of Object.entries(expr)) {
          const sqlOp = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=', $ne: '!=' }[op];
          if (sqlOp) {
            if (!supportsRangeOperator(type)) {
              throw new ODDMQueryError(`${type} 类型不支持比较运算: ${attr}`, {
                layer: `${className}.${attr}`,
              });
            }
            parts.push(`${column} ${sqlOp} ${sqlLiteral(value, type)}`);
          } else if (op === '$in') {
            const list = (Array.isArray(value) ? value : [value])
              .map((v) => sqlLiteral(v, type))
              .join(', ');
            parts.push(`${column} IN (${list})`);
          } else {
            throw new ODDMQueryError(`视图条件不支持的操作符: ${op}`, {
              layer: `${className}.${attr}`,
            });
          }
        }
        branches.push(`(attribute_name = '${attr}' AND ${parts.join(' AND ')})`);
      } else {
        branches.push(
          `(attribute_name = '${attr}' AND ${column} = ${sqlLiteral(expr, type)})`
        );
      }
    }

    if (branches.length === 0) {
      throw new ODDMValidationError('视图的 where 条件不能为空');
    }

    // 与查询 DSL 同源的 AND 语义：分组后按命中的属性个数判定
    return `
      SELECT object_name FROM ${table}
      WHERE ${branches.join(' OR ')}
      GROUP BY object_name
      HAVING COUNT(DISTINCT attribute_name) = ${branches.length}
    `.replace(/\s+/g, ' ').trim();
  }

  // -------------------------------------------------------------------------
  // 删除与查询
  // -------------------------------------------------------------------------

  /** 删除视图（同时注销路由） */
  drop(name) {
    const route = this.client.meta.findView(name);
    const viewName = route ? route.viewName : ViewManager.viewNameOf(name);

    this.db.exec(`DROP VIEW IF EXISTS ${viewName};`);
    this.client.meta.unregisterView(name);

    this.apl.info({ path: `Root.${name}`, op: 'drop_view', message: `删除视图 ${name}` });
    return true;
  }

  /** 查询视图，返回原始行 */
  query(name) {
    const route = this.client.meta.findView(name);
    if (!route) {
      throw new ODDMNotFoundError(`视图未注册: ${name}`);
    }
    return this.db.prepare(`SELECT * FROM ${route.viewName}`).all();
  }

  /**
   * 查询视图并实例化为对象
   *
   * 视图只需选出 object_name 一列，其余由 Client 按类定义装配。
   */
  queryObjects(name, className = null) {
    const route = this.client.meta.findView(name);
    if (!route) {
      throw new ODDMNotFoundError(`视图未注册: ${name}`);
    }
    const cls = className || route.className;
    if (!cls) {
      throw new ODDMValidationError(
        `视图 ${name} 未关联类，queryObjects 需要显式传入 className`
      );
    }

    const rows = this.db.prepare(`SELECT * FROM ${route.viewName}`).all();
    return rows
      .map((row) => (row.object_name ? this.client.get(row.object_name) : null))
      .filter((obj) => obj !== null && obj !== undefined);
  }

  /** 列出视图路由，可按类型筛选 */
  list(viewType = null) {
    return this.client.meta.listViews(viewType);
  }

  /** 查看单条视图路由 */
  find(name) {
    return this.client.meta.findView(name);
  }

  /**
   * 登记一条「父对象下的子对象集合」视图，并真正建出可查询的 SQL 视图。
   *
   * 与 Ruby 版一致：集合视图表达「某父对象下的全部某类子对象」，例如
   * User/apanda 下的所有 Post。Node 版把它落成一个真实的 SQL 视图：
   *
   *   CREATE VIEW v_User_apanda_Posts AS
   *     SELECT object_name FROM oddm_root_index
   *     WHERE parent_name = 'User/apanda' AND class_name = 'Post';
   *
   * 于是 db.views.queryObjects('User_apanda_Posts') 能直接取回这些子对象，
   * 而不必每次手写 children 遍历。视图名经 sanitizeViewName 归一，确保
   * 拼进 DDL 时永远是合法标识符；父对象名作为字符串字面量内联，已做单引号转义。
   *
   * @param {string} name 视图路由名（会被 sanitize 成合法标识符）
   * @param {string} className 子对象类名
   * @param {string} parentName 父对象的物理标识（如 User/apanda）
   */
  registerCollection(name, className, parentName) {
    const safeName = sanitizeViewName(name);
    assertValidViewName(safeName);
    const viewName = ViewManager.viewNameOf(safeName);

    // 父对象名拼进字面量：单引号翻倍转义（防注入），其余交给白名单视图名兜底
    const safeParent = String(parentName).replace(/'/g, "''");
    const sql = `SELECT object_name FROM ${SYS_TABLE.ROOT_INDEX} WHERE parent_name = '${safeParent}' AND class_name = '${className}'`;

    this.db.exec(`DROP VIEW IF EXISTS ${viewName};`);
    this.db.exec(`CREATE VIEW ${viewName} AS ${sql};`);

    this.client.meta.registerView(safeName, viewName, 'collection', className, null);
    this.apl.info({
      path: `Root.${safeName}`,
      op: 'create_collection_view',
      message: `集合视图 ${safeName} -> ${viewName}`,
    });
    return { name: safeName, viewName, viewType: 'collection', className, parentName };
  }

  /**
   * 按日期创建「某天新建的对象」视图
   * 依赖 __created_at__ 元数据，这是把元数据存成 EAV 属性带来的直接好处。
   */
  createDailyView(name, className, date) {
    const version = this.client._latestVersionOf(className);
    const table = this.client.meta.resolveTable(className, version);
    const sql = `
      SELECT object_name FROM ${table}
      WHERE attribute_name = '${SYS_ATTR.CREATED_AT}'
        AND v_datetime LIKE '${String(date).replace(/'/g, "''")}%'
    `;
    return this.create(name, { className, sql });
  }

  /** 按版本创建「某版本的对象」视图 */
  createVersionView(name, className, version) {
    const resolvedVersion = this.client._latestVersionOf(className);
    const table = this.client.meta.resolveTable(className, resolvedVersion);
    const sql = `
      SELECT object_name FROM ${table}
      WHERE attribute_name = '${SYS_ATTR.VERSION}'
        AND v_string = '${String(version).replace(/'/g, "''")}'
    `;
    return this.create(name, { className, sql });
  }
}

module.exports = { ViewManager, sqlLiteral, assertSafeViewSql, assertValidViewName };
