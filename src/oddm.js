'use strict';

/**
 * 作者：双子-阿攀达 | oddm.js | v0.3.1
 *
 * ============================================================================
 * ODDM —— 面向对象数据库模型（Node.js 版）统一出口
 *
 * 【一句话说明】
 *   架在 SQLite 之上的面向对象持久化引擎：用 ODL 路径（Root.User['apanda']）
 *   取代外键与 JOIN，用 EAV 行存储实现属性动态增删，并内置 APL 日志与
 *   自省接口，让 AI 与人类都能在不读建表脚本的前提下理解并操作数据库。
 *
 * 【模块一览】
 *   client      Client（总入口，对齐 Ruby 版 Root）与 DBHelper（读写辅助）
 *   classscope  ClassScope（db.User 类作用域）
 *   query       Query（链式查询 DSL，SQL 下推）
 *   lazyref     LazyRef / CollectionProxy（引用懒加载）
 *   views       ViewManager（视图管理）
 *   helper      Helper（管理辅助，对齐 Ruby 版 Helper）
 *   schema      Schema / MetaClassManager（物理表与元类型，含继承）
 *   repository  Repository（物理读写层）
 *   path        PathParser / TreeNavigator（ODL 路径与树导航）
 *   naming      命名与类型编解码
 *   apl         APL 寻址路径日志
 *   errors      8 类带错误码的异常
 *   constants   全局常量与文件头标准
 *
 * 【三分钟上手】
 *   const { Client } = require('oddm');
 *   const db = new Client('app.db');
 *   db.defineClass('User', { name: 'string', age: 'int' });
 *   db.put("Root.User['apanda']", { name: 'apanda', age: 41 });
 *   db.User.where({ age: { $gte: 18 } }).order('name').limit(10).toArray();
 *   db.introspect();   // 全库自省快照，AI 可直接据此操作
 * ============================================================================
 */

const { Client, DBHelper, DEFAULT_MAX_DEPTH, stableStringify } = require('./client');
const { ClassScope } = require('./classscope');
const { Query, regexpToLike } = require('./query');
const { LazyRef, CollectionProxy } = require('./lazyref');
const { ViewManager, sqlLiteral } = require('./views');
const { Helper } = require('./helper');
const { PathParser, TreeNavigator } = require('./path');
const { Schema, MetaClassManager } = require('./schema');
const { Repository, ALL_DRAWER_COLUMNS, SYSTEM_ATTR_TYPES } = require('./repository');
const { APL, LEVELS } = require('./apl');
const errors = require('./errors');
const constants = require('./constants');
const naming = require('./naming');

module.exports = {
  // ---- 核心入口 ----
  Client,
  DBHelper,
  ClassScope,
  Query,

  // ---- 引用与视图 ----
  LazyRef,
  CollectionProxy,
  ViewManager,
  Helper,

  // ---- 底层模块（供扩展与测试使用）----
  PathParser,
  TreeNavigator,
  Schema,
  MetaClassManager,
  Repository,
  APL,
  LEVELS,
  DEFAULT_MAX_DEPTH,
  stableStringify,
  regexpToLike,
  sqlLiteral,
  ALL_DRAWER_COLUMNS,
  SYSTEM_ATTR_TYPES,

  // ---- 常量与工具 ----
  ...constants,
  ...naming,
  ...errors,
};
