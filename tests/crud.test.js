'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Client, DBHelper, ODDMValidationError, ODDMNotFoundError, ODDMTypeError } = require('../src/oddm');

function fixture() {
  const client = new Client();
  const helper = new DBHelper(client);
  client.defineClass('User', { name: 'string', age: 'int', score: 'float', tags: 'json' });
  client.defineClass('Post', { title: 'string', published: 'boolean', createdAt: 'datetime' });
  return { client, helper };
}

test('写入并读回强类型对象', () => {
  const { client } = fixture();
  client.put("Root.User['u1']", { name: 'Alice', age: 35, score: 95.5, tags: ['a', 'b'] });

  const data = client.get("Root.User['u1']");
  assert.strictEqual(data.name, 'Alice');
  assert.strictEqual(data.age, 35);
  assert.strictEqual(data.score, 95.5);
  assert.deepStrictEqual(data.tags, ['a', 'b']);
});

test('物理标识与 ODL 路径等价寻址', () => {
  const { client } = fixture();
  client.put("Root.User['u1']", { name: 'Alice' });
  assert.deepStrictEqual(client.get('User/u1'), client.get("Root.User['u1']"));
});

test('六种类型往返正确', () => {
  const { client } = fixture();
  const now = new Date('2026-09-01T12:00:00.000Z');
  client.put("Root.Post['p1']", { title: 'hello', published: true, createdAt: now });

  const data = client.get('Post/p1');
  assert.strictEqual(data.title, 'hello');
  assert.strictEqual(data.published, true);
  assert.ok(data.createdAt instanceof Date);
  assert.strictEqual(data.createdAt.toISOString(), now.toISOString());
});

test('布尔 false 不被当作空值丢失', () => {
  const { client } = fixture();
  client.put("Root.Post['p1']", { title: 'x', published: false });
  assert.strictEqual(client.get('Post/p1').published, false);
});

test('读取不存在的对象返回 null', () => {
  const { client } = fixture();
  assert.strictEqual(client.get("Root.User['nobody']"), null);
});

test('对未登记的物理标识写入应报错', () => {
  const { client } = fixture();
  assert.throws(() => client.put('User/ghost', { name: 'x' }), ODDMNotFoundError);
});

test('未注册的类写入应报错', () => {
  const client = new Client();
  assert.throws(() => client.put("Root.Ghost['g1']", { a: 1 }), ODDMValidationError);
});

test('strict 模式下 schema 外属性直接报错', () => {
  const { client } = fixture();
  assert.throws(
    () => client.put("Root.User['u1']", { name: 'a', nickname: 'x' }),
    (err) => err instanceof ODDMValidationError && /schema 中定义/.test(err.message)
  );
});

test('非 strict 模式跳过未声明属性并记录到 skipped', () => {
  const { client } = fixture();
  const result = client.put("Root.User['u1']", { name: 'a', nickname: 'x' }, { strict: false });
  assert.deepStrictEqual(result.written, ['name']);
  assert.deepStrictEqual(result.skipped, ['nickname']);
  assert.strictEqual(client.get('User/u1').nickname, undefined);
});

test('int 字段不接受小数', () => {
  const { client } = fixture();
  assert.throws(() => client.put("Root.User['u1']", { age: 3.5 }), ODDMTypeError);
});

test('datetime 不接受无法解析的字符串', () => {
  const { client } = fixture();
  assert.throws(
    () => client.put("Root.Post['p1']", { createdAt: 'not-a-date' }),
    ODDMTypeError
  );
});

test('重复写入同一属性为幂等覆盖', () => {
  const { client } = fixture();
  client.put("Root.User['u1']", { name: 'Alice', age: 35 });
  client.put("Root.User['u1']", { name: 'Bob' });
  const data = client.get('User/u1');
  assert.strictEqual(data.name, 'Bob');
  assert.strictEqual(data.age, 35);
});

test('属性类型变更后旧类型列被清空', () => {
  const client = new Client();
  client.defineClass('Doc', { value: 'int' });
  client.put("Root.Doc['d1']", { value: 42 });
  assert.strictEqual(client.get('Doc/d1').value, 42);

  client.defineClass('Doc', { value: 'string' });
  client.put("Root.Doc['d1']", { value: 'forty-two' });
  const data = client.get('Doc/d1');
  assert.strictEqual(data.value, 'forty-two');
});

test('updateDiff 仅写入变化字段', () => {
  const { client, helper } = fixture();
  client.put("Root.User['u1']", { name: 'Alice', age: 35, score: 95.5 });

  const changed = helper.updateDiff('User/u1', { name: 'Alice', age: 35, score: 99 });
  assert.strictEqual(changed, true);
  assert.strictEqual(client.get('User/u1').score, 99);

  const again = helper.updateDiff('User/u1', { name: 'Alice', age: 35, score: 99 });
  assert.strictEqual(again, false);
});

test('updateDiff 对 json 字段做深比较', () => {
  const { client, helper } = fixture();
  client.put("Root.User['u1']", { tags: ['a', 'b'] });
  assert.strictEqual(helper.updateDiff('User/u1', { tags: ['a', 'b'] }), false);
  assert.strictEqual(helper.updateDiff('User/u1', { tags: ['a', 'c'] }), true);
  assert.deepStrictEqual(client.get('User/u1').tags, ['a', 'c']);
});

test('updateDiff 对 Date 按时间戳比较', () => {
  const { client, helper } = fixture();
  const t = new Date('2026-01-01T00:00:00.000Z');
  client.put("Root.Post['p1']", { createdAt: t });
  assert.strictEqual(
    helper.updateDiff('Post/p1', { createdAt: new Date(t.getTime()) }),
    false
  );
  assert.strictEqual(
    helper.updateDiff('Post/p1', { createdAt: new Date('2027-01-01T00:00:00.000Z') }),
    true
  );
});

test('非对象参数被拒绝', () => {
  const { client } = fixture();
  assert.throws(() => client.put("Root.User['u1']", 'not-an-object'), ODDMValidationError);
  assert.throws(() => client.put("Root.User['u1']", [1, 2]), ODDMValidationError);
});
