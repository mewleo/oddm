'use strict';

const {
  ODDMValidationError,
  ODDMTypeError,
  ODDMPathError,
} = require('./errors');

/**
 * 命名与类型工具
 *
 * 集中承担三件事：
 * 1. 标识符白名单校验 —— 表名由字符串插值拼进 SQL，必须在此拦截注入。
 * 2. 物理标识（object_name）与表名的双向构造。
 * 3. 存储层类型编解码，以及 where 条件字面量的显式转型。
 */

/** 类名 / 属性名白名单：字母或下划线开头，仅含字母数字下划线 */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 版本号：点分数字，如 1.0 / 2.1.3 */
const VERSION_RE = /^\d+(?:\.\d+)+$/;

/** ODL 路径段：.ClassName['key'] / .ClassName["key"] / .ClassName[123] */
const PATH_SEGMENT_RE = /\.([A-Za-z0-9_]+)\[(?:'([^']*)'|"([^"]*)"|(\d+))\]/g;

const DATA_TYPES = ['string', 'int', 'float', 'boolean', 'datetime', 'json'];

const TYPE_TO_COLUMN = Object.freeze({
  string: 'v_string',
  int: 'v_int',
  float: 'v_float',
  boolean: 'v_boolean',
  datetime: 'v_datetime',
  json: 'v_json',
});

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

    default:
      throw new ODDMTypeError(`未知的数据类型: ${type}`, context);
  }
}

/** 落库值 -> JS 值 */
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
    case 'string':
    default:
      return raw;
  }
}

/**
 * where 条件的字面量显式转型
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
    case 'string':
    default:
      return String(raw);
  }
}

/** json 类型的比较只在等值下有意义 */
function supportsRangeOperator(type) {
  return type !== 'json';
}

module.exports = {
  IDENTIFIER_RE,
  VERSION_RE,
  PATH_SEGMENT_RE,
  DATA_TYPES,
  TYPE_TO_COLUMN,
  assertValidClassName,
  assertValidVersion,
  assertValidAttributeName,
  assertValidDataType,
  tableNameFor,
  objectNameFor,
  parseObjectName,
  isPath,
  isObjectName,
  encodeValue,
  decodeValue,
  coerceLiteral,
  supportsRangeOperator,
};
