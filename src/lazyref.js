'use strict';

/**
 * 作者：双子-阿攀达 | lazyref.js | v0.3.1
 *
 * ============================================================================
 * 引用懒加载：LazyRef（单引用）与 CollectionProxy（引用集合）
 *
 * 【设计意图】
 *   存储引用时只落一个物理标识字符串（如 User/apanda），不立即加载目标对象。
 *   只有在真正访问属性时才触发加载。这样做有两个关键收益：
 *     ① 加载一个对象不会递归拖出它引用的整张对象图；
 *     ② 循环引用天然成立（A.friend -> B，B.friend -> A 不会无限递归）。
 *
 * 【Ruby 版与 JS 版的对应】
 *   Ruby 版让 LazyRef 继承 BasicObject（几乎没有方法的基类），使得几乎所有
 *   方法调用都落到 method_missing，再转发给目标对象，从而实现透明代理。
 *
 *   JS 版用 Proxy 达成同样的效果，而且是语言原生支持的，比 method_missing
 *   更彻底——连属性读取、in 判断、迭代都能拦截。
 *
 *   Ruby 版踩过的坑在这里同样存在、且同样必须处理：
 *     · BasicObject 缺 is_a?/class，不显式定义就会转发给目标导致误判
 *       （例如 lazy_ref.is_a?(User) 会返回 true，但它其实是 LazyRef）
 *     → JS 版对应做法：getPrototypeOf 陷阱返回 LazyRef.prototype，
 *       于是 `ref instanceof LazyRef === true`，而 `ref instanceof User === false`。
 *
 *     · 未加载时调用 to_s/inspect 会转发给目标触发加载，打印日志时造成
 *       意外的数据库访问
 *     → JS 版显式提供 toString / inspect，未加载时只打印标识，不触发加载。
 *
 * 【循环引用为什么不会爆栈】
 *   A.bestFriend -> B，B.bestFriend -> A：
 *     加载 A 时 bestFriend 只建 LazyRef（不加载 B）
 *     访问 a.bestFriend.name 时才加载 B
 *     B 的 bestFriend 同样只是 LazyRef（不加载 A）
 *     于是无论引用链多长、是否成环，都只按访问路径逐段加载。
 * ============================================================================
 */

const { ODDMNotFoundError } = require('./errors');
const { SYS_ATTR } = require('./constants');

/** 这些属性由 LazyRef 自身提供，绝不转发给目标对象 */
const INTERNAL_PROPS = new Set([
  '__isLazyRef',
  '__client',
  '__objectName',
  '__targetClass',
  '__target',
  '__loadedFlag',
  '__load',
  '__loaded',
  'then',
  'catch',
  'finally',
  'constructor',
  'toString',
  'toJSON',
  'inspect',
]);

class LazyRef {
  /**
   * @param {object} client  Client 实例（用于按需加载目标对象）
   * @param {string} objectName  目标物理标识，如 User/apanda
   * @param {string} [targetClass] 目标类名，未加载时也能得知
   */
  constructor(client, objectName, targetClass = null) {
    this.__isLazyRef = true;
    this.__client = client;
    this.__objectName = objectName;
    this.__targetClass = targetClass;
    this.__target = null;
    this.__loadedFlag = false;

    // 构造函数直接返回代理：调用方拿到的永远是代理，无法绕过拦截直接碰内部字段
    return new Proxy(this, LazyRefHandler);
  }

  /** 强制加载目标对象（幂等） */
  __load() {
    if (!this.__loadedFlag) {
      const target = this.__client.get(this.__objectName);
      if (target === null || target === undefined) {
        throw new ODDMNotFoundError(
          `引用目标不存在: ${this.__objectName}`,
          { path: this.__objectName, layer: this.__targetClass }
        );
      }
      this.__target = target;
      this.__loadedFlag = true;
    }
    return this.__target;
  }

  /** 目标对象（触发加载） */
  get __target__() {
    return this.__load();
  }

  /** 是否已加载 */
  get __loaded() {
    return this.__loadedFlag;
  }

  /** 目标物理标识（不触发加载）—— naming.js 依赖这个字段做引用编码 */
  get __objectName__() {
    return this.__objectName;
  }

  toJSON() {
    return { __ref: this.__objectName };
  }

  toString() {
    return this.__loadedFlag
      ? String(this.__target)
      : `#<LazyRef ${this.__objectName} (unloaded)>`;
  }

  inspect() {
    return this.__loadedFlag
      ? `#<LazyRef ${this.__objectName} (loaded)>`
      : `#<LazyRef ${this.__objectName} class=${this.__targetClass} unloaded>`;
  }
}

/**
 * LazyRef 的 Proxy 拦截逻辑
 *
 * 核心原则：凡是内部字段与「不该触发加载的方法」自己消化，其余一律
 * 先 __load() 再转发给目标对象。
 */
const LazyRefHandler = {
  get(target, prop, receiver) {
    // ---- 内部字段：不触发加载 ----
    if (prop === '__isLazyRef') return true;
    if (prop === '__objectName' || prop === '__objectName__') return target.__objectName;
    if (prop === '__targetClass') return target.__targetClass;
    if (prop === '__loaded') return target.__loadedFlag;
    if (prop === '__load') return target.__load.bind(target);
    if (prop === '__client') return target.__client;

    // ---- 危险方法：绝不能转发 ----
    // 若把 then 转发给目标，Promise 会把它当成 thenable 并尝试展开，
    // 导致 await 一个 LazyRef 时行为诡异（且会意外加载对象）
    if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;

    if (prop === '__target__' || prop === '__target') return target.__load();
    if (prop === 'toJSON') return () => ({ __ref: target.__objectName });
    if (prop === 'toString') return () => target.toString();
    if (prop === 'inspect') return () => target.inspect();
    if (prop === Symbol.for('nodejs.util.inspect.custom')) return () => target.inspect();

    // ---- 其余：加载目标后转发 ----
    const obj = target.__load();
    const value = obj[prop];
    // 方法要绑回目标对象，否则函数内部的 this 会错指向代理
    return typeof value === 'function' ? value.bind(obj) : value;
  },

  set(target, prop, value) {
    if (prop === '__objectName' || prop === '__targetClass') {
      target[prop] = value;
      return true;
    }
    const obj = target.__load();
    obj[prop] = value;
    return true;
  },

  has(target, prop) {
    if (INTERNAL_PROPS.has(prop)) return true;
    return prop in target.__load();
  },

  // 关键：让 instanceof 判定落在 LazyRef 上，而不是转发给目标对象。
  // Ruby 版必须显式重写 class/is_a? 正是为了规避「把 LazyRef 误判成目标类型」
  // 的陷阱；这里用 getPrototypeOf 陷阱达到同样效果。
  getPrototypeOf() {
    return LazyRef.prototype;
  },

  ownKeys(target) {
    return Reflect.ownKeys(target.__load());
  },

  getOwnPropertyDescriptor(target, prop) {
    if (INTERNAL_PROPS.has(prop)) {
      return { configurable: true, enumerable: false, writable: true, value: target[prop] };
    }
    const desc = Reflect.getOwnPropertyDescriptor(target.__load(), prop);
    // 代理必须让属性看起来可配置，否则 ownKeys 与 get 的一致性校验会报错
    return desc ? { ...desc, configurable: true } : undefined;
  },
};

/**
 * CollectionProxy — 引用集合的懒加载代理
 *
 * 【与 LazyRef 的分工】
 *   LazyRef        单引用：一个物理标识 -> 一个目标对象
 *   CollectionProxy 引用集合：多个物理标识 -> 多个 LazyRef
 *
 * 【重要】集合加载后，每个元素仍是 LazyRef 而非已加载的对象。
 *   这样即使集合很大（比如一个标签下有上千篇文档），也只有真正被访问的
 *   那几个元素会触发数据库读取。
 *
 * 【不需要加载就能回答的操作】
 *   size / isEmpty / includes / serialize —— 只数数组，不碰数据库
 * 【需要加载的操作】
 *   toArray / first / last / at / 迭代 / map —— 会为元素建 LazyRef
 *
 * 【修改只改内存，需显式保存】
 *   与 Ruby 版一致：push/remove/clear 只更新内存中的标识数组，
 *   要让改动落盘必须再调用一次 client.put(...)。
 *   这是有意为之——避免一次集合修改触发 N 次隐式写入。
 */
class CollectionProxy {
  /**
   * @param {object} client
   * @param {string[]} objectNames 物理标识数组
   */
  constructor(client, objectNames = []) {
    this.__isCollectionProxy = true;
    this.__client = client;
    this.__objectNames = Array.isArray(objectNames) ? objectNames.slice() : [];
    this.__loaded = false;
    this.__targets = [];
  }

  /**
   * 加载：把每个物理标识包成 LazyRef
   * 注意这里不加载目标对象本身，只建代理，因此是廉价操作。
   */
  load() {
    if (!this.__loaded) {
      this.__targets = this.__objectNames.map((ns) => {
        // 已经是 LazyRef 的元素原样保留，避免重复包装
        if (ns && typeof ns === 'object' && ns.__isLazyRef) return ns;
        const parsed = typeof ns === 'string' && ns.includes('/') ? ns.split('/') : null;
        return new LazyRef(this.__client, ns, parsed ? parsed[0] : null);
      });
      this.__loaded = true;
    }
    return this.__targets;
  }

  get loaded() {
    return this.__loaded;
  }

  /** 元素个数（不触发加载） */
  get size() {
    return this.__objectNames.length;
  }

  get length() {
    return this.__objectNames.length;
  }

  isEmpty() {
    return this.__objectNames.length === 0;
  }

  /** 是否包含某个引用（不触发加载） */
  includes(target) {
    return this.__objectNames.includes(CollectionProxy._toObjectName(target));
  }

  /** 追加一个引用；返回 this 以支持链式 */
  push(target) {
    const ns = CollectionProxy._toObjectName(target);
    this.__objectNames.push(ns);
    // 已加载时同步维护元素数组，避免下次读取与标识数组不一致
    if (this.__loaded) {
      this.__targets.push(
        this.__isRefLike(target) ? target : new LazyRef(this.__client, ns, null)
      );
    }
    return this;
  }

  /** push 的别名，语义更贴近数组操作 */
  add(target) {
    return this.push(target);
  }

  /** 移除一个引用，返回被移除的标识（不存在则返回 null） */
  remove(target) {
    const ns = CollectionProxy._toObjectName(target);
    const idx = this.__objectNames.indexOf(ns);
    if (idx === -1) return null;
    this.__objectNames.splice(idx, 1);
    if (this.__loaded) this.__targets.splice(idx, 1);
    return ns;
  }

  /** 整体替换集合内容 */
  replace(newTargets) {
    this.__objectNames = newTargets.map((t) => CollectionProxy._toObjectName(t));
    this.__loaded = false;
    this.__targets = [];
    return this;
  }

  clear() {
    this.__objectNames = [];
    this.__targets = [];
    this.__loaded = true;
    return this;
  }

  first() {
    return this.isEmpty() ? null : this.load()[0];
  }

  last() {
    return this.isEmpty() ? null : this.load()[this.__targets.length - 1];
  }

  at(index) {
    return this.load()[index];
  }

  toArray() {
    return this.load().slice();
  }

  map(fn) {
    return this.load().map(fn);
  }

  filter(fn) {
    return this.load().filter(fn);
  }

  forEach(fn) {
    this.load().forEach(fn);
    return this;
  }

  /** 迭代支持：for (const ref of doc.tags) */
  [Symbol.iterator]() {
    return this.load()[Symbol.iterator]();
  }

  /** 序列化：返回物理标识数组，供落盘使用（naming.js 依赖 __objectNames） */
  serialize() {
    return this.__objectNames.slice();
  }

  /** 取某个元素的物理标识（不触发加载） */
  objectNameAt(index) {
    return this.__objectNames[index];
  }

  toJSON() {
    return { __refs: this.__objectNames };
  }

  inspect() {
    return this.__loaded
      ? `#<CollectionProxy [${this.__targets.length} loaded]>`
      : `#<CollectionProxy [${this.__objectNames.length} refs] (unloaded)>`;
  }

  toString() {
    return this.inspect();
  }

  // -------------------------------------------------------------------------
  // 内部工具
  // -------------------------------------------------------------------------

  /** 把各种形态的入参统一成物理标识字符串 */
  static _toObjectName(target) {
    if (target === null || target === undefined) {
      throw new ODDMNotFoundError('引用集合不接受 null/undefined 元素');
    }
    if (typeof target === 'string') return target;
    if (target.__isLazyRef) return target.__objectName;
    if (target.__isCollectionProxy) {
      throw new ODDMNotFoundError('引用集合的元素不能是另一个集合');
    }
    throw new ODDMNotFoundError(
      `引用集合元素需要物理标识或引用对象，收到: ${JSON.stringify(target)}`
    );
  }

  static __isRefLike(target) {
    return Boolean(target && (target.__isLazyRef || typeof target === 'string'));
  }

  __isRefLike(target) {
    return Boolean(target && typeof target === 'object' && target.__isLazyRef);
  }
}

module.exports = { LazyRef, CollectionProxy, INTERNAL_PROPS };
