'use strict';

/**
 * ODDM 错误体系
 *
 * 所有 ODDM 抛出的错误都带 path（ODL 寻址路径）与 layer（失败层级），
 * 供 APL 日志输出可定位的诊断信息。
 */

const CODES = {
  VALIDATION: 'ODDM_VALIDATION_ERROR',
  PATH: 'ODDM_PATH_ERROR',
  NOT_FOUND: 'ODDM_NOT_FOUND',
  QUERY: 'ODDM_QUERY_ERROR',
  TYPE: 'ODDM_TYPE_ERROR',
  TRANSACTION: 'ODDM_TRANSACTION_ERROR',
  DEPTH: 'ODDM_DEPTH_LIMIT_ERROR',
  CYCLE: 'ODDM_CYCLE_ERROR',
};

class ODDMError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code || CODES.VALIDATION;
    this.path = options.path ?? null;
    this.layer = options.layer ?? null;
    this.sql = options.sql ?? null;
    this.params = options.params ?? null;
    if (options.cause !== undefined) this.cause = options.cause;
    if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
  }

  /** 供日志与序列化使用 */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      path: this.path,
      layer: this.layer,
      sql: this.sql ?? undefined,
      params: this.params ?? undefined,
    };
  }

  toString() {
    const parts = [this.code];
    if (this.path) parts.push(`路径: ${this.path}`);
    if (this.layer) parts.push(`层级: ${this.layer}`);
    parts.push(this.message);
    return parts.join(' | ');
  }
}

class ODDMValidationError extends ODDMError {
  constructor(message, options = {}) {
    super(message, { ...options, code: CODES.VALIDATION });
  }
}

class ODDMPathError extends ODDMError {
  constructor(message, options = {}) {
    super(message, { ...options, code: CODES.PATH });
  }
}

class ODDMNotFoundError extends ODDMError {
  constructor(message, options = {}) {
    super(message, { ...options, code: CODES.NOT_FOUND });
  }
}

class ODDMQueryError extends ODDMError {
  constructor(message, options = {}) {
    super(message, { ...options, code: CODES.QUERY });
  }
}

class ODDMTypeError extends ODDMError {
  constructor(message, options = {}) {
    super(message, { ...options, code: CODES.TYPE });
  }
}

class ODDMTransactionError extends ODDMError {
  constructor(message, options = {}) {
    super(message, { ...options, code: CODES.TRANSACTION });
  }
}

class ODDMDepthLimitError extends ODDMError {
  constructor(message, options = {}) {
    super(message, { ...options, code: CODES.DEPTH });
  }
}

class ODDMCycleError extends ODDMError {
  constructor(message, options = {}) {
    super(message, { ...options, code: CODES.CYCLE });
  }
}

module.exports = {
  CODES,
  ODDMError,
  ODDMValidationError,
  ODDMPathError,
  ODDMNotFoundError,
  ODDMQueryError,
  ODDMTypeError,
  ODDMTransactionError,
  ODDMDepthLimitError,
  ODDMCycleError,
};
