'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  Client,
  DBHelper,
  ODDMCycleError,
  ODDMDepthLimitError,
  ODDMNotFoundError,
} = require('../src/oddm');

function fixture(options = {}) {
  const client = new Client(options);
  const helper = new DBHelper(client);
  client.defineClass('User', { name: 'string' });
  client.defineClass('Post', { title: 'string' });
  client.defineClass('Comment', { body: 'string' });
  return { client, helper };
}

function seedTree(client) {
  client.put("Root.User['u1']", { name: 'Alice' });
  client.put("Root.User['u2']", { name: 'Bob' });
  client.put("Root.User['u1'].Post['p1']", { title: 'first' });
  client.put("Root.User['u1'].Post['p2']", { title: 'second' });
  client.put("Root.User['u1'].Post['p1'].Comment['c1']", { body: 'nice' });
}

// ---------------------------------------------------------------------------
// P0-1 回归：用物理名写入不得重置父节点
// ---------------------------------------------------------------------------

test('[P0-1] 用物理名 put 子节点不破坏其父级挂载', () => {
  const { client, helper } = fixture();
  seedTree(client);

  client.put('Post/p1', { title: 'updated' });

  assert.strictEqual(client.get('Post/p1').title, 'updated');
  const children = helper.children('User/u1').map((n) => n.object_name);
  assert.ok(children.includes('Post/p1'), 'Post/p1 应仍挂在 User/u1 下');
  assert.deepStrictEqual(
    helper.canonicalPath('Post/p1'),
    "Root.User['u1'].Post['p1']"
  );
});

test('[P0-1] updateDiff 子节点后父级不变（原实现的致命组合场景）', () => {
  const { client, helper } = fixture();
  seedTree(client);

  helper.updateDiff('Post/p1', { title: 'renamed' });

  const children = helper.children('User/u1').map((n) => n.object_name);
  assert.deepStrictEqual(children.sort(), ['Post/p1', 'Post/p2']);
  assert.strictEqual(helper.children('Root').length, 2, 'Root 下不应多出被顶上来的节点');
});

test('[P0-1] 深层节点被 updateDiff 后完整路径仍可反解', () => {
  const { client, helper } = fixture();
  seedTree(client);

  helper.updateDiff('Comment/c1', { body: 'edited' });

  assert.strictEqual(
    helper.canonicalPath('Comment/c1'),
    "Root.User['u1'].Post['p1'].Comment['c1']"
  );
});

// ---------------------------------------------------------------------------
// P0-3：路径中间节点必须进入拓扑索引
// ---------------------------------------------------------------------------

test('[P0-3] 深层路径的中间节点自动登记到索引', () => {
  const { client } = fixture();
  client.defineClass('Comment', { body: 'string' });
  // 只写入最深层节点，中间两层应被自动补建
  client.put("Root.User['u9'].Post['p9'].Comment['c9']", { body: 'deep' });

  assert.ok(client.exists('User/u9'), '中间节点 User/u9 应已登记');
  assert.ok(client.exists('Post/p9'), '中间节点 Post/p9 应已登记');
  assert.ok(client.exists('Comment/c9'));
});

test('[P0-3] 中间节点占位后仍可被正常读取与挂载', () => {
  const { client, helper } = fixture();
  client.put("Root.User['u9'].Post['p9']", { title: 'auto' });

  assert.deepStrictEqual(client.get('User/u9'), {});
  assert.deepStrictEqual(client.get('Post/p9'), { title: 'auto' });
  assert.deepStrictEqual(
    helper.canonicalPath('Post/p9'),
    "Root.User['u9'].Post['p9']"
  );
});

// ---------------------------------------------------------------------------
// 拓扑导航
// ---------------------------------------------------------------------------

test('children 返回直系子节点', () => {
  const { client, helper } = fixture();
  seedTree(client);
  const names = helper.children('User/u1').map((n) => n.object_name);
  assert.deepStrictEqual(names.sort(), ['Post/p1', 'Post/p2']);
});

test('siblings 返回同级兄弟节点且不含自身', () => {
  const { client, helper } = fixture();
  seedTree(client);
  const names = helper.siblings('Post/p1').map((n) => n.object_name);
  assert.deepStrictEqual(names, ['Post/p2']);
});

test('descendants 递归返回整棵子树', () => {
  const { client, helper } = fixture();
  seedTree(client);
  const names = helper.descendants('User/u1').map((n) => n.object_name).sort();
  assert.deepStrictEqual(names, ['Comment/c1', 'Post/p1', 'Post/p2']);
});

test('ancestors 自底向上返回祖先链', () => {
  const { client, helper } = fixture();
  seedTree(client);
  const chain = helper.ancestors('Comment/c1').map((n) => n.object_name);
  assert.deepStrictEqual(chain, ['Root', 'User/u1', 'Post/p1', 'Comment/c1']);
});

// ---------------------------------------------------------------------------
// 拓扑变更
// ---------------------------------------------------------------------------

test('moveTo 正常重挂载', () => {
  const { client, helper } = fixture();
  seedTree(client);

  helper.moveTo('Post/p1', 'User/u2');

  assert.deepStrictEqual(helper.children('User/u1').map((n) => n.object_name), ['Post/p2']);
  assert.ok(helper.children('User/u2').map((n) => n.object_name).includes('Post/p1'));
  // 子孙随父迁移
  assert.strictEqual(
    helper.canonicalPath('Comment/c1'),
    "Root.User['u2'].Post['p1'].Comment['c1']"
  );
});

test('moveTo 到自身或自身后代应触发环检测', () => {
  const { client, helper } = fixture();
  seedTree(client);

  assert.throws(() => helper.moveTo('User/u1', 'Post/p1'), ODDMCycleError);
  assert.throws(() => helper.moveTo('User/u1', 'User/u1'), ODDMCycleError);
  assert.throws(
    () => helper.moveTo('User/u1', 'Comment/c1'),
    ODDMCycleError
  );
});

test('moveTo 到不存在的父节点应报错', () => {
  const { client, helper } = fixture();
  seedTree(client);
  assert.throws(() => helper.moveTo('Post/p1', 'User/ghost'), ODDMNotFoundError);
});

test('moveTo 可挂回 Root', () => {
  const { client, helper } = fixture();
  seedTree(client);

  helper.moveTo('Post/p1', 'Root');
  assert.strictEqual(helper.canonicalPath('Post/p1'), "Root.Post['p1']");
});

test('超出 maxDepth 的 moveTo 被拒绝', () => {
  const client = new Client({ maxDepth: 3 });
  const helper = new DBHelper(client);
  client.defineClass('A', { v: 'string' });
  client.defineClass('B', { v: 'string' });
  client.defineClass('C', { v: 'string' });

  client.put("Root.A['a1'].B['b1'].C['c1']", { v: 'x' }); // 深度 3，刚好等于上限
  client.put("Root.A['a2']", { v: 'y' }); // 深度 1，独立分支，无环关系

  // A/a2 挂到 C/c1 下会变成深度 4，且不构成环 —— 应只触发深度限制
  assert.throws(() => helper.moveTo('A/a2', 'C/c1'), ODDMDepthLimitError);
});

test('超出 maxDepth 的 put 被拒绝', () => {
  const client = new Client({ maxDepth: 2 });
  client.defineClass('A', { v: 'string' });
  client.defineClass('B', { v: 'string' });
  client.defineClass('C', { v: 'string' });

  client.put("Root.A['a'].B['b']", { v: '1' });
  assert.throws(
    () => client.put("Root.A['a'].B['b'].C['c']", { v: '1' }),
    ODDMDepthLimitError
  );
});

// ---------------------------------------------------------------------------
// 级联删除
// ---------------------------------------------------------------------------

test('destroy recursive 删除整棵子树', () => {
  const { client, helper } = fixture();
  seedTree(client);

  helper.destroy('User/u1', { recursive: true });

  assert.strictEqual(client.get('User/u1'), null);
  assert.strictEqual(client.get('Post/p1'), null);
  assert.strictEqual(client.get('Post/p2'), null);
  assert.strictEqual(client.get('Comment/c1'), null);
  assert.ok(client.exists('User/u2'), '兄弟分支不应受影响');
});

test('destroy 非递归只删自身，子节点留在原处', () => {
  const { client, helper } = fixture();
  seedTree(client);

  helper.destroy('Post/p1', { recursive: false });

  assert.strictEqual(client.get('Post/p1'), null);
  assert.ok(client.exists('Comment/c1'));
});
