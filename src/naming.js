'use strict';

/**
 * 作者：双子-阿攀达 | naming.js | v0.3.1
 *
 * ============================================================================
 * 命名与类型工具
 *
 * 集中承担四件事：
 * 1. 标识符白名单校验 —— 表名由字符串插值拼进 SQL，必须在此拦截注入。
 * 2. 物理标识（object_name）与表名的双向构造。
 * 3. 存储层类型编解码（string/int/float/boolean/datetime/json + ref/refs）。
 * 4. where / 查询 DSL 条件字面量的显式转型。
 *
 * 【v0.3.1 变更：新增 ref / refs 引用类型】
 *   为了让 ODDM 能表达「文档 -> 作者」「文档 -> 多个标签」这类引用关系，
 *   新增两种类型，并对应两个新的 EAV 抽屉列：
 *     ref  -> v_ref  （存单个物理标识，如 User/apanda）
 *     refs -> v_refs （存物理标识数组的 JSON 文本）
 *   之所以要开专用列而不是复用 v_string / v_json，是为了让引用关系能被
 *   SQL 下推反查（「找出张三写的所有文档」），否则只能把整表读进内存解析
 *   JSON，数据量一大就不可接受。
 *
 * 【引用值的落库形态】
 *   Node 版的对象标识是「类名/key」（如 User/apanda），与 Ruby 版的
 *   root:user:apanda 命名空间形态不同，但语义等价。引用一律存这个物理标识，
 *   读取时再由 Client 包装成 LazyRef / CollectionProxy 供懒加载访问。
 * ============================================================================
 */

const {
  ODDMValidationError,
  ODDMTypeError,
  ODDMPathError,
} = require('./errors');
const { isSystemAttribute } = require('./constants');

/** 类名 / 属性名白名单：字母或下划线开头，仅含字母数字下划线 */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 版本号：点分数字，如 1.0 / 2.1.3 */
const VERSION_RE = /^\d+(?:\.\d+)+$/;

/** ODL 路径段：.ClassName['key'] / .ClassName["key"] / .ClassName[123] */
const PATH_SEGMENT_RE = /\.([A-Za-z0-9_]+)\[(?:'([^']*)'|"([^"]*)"|(\d+))\]/g;

/**
 * 全部支持的数据类型
 *
 * 前 6 种是 v0.2.0 就有的标量/结构化类型；
 * ref / refs 是 v0.3.1 为支持对象引用而新增的。
 */
const DATA_TYPES = [
  'string',
  'int',
  'float',
  'boolean',
  'datetime',
  'json',
  'ref', // 单引用：指向另一个对象
  'refs', // 引用集合：指向多个对象
];

/**
 * 数据类型 -> EAV 抽屉列名
 *
 * EAV（Entity-Attribute-Value）行存储：一个对象的每个属性占一行，
 * 每种类型各占一个抽屉列，只有目标列有值、其余为 NULL。
 * 这样读写时一次覆盖全部抽屉列，天然幂等，且不存在「属性改类型后旧值残留」。
 */
const TYPE_TO_COLUMN = Object.freeze({
  string: 'v_string',
  int: 'v_int',
  float: 'v_float',
  boolean: 'v_boolean',
  datetime: 'v_datetime',
  json: 'v_json',
  ref: 'v_ref',
  refs: 'v_refs',
});

/**
 * 全部抽屉列（顺序即建表顺序）
 *
 * 以前这个清单写在 repository.js 里，与 naming.js 的 TYPE_TO_COLUMN 是两份
 * 真相：新增类型时若只改一处，写入会静默落到错误的列。现在从这里导出，
 * 建表、写入、读取共用同一份。
 */
const ALL_DRAWER_COLUMNS = Object.freeze(Object.values(TYPE_TO_COLUMN));

function assertValidClassName(name) {
  if (typeof name !== 'string' || !IDENTIFIER_RE.test(name)) {
    throw new ODDMValidationError(
      `非法的类名: ${JSON.stringify(name)}（只允许字母/数字/下划线，且不以数字开头）`
    );
  }
  return name;
}

function assertValidVersion(version) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new ODDMValidationError(
      `非法的版本号: ${JSON.stringify(version)}（只接受点分数字，如 1.0）`
    );
  }
  return version;
}

function assertValidAttributeName(name) {
  if (typeof name !== 'string' || !IDENTIFIER_RE.test(name)) {
    throw new ODDMValidationError(
      `非法的属性名: ${JSON.stringify(name)}（只允许字母/数字/下划线，且不以数字开头）`
    );
  }
  return name;
}

function assertValidDataType(type) {
  if (!DATA_TYPES.includes(type)) {
    throw new ODDMValidationError(
      `未知的数据类型: ${JSON.stringify(type)}（可选: ${DATA_TYPES.join(', ')}）`
    );
  }
  return type;
}

/** 类名 + 版本 -> 物理表名，如 User / 1.0 -> User_V1_0 */
function tableNameFor(className, version) {
  assertValidClassName(className);
  assertValidVersion(version);
  return `${className}_V${version.replace(/\./g, '_')}`;
}

/** 类名 + key -> 物理标识，如 User / apanda -> User/apanda */
function objectNameFor(className, key) {
  return `${className}/${key}`;
}

/** 物理标识 -> { className, key } */
function parseObjectName(objectName) {
  const idx = objectName.indexOf('/');
  if (idx <= 0) {
    throw new ODDMPathError(`无法解析物理标识: ${objectName}`, { path: objectName });
  }
  return {
    className: objectName.slice(0, idx),
    key: objectName.slice(idx + 1),
  };
}

function isPath(input) {
  return typeof input === 'string' && input.trim().startsWith('Root');
}

function isObjectName(input) {
  return typeof input === 'string' && !isPath(input) && input.includes('/');
}

// ---------------------------------------------------------------------------
// 引用值处理
// ---------------------------------------------------------------------------

/**
 * 从引用值中抽出物理标识（object_name）
 *
 * 接受的形态：
 *   - 字符串            "User/apanda"（最常用）
 *   - LazyRef 实例      duck-typing 取 .__objectName
 *   - 带 __objectName 的普通对象
 *   - "Root"            允许指向根节点
 *
 * 【为什么用 duck-typing 而不是 instanceof】
 *   lazyref.js 需要引用 naming.js 做校验，若 naming.js 反过来 require
 *   lazyref.js 就形成循环依赖。用鸭子类型判断可以彻底避开循环 require。
 */
function extractRefTarget(value, context = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value.__objectName) return value.__objectName;
  throw new ODDMTypeError(
    `ref 类型需要一个对象标识（如 "User/apanda"）或引用对象，收到: ${JSON.stringify(value)}`,
    context
  );
}

/** 校验并规范化一个物理标识：必须是 "Root" 或 "Class/key" 形态 */
function normalizeRefTarget(value, context = {}) {
  const target = extractRefTarget(value, context);
  if (target === null || target === undefined) return null;
  if (target === 'Root') return target;

  const idx = target.indexOf('/');
  if (idx <= 0 || idx === target.length - 1) {
    throw new ODDMTypeError(
      `非法的引用目标: ${JSON.stringify(target)}（应为 "类名/key" 形态，如 User/apanda）`,
      context
    );
  }
  return target;
}

// ---------------------------------------------------------------------------
// 存储层编解码
// ---------------------------------------------------------------------------

/** 值 -> 落库值（严格模式下类型不符直接报错，不做静默截断） */
function encodeValue(value, type, context = {}) {
  if (value === null || value === undefined) return null;

  switch (type) {
    case 'string':
      if (typeof value === 'object') {
        throw new ODDMTypeError(`string 类型不接受对象值: ${JSON.stringify(value)}`, context);
      }
      return String(value);

    case 'int': {
      const num = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(num)) {
        throw new ODDMTypeError(`无法转为 int: ${JSON.stringify(value)}`, context);
      }
      if (!Number.isInteger(num)) {
        throw new ODDMTypeError(`int 类型不接受小数: ${JSON.stringify(value)}`, context);
      }
      if (num > Number.MAX_SAFE_INTEGER || num < Number.MIN_SAFE_INTEGER) {
        throw new ODDMTypeError(`int 超出安全整数范围: ${JSON.stringify(value)}`, context);
      }
      return num;
    }

    case 'float': {
      const num = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(num)) {
        throw new ODDMTypeError(`无法转为 float: ${JSON.stringify(value)}`, context);
      }
      return num;
    }

    case 'boolean':
      return value ? 1 : 0;

    case 'datetime':
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
          throw new ODDMTypeError('datetime 收到无效 Date 对象', context);
        }
        return value.toISOString();
      }
      if (typeof value === 'string') {
        if (Number.isNaN(Date.parse(value))) {
          throw new ODDMTypeError(`datetime 无法解析: ${JSON.stringify(value)}`, context);
        }
        return new Date(value).toISOString();
      }
      if (typeof value === 'number') {
        return new Date(value).toISOString();
      }
      throw new ODDMTypeError(`datetime 不接受该类型: ${typeof value}`, context);

    case 'json':
      if (typeof value === 'string') {
        // 允许传入已是 JSON 文本的值，做一次合法性校验
        try {
          JSON.parse(value);
          return value;
        } catch (err) {
          throw new ODDMTypeError(`json 字段不是合法 JSON 文本: ${value}`, {
            ...context,
            cause: err,
          });
        }
      }
      try {
        return JSON.stringify(value);
      } catch (err) {
        throw new ODDMTypeError(`json 无法序列化: ${String(value)}`, {
          ...context,
          cause: err,
        });
      }

    // ---- v0.3.1 新增：引用类型 ----

    case 'ref':
      // 单引用：直接存物理标识字符串，便于 SQL 直接按引用反查
      return normalizeRefTarget(value, context);

    case 'refs': {
      // 引用集合：存物理标识数组的 JSON 文本
      // 接受真正的数组，也接受 CollectionProxy（暴露 __objectNames）
      let list;
      if (Array.isArray(value)) {
        list = value;
      } else if (value && typeof value === 'object' && Array.isArray(value.__objectNames)) {
        list = value.__objectNames;
      } else {
        throw new ODDMTypeError(
          `refs 类型需要一个标识数组或引用集合，收到: ${JSON.stringify(value)}`,
          context
        );
      }
      const normalized = list.map((item) => normalizeRefTarget(item, context));
      return JSON.stringify(normalized);
    }

    default:
      throw new ODDMTypeError(`未知的数据类型: ${type}`, context);
  }
}

/**
 * 落库值 -> JS 值
 *
 * 注意：ref / refs 这里只还原成「物理标识字符串 / 标识数组」，
 * 不在此包装成 LazyRef / CollectionProxy —— 因为懒加载需要 Client 实例，
 * 而 naming 层必须是无状态的纯函数。包装统一由 Client.get() 完成。
 */
function decodeValue(raw, type) {
  if (raw === null || raw === undefined) return null;
  switch (type) {
    case 'int':
    case 'float':
      return Number(raw);
    case 'boolean':
      return raw === 1 || raw === true;
    case 'datetime':
      return new Date(raw);
    case 'json':
      try {
        return JSON.parse(raw);
      } catch (err) {
        throw new ODDMTypeError(`json 字段反序列化失败: ${raw}`, { cause: err });
      }
    case 'ref':
      // 单引用就是物理标识本身
      return typeof raw === 'string' ? raw : String(raw);
    case 'refs': {
      // 引用集合是 JSON 数组文本；兼容早期可能存进去的空串
      if (raw === '') return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        throw new ODDMTypeError(`refs 字段反序列化失败: ${raw}`, { cause: err });
      }
    }
    case 'string':
    default:
      return raw;
  }
}

/**
 * where / 查询 DSL 条件的字面量显式转型
 *
 * 原实现把 "> 30" 解析出的 "30" 原样绑定为 TEXT，依赖 SQLite 的隐式亲和性。
 * 这里按 schema 显式转换，避免字符串与数值比较的语义漂移。
 */
function coerceLiteral(raw, type, context = {}) {
  if (raw === null || raw === undefined) return null;

  switch (type) {
    case 'int': {
      const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(num) || !Number.isInteger(num)) {
        throw new ODDMTypeError(`查询条件需要整数: ${JSON.stringify(raw)}`, context);
      }
      return num;
    }
    case 'float': {
      const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (Number.isNaN(num)) {
        throw new ODDMTypeError(`查询条件需要数值: ${JSON.stringify(raw)}`, context);
      }
      return num;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw ? 1 : 0;
      const s = String(raw).trim().toLowerCase();
      if (s === 'true' || s === '1') return 1;
      if (s === 'false' || s === '0') return 0;
      throw new ODDMTypeError(`查询条件需要布尔值: ${JSON.stringify(raw)}`, context);
    }
    case 'datetime': {
      if (raw instanceof Date) return raw.toISOString();
      const parsed = Date.parse(String(raw));
      if (Number.isNaN(parsed)) {
        throw new ODDMTypeError(`查询条件无法解析为时间: ${JSON.stringify(raw)}`, context);
      }
      return new Date(parsed).toISOString();
    }
    case 'json':
      // JSON 以文本存储，范围/大小比较无稳定语义，仅支持等值
      if (typeof raw === 'string') return raw;
      return JSON.stringify(raw);
    case 'ref':
      // 引用按等值比较，值是物理标识
      return normalizeRefTarget(raw, context);
    case 'refs': {
      // 集合引用：单个标识按「是否包含」处理，由查询层决定用 LIKE 还是 json 匹配；
      // 这里只负责把值规范化成物理标识字符串
      return normalizeRefTarget(raw, context);
    }
    case 'string':
    default:
      return String(raw);
  }
}

/**
 * 该类型是否支持范围/大小比较
 *
 * json 以文本存，大小比较无稳定语义；
 * ref / refs 是引用标识，只做等值（或包含）匹配，做范围比较没有意义。
 */
function supportsRangeOperator(type) {
  return type !== 'json' && type !== 'ref' && type !== 'refs';
}

module.exports = {
  IDENTIFIER_RE,
  VERSION_RE,
  PATH_SEGMENT_RE,
  DATA_TYPES,
  TYPE_TO_COLUMN,
  ALL_DRAWER_COLUMNS,
  assertValidClassName,
  assertValidVersion,
  assertValidAttributeName,
  assertValidDataType,
  tableNameFor,
  objectNameFor,
  parseObjectName,
  isPath,
  isObjectName,
  extractRefTarget,
  normalizeRefTarget,
  encodeValue,
  decodeValue,
  coerceLiteral,
  supportsRangeOperator,
  isSystemAttribute,
};
