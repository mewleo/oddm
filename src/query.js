'use strict';

/**
 * 作者：双子-阿攀达 | query.js | v0.3.1
 *
 * ============================================================================
 * Query —— 链式查询 DSL（SQL 下推）
 *
 * 【与 Ruby 版最关键的一处差异：这里是 SQL 下推，不是内存过滤】
 *   Ruby 版的 Query 是「把所有对象读进内存，再用 Enumerable 逐条过滤排序」：
 *     all_objects = root.all(class_name)   ← 全表加载
 *     filtered = all_objects.select { ... } ← 内存过滤
 *   写法优雅，但数据量一大就不可接受：查 10 条数据要先把 10 万条读进内存。
 *
 *   Node 版改为全链路 SQL 下推，条件、排序、分页一次性交给 SQLite：
 *     SELECT object_name FROM Article_V1_0
 *     WHERE (attribute_name = ? AND v_int >= ?)      ← 条件下推
 *     GROUP BY object_name
 *     HAVING COUNT(DISTINCT attribute_name) = 1      ← EAV 的 AND 语义
 *     ORDER BY MAX(CASE WHEN attribute_name='age' THEN v_int END) DESC  ← 排序下推
 *     LIMIT ? OFFSET ?                               ← 分页下推
 *
 *   这是《版本对比 js与ruby》中定下的方向：Node 版保留并放大自己
 *   「where 是 SQL 下推」的既有优势，而不是照搬 Ruby 的内存实现。
 *
 * 【EAV 下 AND 语义为什么用 HAVING COUNT】
 *   属性是按行存的，一个对象的 age=18 和 role='admin' 是两行。
 *   要表达「同时满足」，不能写 WHERE age=18 AND role='admin'（单行不可能同时
 *   是两个属性）。标准解法是按对象分组，统计命中的不同属性个数是否等于条件数。
 *   注意必须用「实际生成的分支数」而非「传入的条件数」——后者在属性未注册时
 *   会永远匹配不上，静默返回空（这正是 v0.2.0 修掉的 P1-1 缺陷）。
 *
 * 【延迟执行】
 *   链式调用只累积条件，不访问数据库；直到调用 toArray/count/first 等
 *   终结方法才真正执行。这样条件可以动态追加，也便于合并后一次性下推。
 *
 * 【使用示例】
 *   db.User.where({ age: { $gte: 18 } }).order({ name: 'asc' }).limit(10).toArray()
 *   db.Article.where({ status: 'published' }).order('__updated_at__ desc').page(2, 20)
 *   db.Doc.where({ author: 'User/apanda' }).count()
 * ============================================================================
 */

const { TYPE_TO_COLUMN, coerceLiteral, supportsRangeOperator } = require('./naming');
const { SYSTEM_ATTR_TYPES } = require('./repository');
const { SYS_ATTR, OP_TO_SQL } = require('./constants');
const { ODDMQueryError, ODDMValidationError } = require('./errors');

/** 支持的比较操作符（用于校验操作符对象） */
const RANGE_OPS = new Set(['$gt', '$gte', '$lt', '$lte', '$ne']);

/**
 * 把正则尽量转成 SQL LIKE 模式
 *
 * 只处理最安全的三种形态（前缀 / 后缀 / 包含），其余一律返回 null
 * 交由内存兜底，绝不为了下推而歪曲语义。
 *
 * @returns {string|null} LIKE 模式；null 表示无法安全转换
 */
function regexpToLike(regexp) {
  if (!(regexp instanceof RegExp)) return null;

  let src = regexp.source;

  // 含正则元字符（量词、分组、选择、字符类等）时不转换，避免语义走样
  if (/[\\|()+[\]{}*?]/.test(src)) return null;

  let prefix = '%';
  let suffix = '%';

  if (src.startsWith('^')) {
    src = src.slice(1);
    prefix = '';
  }
  if (src.endsWith('$')) {
    src = src.slice(0, -1);
    suffix = '';
  }

  // 剩下若还有正则痕迹（如 . 通配）也不转换
  if (src.includes('.')) return null;

  // LIKE 里 % 和 _ 是通配符，字面量必须转义
  const escaped = src.replace(/[%_]/g, (m) => `\\${m}`);
  return `${prefix}${escaped}${suffix}`;
}

class Query {
  /**
   * @param {object} client   Client 实例
   * @param {string} className 起始类名（多态：查父类会带上全部子类）
   * @param {object} [options]
   * @param {string} [options.version] 类版本，默认最新版本
   */
  constructor(client, className, options = {}) {
    this.client = client;
    this.db = client.db;
    this.apl = client.apl;
    this.className = className;
    this.version = options.version || client._latestVersionOf(className);

    this._schema = client.meta.getSchema(className, this.version) || {};
    this._table = client.meta.resolveTable(className, this.version);

    /** @type {Array<{attr:string, expr:any}>} 待下推的条件 */
    this._conditions = [];
    /** @type {Array<{attr:string, dir:'asc'|'desc'}>} 排序规则 */
    this._orderRules = [];
    this._limitVal = null;
    this._offsetVal = null;

    /** 结果缓存；任何条件变更都要清空，否则会读到过期结果 */
    this._namesCache = null;
  }

  // -------------------------------------------------------------------------
  // 链式方法（只累积条件，不访问数据库）
  // -------------------------------------------------------------------------

  /**
   * 条件过滤（多次调用为 AND 关系）
   *
   * 支持的写法：
   *   { age: 18 }                    等值
   *   { age: { $gte: 18, $lte: 40 } } 区间
   *   { role: ['admin', 'editor'] }   IN
   *   { name: /^ap/ }                 前缀匹配（转 LIKE 下推）
   *   { deletedAt: null }             为空
   *
   * @param {object} conditions
   */
  where(conditions) {
    if (!conditions || typeof conditions !== 'object' || Array.isArray(conditions)) {
      throw new ODDMQueryError('where 需要一个条件对象', { layer: this.className });
    }
    for (const [attr, expr] of Object.entries(conditions)) {
      this._conditions.push({ attr, expr });
    }
    this._namesCache = null;
    return this;
  }

  /**
   * 排序
   *
   *   order('name')                  升序
   *   order('name desc')             降序
   *   order({ name: 'desc', age: 'asc' })
   *   order('name', { age: 'desc' }) 多参数
   */
  order(...args) {
    for (const arg of args) {
      if (arg === null || arg === undefined) continue;

      if (typeof arg === 'string') {
        const parts = arg.trim().split(/\s+/);
        const attr = parts[0];
        const dir = (parts[1] || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
        this._orderRules.push({ attr, dir });
      } else if (Array.isArray(arg)) {
        for (const item of arg) this.order(item);
      } else if (typeof arg === 'object') {
        for (const [attr, dir] of Object.entries(arg)) {
          this._orderRules.push({
            attr,
            dir: String(dir).toLowerCase() === 'desc' ? 'desc' : 'asc',
          });
        }
      }
    }
    this._namesCache = null;
    return this;
  }

  limit(count) {
    this._limitVal = Number.isInteger(count) && count >= 0 ? count : null;
    this._namesCache = null;
    return this;
  }

  offset(count) {
    this._offsetVal = Number.isInteger(count) && count >= 0 ? count : null;
    this._namesCache = null;
    return this;
  }

  /** 分页：page(2, 20) 等价于 offset(20).limit(20)，页码从 1 开始 */
  page(pageNum, perPage = 20) {
    const page = Math.max(1, Number(pageNum) || 1);
    const size = Math.max(1, Number(perPage) || 20);
    this._offsetVal = (page - 1) * size;
    this._limitVal = size;
    this._namesCache = null;
    return this;
  }

  // -------------------------------------------------------------------------
  // 终结方法（真正访问数据库）
  // -------------------------------------------------------------------------

  /** 只取物理标识，不加载对象（最省，适合只需要 ID 或后续自行处理的场景） */
  objectNames() {
    if (this._namesCache) return this._namesCache.slice();

    const { sql, params, memoryFilters } = this._buildSelect();
    const rows = this._run(sql, params);

    let names = rows.map((r) => r.object_name);

    // 无法下推的条件（复杂正则等）在这里兜底过滤
    if (memoryFilters.length > 0) {
      names = names.filter((name) => {
        const obj = this.client.get(name);
        if (!obj) return false;
        return memoryFilters.every((f) => f(obj));
      });
    }

    this._namesCache = names;
    return names.slice();
  }

  /** 加载为完整对象数组 */
  toArray() {
    return this.objectNames()
      .map((name) => this.client.get(name))
      .filter((obj) => obj !== null && obj !== undefined);
  }

  /** 总数（忽略 limit/offset，用于分页显示总页数） */
  count() {
    const { sql, params, memoryFilters } = this._buildSelect({ forCount: true });

    if (memoryFilters.length > 0) {
      // 有内存过滤时无法在 SQL 层精确计数，退化为取回后统计
      return this.objectNames().length;
    }

    const row = this.db.prepare(sql).get(...params);
    return row ? row.n : 0;
  }

  first() {
    const names = this.objectNames();
    return names.length > 0 ? this.client.get(names[0]) : null;
  }

  last() {
    const names = this.objectNames();
    return names.length > 0 ? this.client.get(names[names.length - 1]) : null;
  }

  /** 迭代支持：for (const user of db.User.where({...})) */
  [Symbol.iterator]() {
    return this.toArray()[Symbol.iterator]();
  }

  map(fn) {
    return this.toArray().map(fn);
  }

  filter(fn) {
    return this.toArray().filter(fn);
  }

  // -------------------------------------------------------------------------
  // 内部：SQL 构造
  // -------------------------------------------------------------------------

  /** 取属性类型：业务 schema 优先，其次系统元数据属性（便于按更新时间排序） */
  _typeOf(attrName) {
    if (this._schema && this._schema[attrName]) return this._schema[attrName];
    if (SYSTEM_ATTR_TYPES[attrName]) return SYSTEM_ATTR_TYPES[attrName];
    return null;
  }

  /**
   * 构造 SELECT 语句
   *
   * 条件分两类，处理方式不同：
   *   ① 聚合条件（等值/比较/IN/BETWEEN/LIKE）
   *      —— 写成 OR 分支，靠 HAVING COUNT(DISTINCT attribute_name) 表达 AND
   *   ② 对象级条件（$exists）
   *      —— 写成 object_name IN / NOT IN 子查询，不参与 HAVING 计数
   *      （因为「不存在某属性」无法用「某一行命中了」来表达）
   */
  _buildSelect(options = {}) {
    const forCount = options.forCount === true;
    const table = this._table;

    const branches = []; // 聚合条件的 OR 分支
    const branchParams = [];
    const objectFilters = []; // 对象级条件（$exists）
    const objectParams = [];
    const memoryFilters = []; // 无法下推、需内存兜底的过滤器

    for (const { attr, expr } of this._conditions) {
      const type = this._typeOf(attr);
      if (!type) {
        throw new ODDMQueryError(
          `条件属性 "${attr}" 未在 ${this.className} 的 schema 中定义（可选: ${Object.keys(this._schema).join(', ')}）`,
          { layer: `${this.className}.${attr}` }
        );
      }

      // ---- ① $exists 特殊处理：对象级过滤 ----
      if (expr && typeof expr === 'object' && !Array.isArray(expr) && '$exists' in expr) {
        const column = TYPE_TO_COLUMN[type];
        const want = expr.$exists !== false;
        objectFilters.push(
          `object_name ${want ? 'IN' : 'NOT IN'} (
             SELECT object_name FROM ${table}
             WHERE attribute_name = ? AND ${column} IS NOT NULL
           )`
        );
        objectParams.push(attr);
        continue;
      }

      // ---- ② 正则：尽量转 LIKE，否则内存兜底 ----
      //
      // 【顺序很关键】RegExp 的 typeof 是 'object'，必须排在操作符对象分支
      // 之前。否则会被当成操作符对象，而 Object.entries(/^a/) 是空数组，
      // 拼出 (attribute_name = ? AND ) 这种残缺 SQL。
      if (expr instanceof RegExp) {
        const like = regexpToLike(expr);
        if (like !== null && type === 'string') {
          branches.push(`(attribute_name = ? AND ${TYPE_TO_COLUMN[type]} LIKE ? ESCAPE '\\')`);
          branchParams.push(attr, like);
        } else {
          memoryFilters.push((obj) => expr.test(String(obj[attr] ?? '')));
        }
        continue;
      }

      // ---- ③ 操作符对象：{ $gte: 18, $lte: 40 } ----
      if (expr && typeof expr === 'object' && !Array.isArray(expr) && !this._isPlainValue(expr)) {
        const built = this._buildOperatorBranch(attr, expr, type);
        if (built.memoryFilter) {
          memoryFilters.push(built.memoryFilter);
        } else {
          branches.push(built.sql);
          branchParams.push(...built.params);
        }
        continue;
      }

      // ---- ④ 数组：IN 语义（对齐 Ruby 版与主流 ORM） ----
      //      注意：legacy 的 helper.where() 里两元素数组是 BETWEEN（历史约定），
      //      新 DSL 统一为 IN；需要区间请显式写 { $between: [a, b] }
      if (Array.isArray(expr)) {
        if (expr.length === 0) {
          // 空数组 = 不可能命中任何值
          branches.push('(1 = 0)');
          continue;
        }
        const placeholders = expr.map(() => '?').join(', ');
        branches.push(
          `(attribute_name = ? AND ${TYPE_TO_COLUMN[type]} IN (${placeholders}))`
        );
        branchParams.push(
          attr,
          ...expr.map((v) => coerceLiteral(v, type, { layer: `${this.className}.${attr}` }))
        );
        continue;
      }

      // ---- ⑤ null：该属性的值为 NULL ----
      if (expr === null || expr === undefined) {
        branches.push(`(attribute_name = ? AND ${TYPE_TO_COLUMN[type]} IS NULL)`);
        branchParams.push(attr);
        continue;
      }

      // ---- ⑥ 普通值：等值 ----
      branches.push(`(attribute_name = ? AND ${TYPE_TO_COLUMN[type]} = ?)`);
      branchParams.push(attr, coerceLiteral(expr, type, { layer: `${this.className}.${attr}` }));
    }

    // ---- 继承作用域：对象可能混放在父类表里，需按真实类名收窄 ----
    const classFilter = this._buildClassScopeFilter();
    const scopeConditions = [];
    const scopeParams = [];
    if (classFilter) {
      scopeConditions.push(classFilter.sql);
      scopeParams.push(...classFilter.params);
    }

    // ---- 组装 WHERE ----
    const whereParts = [...scopeConditions, ...objectFilters];
    if (branches.length > 0) whereParts.push(`(${branches.join(' OR ')})`);

    const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

    // objectFilters 的占位符要排在 branches 之前（与 whereParts 的拼接顺序一致）
    const allParams = [...scopeParams, ...objectParams, ...branchParams];

    // ---- 排序（计数查询不需要） ----
    //
    // 【参数顺序必须与 SQL 中出现顺序一致】
    //   SQL 里 ORDER BY 在 LIMIT 之前，因此参数也得是「排序参数在前、
    //   LIMIT/OFFSET 参数在后」。早期版本用 unshift 累积，多个排序规则时
    //   会把顺序弄反（第二个规则的参数跑到第一个前面），这里改为顺序 push。
    const orderParams = [];
    let orderClause = '';
    if (!forCount && this._orderRules.length > 0) {
      const terms = [];
      for (const rule of this._orderRules) {
        const type = this._typeOf(rule.attr);
        if (!type) {
          throw new ODDMQueryError(
            `排序属性 "${rule.attr}" 未在 ${this.className} 的 schema 中定义`,
            { layer: `${this.className}.${rule.attr}` }
          );
        }
        const column = TYPE_TO_COLUMN[type];
        // 把 EAV 的行转成列：同一对象该属性的值聚成单个可排序的值
        const pivot = `MAX(CASE WHEN attribute_name = ? THEN ${column} END)`;

        // NULL 恒定排最后（与 Ruby 版 compare_by_rules 的约定一致）：
        // 先按「是否为空」升序排（非空在前），再按真实值排
        terms.push(`(CASE WHEN ${pivot} IS NULL THEN 1 ELSE 0 END) ASC`);
        terms.push(`${pivot} ${rule.dir === 'desc' ? 'DESC' : 'ASC'}`);
        // 每个规则要用两次属性名参数（一次判空、一次取值）
        orderParams.push(rule.attr, rule.attr);
      }
      orderClause = `ORDER BY ${terms.join(', ')}`;
    }

    // ---- 分页参数（计数查询不需要） ----
    const limitParams = [];
    let limitClause = '';
    if (!forCount) {
      if (this._limitVal !== null) {
        limitClause += ' LIMIT ?';
        limitParams.push(this._limitVal);
      }
      if (this._offsetVal !== null) {
        // SQLite 不允许只写 OFFSET 而不写 LIMIT，用 LIMIT -1 表示不限行数
        limitClause += this._limitVal !== null ? ' OFFSET ?' : ' LIMIT -1 OFFSET ?';
        limitParams.push(this._offsetVal);
      }
    }

    const tailParams = [...orderParams, ...limitParams];

    // ---- 组装 ----
    //
    // 是否 GROUP BY 取决于两点：
    //   ① 有聚合条件 —— 需要 HAVING COUNT 表达 AND 语义
    //   ② 需要排序   —— 排序用了 MAX() 聚合，没有 GROUP BY 就是
    //                   "misuse of aggregate"，SQLite 会直接报错
    const needsGroupBy = branches.length > 0 || this._orderRules.length > 0;

    let sql;
    let params;

    if (!needsGroupBy) {
      // 无聚合、无排序：直接去重即可，最省
      const base = `SELECT DISTINCT object_name FROM ${table} ${whereClause} ${orderClause}${limitClause}`;
      if (forCount) {
        sql = `SELECT COUNT(*) AS n FROM (${base})`;
        params = [...allParams];
      } else {
        sql = base;
        params = [...allParams, ...tailParams];
      }
    } else {
      const havingClause =
        branches.length > 0 ? 'HAVING COUNT(DISTINCT attribute_name) = ?' : '';
      const inner = `
        SELECT object_name FROM ${table}
        ${whereClause}
        GROUP BY object_name
        ${havingClause}
        ${orderClause}
        ${limitClause}
      `;
      if (forCount) {
        sql = `SELECT COUNT(*) AS n FROM (${inner})`;
        params = branches.length > 0 ? [...allParams, branches.length] : [...allParams];
      } else {
        sql = inner;
        params =
          branches.length > 0
            ? [...allParams, branches.length, ...tailParams]
            : [...allParams, ...tailParams];
      }
    }

    return { sql, params, memoryFilters };
  }

  /**
   * 操作符对象 -> SQL 分支
   *
   * 支持：$gt $gte $lt $lte $ne $in $nin $between $like
   * 若操作符组合无法安全下推，则返回 memoryFilter 走内存兜底。
   */
  _buildOperatorBranch(attr, expr, type) {
    const column = TYPE_TO_COLUMN[type];
    const parts = [];
    const params = [];
    const memoryChecks = [];

    for (const [op, value] of Object.entries(expr)) {
      // ---- 区间 ----
      if (op === '$between') {
        if (!Array.isArray(value) || value.length !== 2) {
          throw new ODDMQueryError(`$between 需要长度为 2 的数组: ${attr}`, {
            layer: `${this.className}.${attr}`,
          });
        }
        this._assertRangeable(type, attr, '区间');
        parts.push(`${column} BETWEEN ? AND ?`);
        params.push(
          coerceLiteral(value[0], type, { layer: `${this.className}.${attr}` }),
          coerceLiteral(value[1], type, { layer: `${this.className}.${attr}` })
        );
        continue;
      }

      // ---- 比较运算 ----
      if (RANGE_OPS.has(op)) {
        this._assertRangeable(type, attr, '比较');
        parts.push(`${column} ${OP_TO_SQL[op]} ?`);
        params.push(coerceLiteral(value, type, { layer: `${this.className}.${attr}` }));
        continue;
      }

      // ---- IN / NOT IN ----
      if (op === '$in' || op === '$nin') {
        const list = Array.isArray(value) ? value : [value];
        if (list.length === 0) {
          parts.push(op === '$in' ? '1 = 0' : '1 = 1');
          continue;
        }
        const placeholders = list.map(() => '?').join(', ');
        parts.push(`${column} ${op === '$in' ? 'IN' : 'NOT IN'} (${placeholders})`);
        params.push(...list.map((v) => coerceLiteral(v, type, { layer: `${this.className}.${attr}` })));
        continue;
      }

      // ---- LIKE ----
      if (op === '$like') {
        parts.push(`${column} LIKE ?`);
        params.push(String(value));
        continue;
      }

      throw new ODDMQueryError(
        `不支持的查询操作符: ${op}（支持: $gt $gte $lt $lte $ne $in $nin $between $like $exists）`,
        { layer: `${this.className}.${attr}` }
      );
    }

    // 同一属性上的多个操作符是 AND 关系，整体作为一个分支
    if (memoryChecks.length > 0) {
      return {
        sql: null,
        params: [],
        memoryFilter: (obj) => memoryChecks.every((fn) => fn(obj)),
      };
    }

    return {
      sql: `(attribute_name = ? AND ${parts.join(' AND ')})`,
      params: [attr, ...params],
      memoryFilter: null,
    };
  }

  /** 判断是否为「当作普通值处理」的对象（如 Date） */
  _isPlainValue(expr) {
    return expr instanceof Date;
  }

  _assertRangeable(type, attr, label) {
    if (!supportsRangeOperator(type)) {
      throw new ODDMQueryError(`${type} 类型不支持${label}查询: ${attr}`, {
        layer: `${this.className}.${attr}`,
      });
    }
  }

  /**
   * 继承作用域过滤
   *
   * 当查询的类存在子类（或自身是子类）时，对象会混放在同一张物理表里，
   * 必须按 oddm_root_index.class_name 收窄，否则查 Article 会把
   * TechArticle 的对象也算进来（或者反过来漏掉）。
   *
   * 纯独立的类（自有表、无子类）不需要这层过滤，省掉一次子查询。
   */
  _buildClassScopeFilter() {
    const scope = this.client.meta.polymorphicClassNames(this.className, this.version);
    const def = this.client.meta.getClassDef(this.className, this.version);
    const isSharedTable = Boolean(def && def.parentClass) || scope.length > 1;

    if (!isSharedTable) return null;

    const names = scope.map((s) => s.className);
    const placeholders = names.map(() => '?').join(', ');
    return {
      sql: `object_name IN (
              SELECT object_name FROM oddm_root_index WHERE class_name IN (${placeholders})
            )`,
      params: names,
    };
  }

  /** 执行 SQL 并写入 APL 日志 */
  _run(sql, params) {
    const start = Date.now();
    try {
      const rows = this.db.prepare(sql).all(...params);
      this.apl.debug({
        path: `Root.${this.className}[*]`,
        layer: this.className,
        op: 'query',
        sql,
        params,
        durationMs: Date.now() - start,
      });
      return rows;
    } catch (err) {
      this.apl.error({
        path: `Root.${this.className}[*]`,
        layer: this.className,
        op: 'query',
        sql,
        params,
        message: err.message,
      });
      throw err;
    }
  }

  inspect() {
    const conds = this._conditions
      .map((c) => `${c.attr}=${JSON.stringify(c.expr)}`)
      .join(', ');
    return `#<Query ${this.className} where(${conds})${
      this._limitVal !== null ? ` limit=${this._limitVal}` : ''
    }>`;
  }
}

module.exports = { Query, regexpToLike, RANGE_OPS, SYS_ATTR };
