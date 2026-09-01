'use strict';

/**
 * APL (Addressing Path Log) —— 寻址路径日志
 *
 * 概念文档 6.2 节要求：所有底层 SQL 操作都伴随其对应的对象寻址路径。
 * 例如：
 *   [APL-ERROR] 失败路径: Root.User['apanda'].Post.Comments | 失败层级: Post.Comments
 *
 * 设计要点：
 * - 默认关闭，零开销；开启后每条 SQL 记录 path / op / sql / params / 耗时。
 * - 失败时输出 ERROR 级，携带失败层级，便于沿路径定位。
 * - writer 可注入（默认 console），便于测试时收集日志。
 */

const LEVELS = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };

class APL {
  /**
   * @param {object} [options]
   * @param {string} [options.level='off'] off | error | warn | info | debug
   * @param {{error?:Function,warn?:Function,info?:Function,debug?:Function}} [options.writer]
   * @param {boolean} [options.includeSql=false] 是否在日志中输出完整 SQL 与参数
   */
  constructor(options = {}) {
    this.level = LEVELS[options.level ?? 'off'] ?? LEVELS.off;
    this.writer = options.writer || console;
    this.includeSql = Boolean(options.includeSql);
    this.entries = [];
    this.maxBuffer = options.maxBuffer ?? 500;
  }

  static get LEVELS() {
    return LEVELS;
  }

  setLevel(level) {
    const next = LEVELS[level];
    if (next === undefined) throw new Error(`未知的 APL 日志级别: ${level}`);
    this.level = next;
    return this;
  }

  _enabled(level) {
    return this.level >= LEVELS[level];
  }

  _emit(level, entry) {
    const record = {
      level,
      timestamp: new Date().toISOString(),
      ...entry,
    };

    this.entries.push(record);
    if (this.entries.length > this.maxBuffer) this.entries.shift();

    const fn = this.writer[level];
    if (typeof fn === 'function') fn.call(this.writer, this.format(record));
    return record;
  }

  /** 格式化为单行诊断文本 */
  format(record) {
    const tag = `APL-${record.level.toUpperCase()}`;
    // 与概念文档 6.2 节一致：失败时标明「失败路径」，便于沿路径定位
    const label = record.level === 'error' ? '失败路径' : '路径';
    const head = record.path ? `${label}: ${record.path}` : `${label}: <none>`;
    const layer = record.layer ? ` | 层级: ${record.layer}` : '';
    const op = record.op ? ` | 操作: ${record.op}` : '';
    const dur =
      record.durationMs !== undefined ? ` | 耗时: ${record.durationMs.toFixed(2)}ms` : '';
    const msg = record.message ? ` | ${record.message}` : '';

    // SQL 通常是多行模板字符串，压成单行才能作为一行日志被检索
    let sql = '';
    if (this.includeSql && record.sql) {
      const flat = String(record.sql).replace(/\s+/g, ' ').trim();
      const params = record.params ? ` :: ${JSON.stringify(record.params)}` : '';
      sql = ` | SQL: ${flat}${params}`;
    }

    return `[${tag}] ${head}${layer}${op}${dur}${msg}${sql}`;
  }

  debug(entry) {
    if (!this._enabled('debug')) return null;
    return this._emit('debug', entry);
  }

  info(entry) {
    if (!this._enabled('info')) return null;
    return this._emit('info', entry);
  }

  warn(entry) {
    if (!this._enabled('warn')) return null;
    return this._emit('warn', entry);
  }

  error(entry) {
    if (!this._enabled('error')) return null;
    return this._emit('error', entry);
  }

  clear() {
    this.entries.length = 0;
    return this;
  }

  /** 取出全部缓冲日志（测试用） */
  dump() {
    return this.entries.slice();
  }
}

module.exports = { APL, LEVELS };
