'use strict';

/**
 * 作者：双子-阿攀达 | constants.js | v0.3.1
 *
 * ============================================================================
 * 全局常量
 *
 * 【为什么单独抽一个常量文件】
 *   v0.2.0 时常量散落在 naming.js / schema.js / client.js 里，导致：
 *   ① 系统属性名（如 __created_at__）在写入侧和读取侧各写一遍字符串字面量，
 *      一旦拼错不会报错，只会静默查不到——这是最难排查的一类 bug；
 *   ② 版本号在 oddm.js、package.json、CHANGELOG 三处各维护一份，必然漂移。
 *   现在统一收口到这里，任何模块要用常量都必须从此处引入。
 *
 * 【文件头标准】
 *   对齐 Ruby 版 `# 作者：双子-阿攀达 | xxx.rb | v0.3.1` 的约定。
 *   每个源文件首行都要写 `作者：双子-阿攀达 | <文件名> | v0.3.1`，
 *   便于在多人协作/AI 辅助时一眼看出文件的作者与所属版本。
 * ============================================================================
 */

/** 作者署名，用于文件头标注 */
const AUTHOR = '双子-阿攀达';

/** ODDM Node.js 版当前版本号，与 package.json 保持一致 */
const VERSION = '0.3.1';

/** 生成统一的文件头注释文本，供各模块首行引用 */
const FILE_HEADER = (fileName, version = VERSION) =>
  `作者：${AUTHOR} | ${fileName} | v${version}`;

// ---------------------------------------------------------------------------
// 系统表名
//
// 全库共 5 张系统表 + 每个（类, 版本）一张 EAV 属性表：
//   oddm_root_index    拓扑索引：对象 -> (类, 版本, 父节点)。树的形状完全由
//                      parent_name 一列维系；class_name 一列则用于继承多态时
//                      判别对象的真实类型（v0.3.1 新增用途）。
//   ODDM_Meta_Classes  属性级元类型定义（类 -> 版本 -> 属性 -> 类型）
//   ODDM_Class_Defs    类级定义（类 -> 版本 -> 父类/物理表名），v0.3.1 新增，
//                      用于支持继承多态
//   oddm_root_views    视图路由表，v0.3.1 新增，对齐 Ruby 版的 oddm_root
//   （EAV 属性表）      <Class>_V<Major>_<Minor>
// ---------------------------------------------------------------------------
const SYS_TABLE = Object.freeze({
  ROOT_INDEX: 'oddm_root_index',
  META_CLASSES: 'ODDM_Meta_Classes',
  CLASS_DEFS: 'ODDM_Class_Defs',
  ROOT_VIEWS: 'oddm_root_views',
});

/**
 * 系统元数据属性名（双下划线前缀）
 *
 * 【为什么用双下划线】
 *   ODDM 的对象名不污染业务属性，但对象仍需要少量框架级元数据。
 *   双下划线前缀是 Ruby 版定下的约定，业务属性几乎不会这样命名，
 *   因此可以在 EAV 表里安全地与业务属性共存。
 *
 * 【v0.3.1 存哪些、不存哪些】
 *   存：__name__ / __version__ / __created_at__ / __updated_at__
 *   —— 这四项会被写进对象的 EAV 属性行，于是「最近更新的文档」
 *      这类需求可以直接走 where/order 的 SQL 下推，无需另开接口。
 *
 *   不存：__class__ 和 __parent__
 *   —— 这是 Node 版与 Ruby 版的一处有意差异。Ruby 版把 __class__ 存成
 *      EAV 属性来判别继承后的真实类型；但 Node 版的 oddm_root_index
 *      本身就有 class_name 和 parent_name 两列，再存一份就是双份真相，
 *      存在不一致风险。因此 Node 版一律以索引表为唯一真相来源。
 */
const SYS_ATTR = Object.freeze({
  /** 对象的 key（物理标识中 / 之后的部分），如 User/apanda 的 apanda */
  NAME: '__name__',
  /** 对象落盘时使用的类版本号，如 1.0 */
  VERSION: '__version__',
  /** 首次写入时间，ISO8601 字符串 */
  CREATED_AT: '__created_at__',
  /** 最近一次写入时间，ISO8601 字符串；touch() 只更新它 */
  UPDATED_AT: '__updated_at__',
});

/** 全部系统元数据属性名的集合，供快速判定 */
const SYS_ATTR_SET = new Set(Object.values(SYS_ATTR));

/** 判断一个属性名是否为系统元数据属性 */
function isSystemAttribute(attrName) {
  return SYS_ATTR_SET.has(attrName);
}

// ---------------------------------------------------------------------------
// 视图路由类型（对齐 Ruby 版 oddm_root.view_type）
// ---------------------------------------------------------------------------
const VIEW_TYPE = Object.freeze({
  /** 类视图：指向某个类的全部对象 */
  CLASS: 'class',
  /** 集合视图：某个父对象下的某类子对象 */
  COLLECTION: 'collection',
  /** 对象视图：单个具名对象 */
  OBJECT: 'object',
  /** 自定义视图：开发者用原始 SQL 或 where-DSL 手工创建 */
  CUSTOM: 'custom',
});

// ---------------------------------------------------------------------------
// 查询操作符
//
// 查询 DSL 支持两种写法：
//   ① 操作符对象：{ age: { $gte: 18, $lte: 40 } }   （推荐，JS 惯用）
//   ② 简写：     { age: 18 } / { age: [18, 40] } / { name: /^ap/ }
// ---------------------------------------------------------------------------
const QUERY_OP = Object.freeze({
  GT: '$gt',
  GTE: '$gte',
  LT: '$lt',
  LTE: '$lte',
  NE: '$ne',
  IN: '$in',
  NIN: '$nin',
  LIKE: '$like',
  BETWEEN: '$between',
  EXISTS: '$exists',
});

/** 查询操作符 -> SQL 比较符 */
const OP_TO_SQL = Object.freeze({
  $gt: '>',
  $gte: '>=',
  $lt: '<',
  $lte: '<=',
  $ne: '!=',
});

module.exports = {
  AUTHOR,
  VERSION,
  FILE_HEADER,
  SYS_TABLE,
  SYS_ATTR,
  SYS_ATTR_SET,
  isSystemAttribute,
  VIEW_TYPE,
  QUERY_OP,
  OP_TO_SQL,
};
