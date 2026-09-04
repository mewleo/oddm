'use strict';

/**
 * 作者：双子-阿攀达 | classscope.js | v0.3.1
 *
 * ============================================================================
 * ClassScope —— 类作用域薄代理
 *
 * 【设计意图】
 *   对齐 Ruby 版的 ClassScope：把「类名」绑定成一个可复用的操作入口，
 *   从而写出更贴近 ODL 路径风格的链式代码：
 *
 *     db.User.find('apanda')
 *     db.User.where({ age: { $gte: 18 } }).order('name').limit(10).toArray()
 *     db.Article.children('a1', 'Comment')
 *
 *   而不是每次都把类名当字符串传来传去：
 *
 *     client.get("Root.User['apanda']")
 *     helper.where('User', { age: 18 })
 *
 * 【为什么是「薄」代理】
 *   本类不含任何业务逻辑，只做三件事：
 *     ① 记住类名与版本；
 *     ② 把 key 拼成 ODL 路径或物理标识；
 *     ③ 转发给 Client / Query。
 *   所有真正的读写仍由 Client 与 Query 承担，避免逻辑分散到多处。
 *
 * 【与 Ruby 版的差异】
 *   Ruby 版靠 Root#method_missing 动态生成 ClassScope；Node 版在 Client 上
 *   挂了一层 Proxy 达成同样效果（db.User 自动得到 ClassScope），
 *   同时保留显式的 client.scope('User') 作为不依赖 Proxy 的稳妥入口。
 * ============================================================================
 */

const { objectNameFor, assertValidClassName } = require('./naming');
const { Query } = require('./query');
const { SYS_TABLE } = require('./constants');

class ClassScope {
  /**
   * @param {object} client
   * @param {string} className
   * @param {object} [options]
   * @param {string} [options.version] 固定版本；省略则每次取该类的最新版本
   */
  constructor(client, className, options = {}) {
    assertValidClassName(className);
    this.client = client;
    this.db = client.db;
    this.apl = client.apl;
    this.className = className;
    this.version = options.version || null;
  }

  /** 解析出实际使用的版本（未固定则取最新） */
  get resolvedVersion() {
    return this.version || this.client._latestVersionOf(this.className);
  }

  /** 物理表名（继承时会指向父类表） */
  get table() {
    return this.client.meta.resolveTable(this.className, this.resolvedVersion);
  }

  /** 该类的属性定义 */
  get schema() {
    return this.client.meta.getSchema(this.className, this.resolvedVersion) || {};
  }

  // -------------------------------------------------------------------------
  // 基础 CRUD
  // -------------------------------------------------------------------------

  /** 按 key 取单个对象，不存在返回 null（Ruby 版 find 会抛异常，这里更宽松） */
  find(key) {
    return this.client.get(this.objectName(key));
  }

  /**
   * 按 key 取单个对象，不存在则抛错
   * （对应 Ruby 版 find 的语义，适合「确定应该存在」的场景）
   */
  findOrFail(key) {
    const obj = this.find(key);
    if (obj === null || obj === undefined) {
      const { ODDMNotFoundError } = require('./errors');
      throw new ODDMNotFoundError(`对象不存在: ${this.objectName(key)}`, {
        path: this.path(key),
        layer: this.className,
      });
    }
    return obj;
  }

  /** key -> 物理标识，如 apanda -> User/apanda */
  objectName(key) {
    return objectNameFor(this.className, key);
  }

  /** key -> ODL 路径，如 apanda -> Root.User['apanda'] */
  path(key) {
    return `Root.${this.className}['${key}']`;
  }

  /**
   * 创建对象（挂到 Root 下）
   *
   * @param {string} key
   * @param {object} attributes
   */
  create(key, attributes) {
    return this.client.put(this.path(key), attributes, {
      version: this.resolvedVersion,
    });
  }

  /** create 的别名，贴合 put 的既有习惯 */
  put(key, attributes, options = {}) {
    return this.client.put(this.path(key), attributes, {
      version: this.resolvedVersion,
      ...options,
    });
  }

  /** 差量更新：只写真正变化的字段 */
  update(key, attributes, options = {}) {
    return this.client.dbHelper.updateDiff(this.objectName(key), attributes, options);
  }

  /** 仅刷新更新时间，不动业务属性 */
  touch(key) {
    return this.client.put(this.objectName(key), {}, { touchOnly: true });
  }

  /** 删除单个对象 */
  destroy(key, options = {}) {
    return this.client.dbHelper.destroy(this.objectName(key), options);
  }

  /**
   * 创建从属对象（对齐 Ruby ClassScope 的层级写法）
   *
   * 等价于 db.createChild(this.className, parentKey, childClass, childKey, attrs)，
   * 这里因 ClassScope 已绑定当前类，只需再给子类的类名与 key：
   *
   *   db.User.createChild('apanda', 'Post', 'first', { title: '...' })
   *     -> Root.User['apanda'].Post['first']
   *
   * @param {string} parentKey 当前类某个实例的 key（即父节点）
   * @param {string} childClass 子类名
   * @param {string} childKey 子类实例的 key
   * @param {object} attributes
   * @param {object} [options] 透传给 put
   */
  createChild(parentKey, childClass, childKey, attributes, options = {}) {
    return this.client.createChild(
      this.className,
      parentKey,
      childClass,
      childKey,
      attributes,
      options
    );
  }

  /**
   * 查找从属对象（对齐 Ruby ClassScope 的层级写法）
   *
   *   db.User.findChild('apanda', 'Post', 'first')  -> Post/first（前提是它的父节点正是 User/apanda）
   *
   * 不存在或父节点不匹配时返回 null。
   * @returns {object|null}
   */
  findChild(parentKey, childClass, childKey) {
    return this.client.findChild(this.className, parentKey, childClass, childKey);
  }

  exists(key) {
    return this.client.exists(this.objectName(key));
  }

  /** 取对象的框架级元数据（创建/更新时间等） */
  meta(key) {
    return this.client.meta$(this.objectName(key));
  }

  // -------------------------------------------------------------------------
  // 集合与查询
  // -------------------------------------------------------------------------

  /**
   * 该类的全部对象（多态：查父类会连同子类对象一起返回）
   * @param {object} [options]
   * @param {boolean} [options.namesOnly=false] 只返回物理标识，不加载对象
   */
  all(options = {}) {
    const names = this.objectNames();
    if (options.namesOnly) return names;
    return names.map((n) => this.client.get(n)).filter((o) => o !== null && o !== undefined);
  }

  /**
   * 该类全部对象的物理标识
   *
   * 走拓扑索引而不是属性表：继承场景下对象混放在父类表里，直接扫属性表
   * 会把兄弟子类的对象也算进来，而索引的 class_name 才是真实类型。
   */
  objectNames() {
    const scope = this.client.meta.polymorphicClassNames(this.className, this.resolvedVersion);
    const names = scope.map((s) => s.className);
    const placeholders = names.map(() => '?').join(', ');

    const rows = this.db
      .prepare(
        `SELECT object_name FROM ${SYS_TABLE.ROOT_INDEX}
         WHERE class_name IN (${placeholders}) ORDER BY object_name`
      )
      .all(...names);

    return rows.map((r) => r.object_name);
  }

  /** 进入查询链 */
  where(conditions = {}) {
    return new Query(this.client, this.className, { version: this.resolvedVersion }).where(
      conditions
    );
  }

  /** 直接进入排序链（无条件场景） */
  order(...args) {
    return new Query(this.client, this.className, { version: this.resolvedVersion }).order(...args);
  }

  limit(count) {
    return new Query(this.client, this.className, { version: this.resolvedVersion }).limit(count);
  }

  page(pageNum, perPage) {
    return new Query(this.client, this.className, { version: this.resolvedVersion }).page(
      pageNum,
      perPage
    );
  }

  count() {
    return this.objectNames().length;
  }

  // -------------------------------------------------------------------------
  // 从属对象（树拓扑）
  // -------------------------------------------------------------------------

  /** 某对象下的指定类型子节点 */
  children(key, childClass = null) {
    const rows = this.client.dbHelper.children(this.objectName(key));
    if (!childClass) return rows;
    return rows.filter((r) => r.class_name === childClass);
  }

  ancestors(key) {
    return this.client.dbHelper.ancestors(this.objectName(key));
  }

  descendants(key) {
    return this.client.dbHelper.descendants(this.objectName(key));
  }

  /** 反解完整 ODL 路径 */
  canonicalPath(key) {
    return this.client.dbHelper.canonicalPath(this.objectName(key));
  }

  // -------------------------------------------------------------------------
  // 视图
  // -------------------------------------------------------------------------

  /** 查询视图（返回原始行） */
  query(viewName) {
    return this.client.views.query(viewName);
  }

  /** 查询视图并实例化为对象 */
  queryObjects(viewName) {
    return this.client.views.queryObjects(viewName, this.className);
  }

  // -------------------------------------------------------------------------
  // 事务
  // -------------------------------------------------------------------------

  transaction(fn) {
    return this.client.dbHelper.transaction(fn);
  }

  /** 支持 db.User['apanda'] 的下标写法（对齐 Ruby 版 ClassScope#[]） */
  get(key) {
    return this.find(key);
  }

  inspect() {
    return `#<ClassScope ${this.className} v${this.resolvedVersion}>`;
  }

  toString() {
    return this.inspect();
  }
}

module.exports = { ClassScope };
