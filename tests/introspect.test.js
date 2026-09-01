'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Client, DBHelper, PathParser, ODDMNotFoundError } = require('../src/oddm');

function collectLogs(level = 'debug') {
  const lines = [];
  const writer = {};
  for (const name of ['error', 'warn', 'info', 'debug']) {
    writer[name] = (msg) => lines.push({ level: name, msg });
  }
  return { lines, writer, level };
}

function seed(client) {
  client.defineClass('User', { name: 'string', age: 'int' });
  client.defineClass('Post', { title: 'string' });
  client.put("Root.User['u1']", { name: 'Alice', age: 35 });
  client.put("Root.User['u1'].Post['p1']", { title: 'hello' });
}

// ---------------------------------------------------------------------------
// 自省接口
// ---------------------------------------------------------------------------

test('introspect 返回完整结构', () => {
  const client = new Client();
  seed(client);

  const snap = client.introspect();

  assert.strictEqual(snap.root, 'Root');
  assert.ok(snap.odlSyntax.includes('Root.ClassName'));
  assert.strictEqual(snap.classes.length, 2);
  assert.ok(snap.tree);
  assert.ok(snap.stats);
});

test('introspect 的类条目含 schema、列映射与实例数', () => {
  const client = new Client();
  seed(client);

  const user = client.introspect().classes.find((c) => c.className === 'User');

  assert.strictEqual(user.version, '1.0');
  assert.strictEqual(user.table, 'User_V1_0');
  assert.deepStrictEqual(user.schema, { name: 'string', age: 'int' });
  assert.deepStrictEqual(user.columns, { name: 'v_string', age: 'v_int' });
  assert.strictEqual(user.instanceCount, 1);
});

test('introspect 给出的 samplePath 是可解析的合法 ODL 路径', () => {
  const client = new Client();
  seed(client);

  const snap = client.introspect();
  for (const cls of snap.classes) {
    if (cls.instanceCount === 0) continue;
    const nodes = PathParser.parse(cls.samplePath); // 不抛错即合法
    assert.strictEqual(nodes[nodes.length - 1].class_name, cls.className);
  }
});

test('introspect 的 sampleObject 可直接作为写入模板', () => {
  const client = new Client();
  seed(client);

  const user = client.introspect().classes.find((c) => c.className === 'User');
  assert.deepStrictEqual(user.sampleObject, { name: 'Alice', age: 35 });
});

test('无实例的类给出占位示例路径', () => {
  const client = new Client();
  client.defineClass('Empty', { v: 'string' });

  const entry = client.introspect().classes.find((c) => c.className === 'Empty');
  assert.strictEqual(entry.samplePath, "Root.Empty['<key>']");
  assert.strictEqual(entry.sampleObject, null);
  assert.strictEqual(entry.instanceCount, 0);
});

test('introspect 的 tree 按指定层数展开', () => {
  const client = new Client();
  seed(client);

  const shallow = client.introspect({ treeDepth: 1 }).tree;
  assert.strictEqual(shallow.depth, 1);
  assert.strictEqual(shallow.nodes.length, 1);
  assert.strictEqual(shallow.nodes[0].objectName, 'User/u1');
  assert.deepStrictEqual(shallow.nodes[0].children, []);

  const deep = client.introspect({ treeDepth: 2 }).tree;
  assert.strictEqual(deep.nodes[0].children[0].objectName, 'Post/p1');
});

test('introspect 的 tree 节点带完整 ODL 路径', () => {
  const client = new Client();
  seed(client);

  const tree = client.introspect({ treeDepth: 2 }).tree;
  assert.strictEqual(tree.nodes[0].path, "Root.User['u1']");
  assert.strictEqual(tree.nodes[0].children[0].path, "Root.User['u1'].Post['p1']");
});

test('stats 统计对象数与最大深度', () => {
  const client = new Client();
  seed(client);

  const snap = client.introspect();
  assert.strictEqual(snap.stats.totalObjects, 2); // User/u1 + Post/p1，不含 Root
  assert.strictEqual(snap.stats.maxDepth, 2);
});

test('introspectClass 返回单类详情', () => {
  const client = new Client();
  seed(client);

  const detail = client.introspectClass('User');

  assert.strictEqual(detail.className, 'User');
  assert.strictEqual(detail.table, 'User_V1_0');
  assert.deepStrictEqual(
    detail.attributes.map((a) => [a.name, a.type, a.column]),
    [
      ['name', 'string', 'v_string'],
      ['age', 'int', 'v_int'],
    ]
  );
  assert.strictEqual(detail.instanceCount, 1);
});

test('introspectClass 标注哪些属性支持范围比较', () => {
  const client = new Client();
  client.defineClass('Doc', { body: 'string', meta: 'json', n: 'int' });

  const detail = client.introspectClass('Doc');
  const byName = Object.fromEntries(detail.attributes.map((a) => [a.name, a.rangeComparable]));

  assert.strictEqual(byName.body, true);
  assert.strictEqual(byName.n, true);
  assert.strictEqual(byName.meta, false, 'json 不支持范围比较');
});

test('introspectClass 对未注册类型报错', () => {
  const client = new Client();
  assert.throws(() => client.introspectClass('Ghost'), ODDMNotFoundError);
});

test('自省结果可 JSON 序列化（供工具链消费）', () => {
  const client = new Client();
  seed(client);
  const snap = client.introspect();
  const round = JSON.parse(JSON.stringify(snap));
  assert.strictEqual(round.classes.length, 2);
  assert.strictEqual(round.tree.nodes[0].path, "Root.User['u1']");
});

// ---------------------------------------------------------------------------
// APL 寻址路径日志
// ---------------------------------------------------------------------------

test('APL 默认关闭，不产生任何记录', () => {
  const client = new Client();
  seed(client);
  assert.strictEqual(client.apl.dump().length, 0);
});

test('APL 开启后记录 SQL 操作并携带 ODL 路径', () => {
  const { lines, writer, level } = collectLogs();
  const client = new Client({ apl: { level, writer } });
  client.defineClass('User', { name: 'string' });

  client.put("Root.User['u1']", { name: 'Alice' });

  const putLogs = lines.filter((l) => l.msg.includes('put_attribute'));
  assert.ok(putLogs.length > 0, '应记录属性写入');
  assert.match(putLogs[0].msg, /路径: Root\.User\['u1'\]/);
});

test('APL 日志含耗时信息', () => {
  const { lines, writer, level } = collectLogs();
  const client = new Client({ apl: { level, writer } });
  client.defineClass('User', { name: 'string' });
  client.put("Root.User['u1']", { name: 'Alice' });

  assert.ok(lines.some((l) => /耗时: [\d.]+ms/.test(l.msg)));
});

test('APL 在 includeSql 时输出 SQL 与参数', () => {
  const { lines, writer, level } = collectLogs();
  const client = new Client({ apl: { level, writer, includeSql: true } });
  client.defineClass('User', { name: 'string' });
  client.put("Root.User['u1']", { name: 'Alice' });

  assert.ok(lines.some((l) => /SQL: .*INSERT/i.test(l.msg)));
});

test('APL 对未注册属性输出 warn 而非静默吞掉', () => {
  const { lines, writer } = collectLogs('warn');
  const client = new Client({ apl: { level: 'warn', writer } });
  client.defineClass('User', { name: 'string', age: 'int' });
  client.put("Root.User['u1']", { name: 'Alice' });

  const helper = new DBHelper(client);
  helper.where('User', { age: '> 1', nickname: 'ghost' });

  const warn = lines.find((l) => l.level === 'warn');
  assert.ok(warn, '应输出 warn');
  assert.match(warn.msg, /忽略未定义的条件属性: nickname/);
});

test('APL 错误日志含失败路径与层级', () => {
  const { lines, writer } = collectLogs('error');
  const client = new Client({ apl: { level: 'error', writer } });
  client.defineClass('User', { name: 'string' });

  client.apl.error({
    path: "Root.User['u1'].Post",
    layer: 'Post',
    op: 'put',
    message: '模拟失败',
  });

  const err = lines.find((l) => l.level === 'error');
  assert.match(err.msg, /^\[APL-ERROR\]/);
  assert.match(err.msg, /失败路径: Root\.User\['u1'\]\.Post/);
  assert.match(err.msg, /层级: Post/);
});

test('APL 缓冲条目可供程序化检索', () => {
  const client = new Client({ apl: { level: 'debug' } });
  client.defineClass('User', { name: 'string' });
  client.put("Root.User['u1']", { name: 'Alice' });

  const entries = client.apl.dump();
  assert.ok(entries.length > 0);
  assert.ok(entries.some((e) => e.op === 'upsert_index'));
  client.apl.clear();
  assert.strictEqual(client.apl.dump().length, 0);
});

test('APL 可用级别字符串快捷开启', () => {
  const client = new Client({ apl: 'debug' });
  client.defineClass('User', { name: 'string' });
  client.put("Root.User['u1']", { name: 'Alice' });
  assert.ok(client.apl.dump().length > 0);
});
