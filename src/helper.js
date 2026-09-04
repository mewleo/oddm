'use strict';

/**
 * 作者：双子-阿攀达 | helper.js | v0.3.1
 *
 * ============================================================================
 * Helper —— 数据库管理助手（对齐 Ruby 版 ODDM::Helper）
 *
 * 【与 DBHelper 的分工（易混淆，务必分清）】
 *   DBHelper（client.dbHelper）  读写辅助：where / children / moveTo / destroy
 *                                / updateDiff / transaction —— 日常业务读写走它
 *   Helper  （client.helper）     管理辅助：视图、路由、特殊具名对象、类信息、
 *                                原始 SQL、统计概览 —— 运维与调试走它
 *
 *   两者的关系类似 Ruby 版里 Root（总 DAO）与 Helper（管理助手）的互补：
 *   日常操作用前者，特殊管理与排查用后者。
 *
 * 【六大功能模块】
 *   1. 特殊具名对象管理：给一段 SQL 起个名字，之后当作具名集合访问
 *   2. 视图管理：原始 SQL 建视图 / 删除视图 / 列出视图
 *   3. Root 映射（路由）管理：查看与维护 oddm_root_views 里的登记项
 *   4. 类管理：列出类、查看类详情与版本
 *   5. 数据库信息：执行原始 SQL、查看统计
 *   6. 便捷方法：按日期/版本建视图、打印概览
 * ============================================================================
 */

const { SYS_ATTR, VIEW_TYPE } = require('./constants');

class Helper {
  /**
   * @param {object} client Client 实例
   */
  constructor(client) {
    this.client = client;
    this.db = client.db;
    this.apl = client.apl;
  }

  // ==========================================================================
  // 1. 特殊具名对象管理
  // ==========================================================================

  /**
   * 注册一个特殊具名对象
   *
   * 什么叫「特殊具名对象」：不是通过 defineClass 注册的标准类，而是开发者
   * 手工定义的一段具名查询，例如：
   *   - 今日新增用户（newUsersToday）
   *   - 某版本的全部对象（userV1）
   *   - 自定义统计集合（activeAdmins）
   *
   * 注册后即可用 db.views.queryObjects(name) 反复使用。
   *
   * @param {string} name 特殊对象名（即 Root 路由名）
   * @param {object} options
   * @param {string} options.className 关联类名
   * @param {string} options.sql 视图 SQL（SELECT，需选出 object_name）
   */
  registerSpecialObject(name, options = {}) {
    return this.client.views.create(name, {
      className: options.className,
      sql: options.sql,
      viewType: VIEW_TYPE.CUSTOM,
    });
  }

  /**
   * 注销特殊具名对象
   * @param {string} name
   * @param {boolean} [dropView=true] 是否同时 DROP 掉数据库视图
   */
  unregisterSpecialObject(name, dropView = true) {
    if (dropView) return this.client.views.drop(name);
    this.client.meta.unregisterView(name);
    return true;
  }

  /** 列出全部特殊具名对象（viewType = custom） */
  specialObjects() {
    return this.client.meta.listViews(VIEW_TYPE.CUSTOM);
  }

  // ==========================================================================
  // 2. 视图管理
  // ==========================================================================

  /**
   * 用原始 SQL 创建视图
   *
   * 与 views.create 的 where-DSL 形式互补：这里接受完整 SQL，最灵活。
   * @param {string} viewName
   * @param {string} sql
   * @param {string} [className] 关联类名（用于 queryObjects 时确定装配方式）
   */
  createView(viewName, sql, className = null) {
    return this.client.views.create(viewName, {
      className,
      sql,
      viewType: VIEW_TYPE.CUSTOM,
    });
  }

  /** 删除视图 */
  dropView(viewName) {
    return this.client.views.drop(viewName);
  }

  /** 列出全部自定义视图 */
  views() {
    return this.client.meta.listViews(VIEW_TYPE.CUSTOM);
  }

  // ==========================================================================
  // 3. Root 映射（路由）管理
  // ==========================================================================

  /** 列出路由，可按类型筛选（class/collection/object/custom） */
  routes(viewType = null) {
    return this.client.meta.listViews(viewType);
  }

  /** 查看单条路由 */
  route(name) {
    return this.client.meta.findView(name);
  }

  /** 登记一条路由（底层操作，一般不直接调用） */
  registerRoute(name, viewName, viewType, className = null) {
    return this.client.meta.registerView(name, viewName, viewType, className, null);
  }

  /** 注销路由 */
  unregisterRoute(name) {
    return this.client.meta.unregisterView(name);
  }

  // ==========================================================================
  // 4. 类管理
  // ==========================================================================

  /** 列出全部已注册的类名 */
  classes() {
    return this.client.meta.listClasses().map((c) => c.className);
  }

  /** 查看类的详细信息（含父类与继承链） */
  classInfo(className, version = null) {
    const resolvedVersion = version || this.client._latestVersionOf(className);
    const schema = this.client.meta.getSchema(className, resolvedVersion);
    if (!schema) return null;

    const def = this.client.meta.getClassDef(className, resolvedVersion);
    return {
      className,
      version: resolvedVersion,
      table: this.client.meta.resolveTable(className, resolvedVersion),
      schema,
      attributes: Object.keys(schema),
      parentClass: def ? def.parentClass : null,
      ancestorChain: this.client.meta.ancestorChain(className, resolvedVersion),
      instanceCount: this.client.meta.countInstances(className, resolvedVersion),
    };
  }

  /** 列出某个类的全部已注册版本 */
  classVersions(className) {
    return this.client.meta.listVersions(className);
  }

  // ==========================================================================
  // 5. 数据库信息
  // ==========================================================================

  /**
   * 执行原始 SQL（DDL/DML）
   *
   * 用于建索引、改表等框架未封装的操作。
   * 注意：这是逃生舱，绕过 ODDM 的一切校验与 APL 记录，请谨慎使用。
   */
  execute(sql, params = []) {
    return this.db.prepare(sql).run(...params);
  }

  /** 查询原始 SQL，返回行数组 */
  query(sql, params = []) {
    return this.db.prepare(sql).all(...params);
  }

  /** 当前 SQLite 中的全部表与视图名 */
  tables() {
    return this.db
      .prepare(`SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all();
  }

  /** 统计信息汇总 */
  stats() {
    const classes = this.client.meta.listClasses();
    const routes = this.client.meta.listViews();

    return {
      version: this.client.version,
      strict: this.client.strict,
      maxDepth: this.client.maxDepth,
      classesCount: classes.length,
      routesCount: routes.length,
      customViewsCount: this.specialObjects().length,
      objectsCount: this.client._stats().totalObjects,
      classes: classes.map((c) => c.className),
    };
  }

  // ==========================================================================
  // 6. 便捷方法
  // ==========================================================================

  /**
   * 创建每日新增对象视图
   * 依赖 __created_at__ 元数据属性——这正是把元数据存成 EAV 属性的收益：
   * 「某天新建的对象」可以直接用一条 SQL 表达，无需另建时间索引表。
   *
   * @param {string} name 视图名
   * @param {string} className
   * @param {string} date YYYY-MM-DD
   */
  createDailyView(name, className, date) {
    return this.client.views.createDailyView(name, className, date);
  }

  /** 创建版本视图（筛选特定版本的对象） */
  createVersionView(name, className, version) {
    return this.client.views.createVersionView(name, className, version);
  }

  /**
   * 打印数据库状态概览（调试用）
   * @returns {string} 多行文本
   */
  overview() {
    const lines = [];
    lines.push('=== ODDM 数据库状态概览 ===');
    lines.push(`版本: ${this.client.version} | 严格模式: ${this.client.strict} | 深度上限: ${this.client.maxDepth}`);
    lines.push('');

    const classes = this.client.meta.listClasses();
    lines.push(`--- 注册的类 (${classes.length}) ---`);
    for (const cls of classes) {
      const def = this.client.meta.getClassDef(cls.className, cls.version);
      const inherited = def && def.parentClass ? ` (继承自 ${def.parentClass})` : '';
      const attrs = Object.keys(cls.schema)
        .map((a) => `${a}:${cls.schema[a]}`)
        .join(', ');
      lines.push(`  ${cls.className} v${cls.version}${inherited}`);
      lines.push(`    表: ${cls.table}`);
      lines.push(`    属性: ${attrs}`);
      lines.push(`    实例数: ${this.client.meta.countInstances(cls.className, cls.version)}`);
    }

    lines.push('');
    const routes = this.client.meta.listViews();
    lines.push(`--- 视图路由 (${routes.length}) ---`);
    for (const r of routes) {
      lines.push(
        `  ${r.name} -> ${r.viewName} [${r.viewType}]${r.className ? ` (${r.className})` : ''}`
      );
    }

    lines.push('');
    const stat = this.client._stats();
    lines.push(`对象总数: ${stat.totalObjects} | 最大深度: ${stat.maxDepth}`);
    lines.push('============================');

    return lines.join('\n');
  }

  /** 直接打印概览到控制台（调试时最省事） */
  printOverview() {
    const text = this.overview();
    console.log(text);
    return text;
  }

  // ==========================================================================
  // 7. 集合视图便捷方法
  // ==========================================================================

  /**
   * 为「父对象下的子对象集合」登记一条 collection 视图路由
   *
   * 对齐 Ruby 版 Helper#create_collection_view。createChild 已经会自动登记，
   * 但如果需要手工创建或重建某条集合路由（例如旧库升级、或想为非 createChild
   * 方式建立的父子关系补一条具名视图），可用本方法。
   *
   * 登记后可用 db.views.queryObjects("#{parentClass}:#{parentName}:#{childClass}s")
   * 取出该父节点下的全部该类子对象。
   *
   * @param {string} parentClass
   * @param {string} parentName 父对象的 key（不是物理标识）
   * @param {string} childClass
   */
  createCollectionView(parentClass, parentName, childClass) {
    const collectionName = `${parentClass}_${parentName}_${childClass}s`;
    const parentObjectName = `${parentClass}/${parentName}`;
    return this.client.views.registerCollection(collectionName, childClass, parentObjectName);
  }
}

module.exports = { Helper, SYS_ATTR, VIEW_TYPE };
