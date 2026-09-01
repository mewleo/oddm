'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  Client,
  DBHelper,
  ODDMValidationError,
  ODDMQueryError,
  ODDMTypeError,
} = require('../src/oddm');

function fixture() {
  const client = new Client();
  const helper = new DBHelper(client);
  client.defineClass('User', {
    name: 'string',
    age: 'int',
    score: 'float',
    active: 'boolean',
    tags: 'json',
  });
  return { client, helper };
}

function seedUsers(client) {
  client.put("Root.User['u1']", { name: 'Alice', age: 35, score: 95.5, active: true });
  client.put("Root.User['u2']", { name: 'Bob', age: 25, score: 88.0, active: true });
  client.put("Root.User['u3']", { name: 'Charlie', age: 42, score: 92.0, active: false });
}

// ---------------------------------------------------------------------------
// 基础查询
// ---------------------------------------------------------------------------

test('等值查询', () => {
  const { client, helper } = fixture();
  seedUsers(client);
  assert.deepStrictEqual(helper.where('User', { name: 'Alice' }), ['User/u1']);
});

test('比较操作符 > >= < <= !=', () => {
  const { client, helper } = fixture();
  seedUsers(client);

  assert.deepStrictEqual(helper.where('User', { age: '> 30' }).sort(), ['User/u1', 'User/u3']);
  assert.deepStrictEqual(helper.where('User', { age: '>= 35' }).sort(), ['User/u1', 'User/u3']);
  assert.deepStrictEqual(helper.where('User', { age: '< 30' }), ['User/u2']);
  assert.deepStrictEqual(helper.where('User', { age: '<= 25' }), ['User/u2']);
  assert.deepStrictEqual(helper.where('User', { name: '!= Alice' }).sort(), ['User/u2', 'User/u3']);
});

test('区间查询 BETWEEN', () => {
  const { client, helper } = fixture();
  seedUsers(client);
  assert.deepStrictEqual(helper.where('User', { score: [90, 100] }).sort(), ['User/u1', 'User/u3']);
});

test('多条件为 AND 语义', () => {
  const { client, helper } = fixture();
  seedUsers(client);
  assert.deepStrictEqual(helper.where('User', { age: '> 30', score: '> 95' }), ['User/u1']);
});

test('布尔条件查询', () => {
  const { client, helper } = fixture();
  seedUsers(client);
  assert.deepStrictEqual(helper.where('User', { active: false }), ['User/u3']);
});

test('无匹配返回空数组', () => {
  const { client, helper } = fixture();
  seedUsers(client);
  assert.deepStrictEqual(helper.where('User', { name: 'Nobody' }), []);
});

// ---------------------------------------------------------------------------
// P1-2：条件值显式转型，避免字符串与数值比较的语义漂移
// ---------------------------------------------------------------------------

test('[P1-2] 数值条件按数值语义比较而非字典序', () => {
  const { client, helper } = fixture();
  client.put("Root.User['a']", { age: 35 });
  client.put("Root.User['b']", { age: 8 });

  // 字典序下 "35" > "9" 为假，数值语义下 35 > 9 为真
  assert.deepStrictEqual(helper.where('User', { age: '> 9' }), ['User/a']);
  assert.deepStrictEqual(helper.where('User', { age: '< 9' }), ['User/b']);
});

test('[P1-2] 布尔字面量支持 true/false/1/0 文本', () => {
  const { client, helper } = fixture();
  seedUsers(client);
  assert.deepStrictEqual(helper.where('User', { active: 'false' }), ['User/u3']);
  assert.deepStrictEqual(helper.where('User', { active: 'true' }).sort(), ['User/u1', 'User/u2']);
});

test('[P1-2] 非法字面量给出明确错误', () => {
  const { client, helper } = fixture();
  seedUsers(client);
  assert.throws(() => helper.where('User', { age: '> abc' }), ODDMTypeError);
});

test('json 类型不支持范围比较', () => {
  const { client, helper } = fixture();
  seedUsers(client);
  assert.throws(() => helper.where('User', { tags: '> 1' }), ODDMQueryError);
});

test('稀疏属性对象不会被缺失条件误命中', () => {
  const { client, helper } = fixture();
  client.put("Root.User['rich']", { name: 'Rich', age: 40, score: 1 });
  client.put("Root.User['sparse']", { name: 'Sparse' }); // 无 age

  const hit = helper.where('User', { age: '> 0' });
  assert.deepStrictEqual(hit, ['User/rich']);
});

// ---------------------------------------------------------------------------
// P1-1：条件属性未定义时的行为
// ---------------------------------------------------------------------------

test('[P1-1] 混合已知与未知属性时已知条件仍生效', () => {
  const { client, helper } = fixture();
  seedUsers(client);

  // 原实现用 conditions 总数做 HAVING 计数，此处会永远返回空
  const hit = helper.where('User', { age: '> 30', nickname: 'ghost' });
  assert.deepStrictEqual(hit.sort(), ['User/u1', 'User/u3']);
});

test('[P1-1] 全部条件属性均未定义时明确报错', () => {
  const { client, helper } = fixture();
  seedUsers(client);
  assert.throws(() => helper.where('User', { nickname: 'x' }), (err) => {
    assert.ok(err instanceof ODDMQueryError);
    assert.match(err.message, /未在 schema 中定义/);
    return true;
  });
});

test('未注册的类查询应报错', () => {
  const { helper } = fixture();
  assert.throws(() => helper.where('Ghost', { a: 1 }), ODDMValidationError);
});

// ---------------------------------------------------------------------------
// P0-2：多数据库实例的 schema 隔离
// ---------------------------------------------------------------------------

test('[P0-2] 两个 Client 的 schema 互不干扰', () => {
  const a = new Client();
  a.defineClass('User', { name: 'string' });

  const b = new Client();
  b.defineClass('User', { email: 'string' });

  assert.deepStrictEqual(a.meta.getSchema('User', '1.0'), { name: 'string' });
  assert.deepStrictEqual(b.meta.getSchema('User', '1.0'), { email: 'string' });

  // 若缓存串扰，b 会按 a 的 schema 校验并丢弃 email
  b.put("Root.User['x']", { email: 'e@example.com' });
  assert.deepStrictEqual(b.get('User/x'), { email: 'e@example.com' });
});

test('[P0-2] 同一进程内多库同名类可各自读写', () => {
  const a = new Client();
  a.defineClass('Doc', { title: 'string' });
  a.put("Root.Doc['d']", { title: 'A' });

  const b = new Client();
  b.defineClass('Doc', { count: 'int' });
  b.put("Root.Doc['d']", { count: 7 });

  assert.deepStrictEqual(a.get('Doc/d'), { title: 'A' });
  assert.deepStrictEqual(b.get('Doc/d'), { count: 7 });
});

// ---------------------------------------------------------------------------
// P1-3：标识符白名单（防 SQL 注入）
// ---------------------------------------------------------------------------

test('[P1-3] 非法类名被拒绝', () => {
  const { client } = fixture();
  assert.throws(
    () => client.defineClass('User; DROP TABLE oddm_root_index; --', { a: 'string' }),
    ODDMValidationError
  );
  assert.throws(() => client.defineClass('1User', { a: 'string' }), ODDMValidationError);
  assert.throws(() => client.defineClass('User-Name', { a: 'string' }), ODDMValidationError);
});

test('[P1-3] 非法版本号被拒绝', () => {
  const { client } = fixture();
  assert.throws(
    () => client.defineClass('Doc', { a: 'string' }, '1.0; DROP TABLE oddm_root_index'),
    ODDMValidationError
  );
  assert.throws(() => client.defineClass('Doc', { a: 'string' }, 'v1'), ODDMValidationError);
});

test('[P1-3] 注入尝试后系统表完好', () => {
  const { client } = fixture();
  try {
    client.defineClass('Evil"; DROP TABLE oddm_root_index; --', { a: 'string' });
  } catch (err) {
    /* 预期被拒 */
  }
  const row = client.db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'oddm_root_index'")
    .get();
  assert.strictEqual(row.n, 1);
});

test('非法属性名与类型被拒绝', () => {
  const { client } = fixture();
  assert.throws(() => client.defineClass('Doc', { 'bad-name': 'string' }), ODDMValidationError);
  assert.throws(() => client.defineClass('Doc', { a: 'varchar' }), ODDMValidationError);
});

test('空的 schema 定义被拒绝', () => {
  const { client } = fixture();
  assert.throws(() => client.defineClass('Doc', {}), ODDMValidationError);
});

// ---------------------------------------------------------------------------
// P2-2：物理名写入不改写已登记版本
// ---------------------------------------------------------------------------

test('[P2-2] 用物理名写入不会把对象版本降级', () => {
  const client = new Client();
  client.defineClass('Doc', { v: 'string' }, '2.0');
  client.put("Root.Doc['d1']", { v: 'old' }, { version: '2.0' });

  client.put('Doc/d1', { v: 'new' });

  const row = client.db
    .prepare("SELECT version FROM oddm_root_index WHERE object_name = 'Doc/d1'")
    .get();
  assert.strictEqual(row.version, '2.0', '版本不应被默认 1.0 改写');
  assert.deepStrictEqual(client.get('Doc/d1'), { v: 'new' });
});

test('[P2-2] 显式 migrate 才允许改写版本', () => {
  const client = new Client();
  client.defineClass('Doc', { v: 'string' }, '1.0');
  client.defineClass('Doc', { v: 'string' }, '2.0');
  client.put("Root.Doc['d1']", { v: 'old' }, { version: '1.0' });

  client.put('Doc/d1', { v: 'new' }, { version: '2.0', migrate: true });

  const row = client.db
    .prepare("SELECT version FROM oddm_root_index WHERE object_name = 'Doc/d1'")
    .get();
  assert.strictEqual(row.version, '2.0');
});
