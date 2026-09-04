'use strict';

/**
 * v0.3.1 端口验证测试
 *
 * 覆盖从 Ruby v0.3.1 对齐过来的几项新能力：
 *   1. Client.migrate      —— 版本数据迁移（含 created_at 保留、transform 回调）
 *   2. createChild/findChild —— 层级从属对象的便捷创建与查找
 *   3. 集合视图            —— createChild 自动登记 + Helper.createCollectionView
 *   4. identity map        —— 可选身份映射（命中缓存 / 写入失效 / 事务清空）
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { Client } = require('../src/oddm');

// ===========================================================================
// 1. migrate —— 版本数据迁移
// ===========================================================================

test('migrate: 把实例从旧版本表搬到新版本表并保留数据', () => {
  const db = new Client(':memory:');
  db.defineClass('User', { name: 'string', age: 'int' }, '1.0');
  db.defineClass('User', { name: 'string', age: 'int', bio: 'string' }, '2.0');

  db.put("Root.User['u1']", { name: 'A', age: 30 });
  db.put("Root.User['u2']", { name: 'B', age: 40 });

  const n = db.migrate('User', '1.0', '2.0');
  assert.strictEqual(n, 2);

  // 旧表已无孤儿行
  const orphan = db.helper.query(
    "SELECT object_name FROM User_V1_0 WHERE object_name = 'User/u1'"
  );
  assert.strictEqual(orphan.length, 0);

  // 新表数据完整
  const u1 = db.get('User/u1');
  assert.deepStrictEqual({ name: u1.name, age: u1.age }, { name: 'A', age: 30 });
  assert.strictEqual(db.get('User/u2').name, 'B');

  // all() 在最新版本下能列出迁移后的实例
  assert.deepStrictEqual(db.User.all().map((o) => o.name).sort(), ['A', 'B']);
});

test('migrate: transform 回调可改写迁移后的属性', () => {
  const db = new Client(':memory:');
  db.defineClass('User', { name: 'string', age: 'int' }, '1.0');
  db.defineClass('User', { name: 'string', age: 'int', bio: 'string' }, '2.0');
  db.put("Root.User['u1']", { name: 'A', age: 30 });

  db.migrate('User', '1.0', '2.0', (ent) => ({
    name: ent.name,
    age: ent.age,
    bio: `migrated@${ent.age}`,
  }));

  assert.strictEqual(db.get('User/u1').bio, 'migrated@30');
});

test('migrate: 默认转换器只保留新旧 schema 交集的属性', () => {
  const db = new Client(':memory:');
  db.defineClass('Note', { body: 'string', deprecated: 'string' }, '1.0');
  db.defineClass('Note', { body: 'string', pinned: 'boolean' }, '2.0');
  db.put("Root.Note['n1']", { body: 'hi', deprecated: 'x' });

  db.migrate('Note', '1.0', '2.0');

  const n1 = db.get('Note/n1');
  assert.strictEqual(n1.body, 'hi');
  assert.strictEqual('deprecated' in n1, false, '被删除的属性不应出现');
});

test('migrate: 保留原始创建时间（__created_at__ 不变）', () => {
  const db = new Client(':memory:');
  db.defineClass('User', { name: 'string' }, '1.0');
  db.defineClass('User', { name: 'string', bio: 'string' }, '2.0');
  db.put("Root.User['u1']", { name: 'A' });

  const before = db.meta$('User/u1').__created_at__;
  assert.ok(before instanceof Date);

  db.migrate('User', '1.0', '2.0', (ent) => ({ name: ent.name, bio: '' }));

  const after = db.meta$('User/u1').__created_at__;
  assert.strictEqual(after.toISOString(), before.toISOString());
});

test('migrate: 未注册的源/目标版本抛错', () => {
  const db = new Client(':memory:');
  db.defineClass('User', { name: 'string' }, '1.0');
  assert.throws(() => db.migrate('User', '1.0', '9.9'), /目标版本未注册/);
  assert.throws(() => db.migrate('User', '0.1', '1.0'), /源版本未注册/);
});

test('migrate: 相同版本直接跳过返回 0', () => {
  const db = new Client(':memory:');
  db.defineClass('User', { name: 'string' }, '1.0');
  db.put("Root.User['u1']", { name: 'A' });
  assert.strictEqual(db.migrate('User', '1.0', '1.0'), 0);
});

// ===========================================================================
// 2. createChild / findChild —— 层级从属对象
// ===========================================================================

test('createChild: 创建父子对象并自动登记可查询的集合视图', () => {
  const db = new Client(':memory:');
  db.defineClass('User', { name: 'string' });
  db.defineClass('Post', { title: 'string' });

  db.createChild('User', 'apanda', 'Post', 'p1', { title: 'Hello' });
  db.createChild('User', 'apanda', 'Post', 'p2', { title: 'World' });

  // 自动登记的集合视图可直接查询
  const posts = db.views.queryObjects('User_apanda_Posts');
  assert.strictEqual(posts.length, 2);
  assert.deepStrictEqual(posts.map((p) => p.title).sort(), ['Hello', 'World']);

  // 路由元数据存在
  const route = db.helper.route('User_apanda_Posts');
  assert.strictEqual(route.viewType, 'collection');
  assert.strictEqual(route.className, 'Post');
});

test('findChild: 命中正确父子关系，父节点不匹配返回 null', () => {
  const db = new Client(':memory:');
  db.defineClass('User', { name: 'string' });
  db.defineClass('Post', { title: 'string' });

  db.createChild('User', 'apanda', 'Post', 'p1', { title: 'Hello' });
  db.createChild('User', 'other', 'Post', 'p2', { title: 'Clash' });

  // p1 属于 apanda
  assert.strictEqual(db.findChild('User', 'apanda', 'Post', 'p1').title, 'Hello');
  // p2 属于 other，从 apanda 视角查应为 null
  assert.strictEqual(db.findChild('User', 'apanda', 'Post', 'p2'), null);
  assert.strictEqual(db.findChild('User', 'apanda', 'Post', 'pX'), null);
  assert.strictEqual(db.findChild('User', 'apanda', 'Missing', 'p1'), null);
});

test('ClassScope.createChild / findChild 委托正确', () => {
  const db = new Client(':memory:');
  db.defineClass('User', { name: 'string' });
  db.defineClass('Post', { title: 'string' });

  db.User.createChild('apanda', 'Post', 'p1', { title: 'Hi' });
  const post = db.User.findChild('apanda', 'Post', 'p1');
  assert.strictEqual(post.title, 'Hi');
  assert.strictEqual(db.User.children('apanda', 'Post').length, 1);
});

// ===========================================================================
// 3. Helper.createCollectionView
// ===========================================================================

test('Helper.createCollectionView: 手工登记可查询的集合视图', () => {
  const db = new Client(':memory:');
  db.defineClass('User', { name: 'string' });
  db.defineClass('Post', { title: 'string' });

  db.put("Root.User['apanda']", { name: 'A' });
  db.put("Root.User['apanda'].Post['p1']", { title: 'One' });
  db.put("Root.User['apanda'].Post['p2']", { title: 'Two' });

  db.helper.createCollectionView('User', 'apanda', 'Post');
  const posts = db.views.queryObjects('User_apanda_Posts');
  assert.strictEqual(posts.length, 2);
});

// ===========================================================================
// 4. identity map
// ===========================================================================

test('identity map: 关闭时（默认）多次 get 返回不同引用', () => {
  const db = new Client(':memory:');
  db.defineClass('User', { name: 'string' });
  db.put("Root.User['u1']", { name: 'A' });

  assert.notStrictEqual(db.get('User/u1'), db.get('User/u1'));
});

test('identity map: 开启时同版本多次 get 命中同一引用', () => {
  const db = new Client({ path: ':memory:', identityMap: true });
  db.defineClass('User', { name: 'string' });
  db.put("Root.User['u1']", { name: 'A' });

  const a = db.get('User/u1');
  const b = db.get('User/u1');
  assert.strictEqual(a, b);
});

test('identity map: put 后缓存失效，再次 get 拿到新对象', () => {
  const db = new Client({ path: ':memory:', identityMap: true });
  db.defineClass('User', { name: 'string' });
  db.put("Root.User['u1']", { name: 'A' });

  const a = db.get('User/u1');
  a.name = 'mutated'; // 改的是缓存引用
  assert.strictEqual(db.get('User/u1').name, 'mutated'); // 仍是缓存

  db.put("Root.User['u1']", { name: 'B' }); // 写入使缓存失效
  const c = db.get('User/u1');
  assert.notStrictEqual(a, c);
  assert.strictEqual(c.name, 'B');
});

test('identity map: get 的 fresh 选项可绕过缓存', () => {
  const db = new Client({ path: ':memory:', identityMap: true });
  db.defineClass('User', { name: 'string' });
  db.put("Root.User['u1']", { name: 'A' });

  const a = db.get('User/u1');
  const fresh = db.get('User/u1', { fresh: true });
  assert.notStrictEqual(a, fresh);
});

test('identity map: destroy 后缓存失效', () => {
  const db = new Client({ path: ':memory:', identityMap: true });
  db.defineClass('User', { name: 'string' });
  db.put("Root.User['u1']", { name: 'A' });

  const a = db.get('User/u1');
  db.dbHelper.destroy('User/u1');
  assert.strictEqual(db.get('User/u1'), null);
  // 缓存里不应残留导致不一致
  assert.notStrictEqual(db.get('User/u1'), a);
});

test('identity map: 事务提交后清空（跨事务拿新快照）', () => {
  const db = new Client({ path: ':memory:', identityMap: true });
  db.defineClass('User', { name: 'string' });
  db.put("Root.User['u1']", { name: 'A' });

  let insideRef;
  db.dbHelper.transaction(() => {
    insideRef = db.get('User/u1');
    assert.strictEqual(db.get('User/u1'), insideRef); // 事务内命中
  });
  // 事务结束后缓存被清空，再次 get 拿到的是全新快照（引用不同）
  const outsideRef = db.get('User/u1');
  assert.notStrictEqual(insideRef, outsideRef);
  // 事务之外同一会话内仍可正常命中缓存
  assert.strictEqual(db.get('User/u1'), outsideRef);
});

// ===========================================================================
// 5. 版本号
// ===========================================================================

test('版本号已对齐到 0.3.1', () => {
  const { VERSION } = require('../src/constants');
  assert.strictEqual(VERSION, '0.3.1');
});
