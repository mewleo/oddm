'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { PathParser, ODDMPathError } = require('../src/oddm');

test('解析单段路径', () => {
  const nodes = PathParser.parse("Root.User['apanda']");
  assert.strictEqual(nodes.length, 2);
  assert.strictEqual(nodes[1].object_name, 'User/apanda');
  assert.strictEqual(nodes[1].class_name, 'User');
  assert.strictEqual(nodes[1].key, 'apanda');
  assert.strictEqual(nodes[1].parent_name, 'Root');
});

test('解析多段路径并逐段推导父节点', () => {
  const nodes = PathParser.parse("Root.User['apanda'].Post[5].Comments[0]");
  assert.deepStrictEqual(
    nodes.map((n) => n.object_name),
    ['Root', 'User/apanda', 'Post/5', 'Comments/0']
  );
  assert.deepStrictEqual(
    nodes.map((n) => n.parent_name),
    [null, 'Root', 'User/apanda', 'Post/5']
  );
});

test('支持单引号、双引号与裸数字三种 key 写法', () => {
  assert.strictEqual(PathParser.extractTarget("Root.User['a']").key, 'a');
  assert.strictEqual(PathParser.extractTarget('Root.User["b"]').key, 'b');
  assert.strictEqual(PathParser.extractTarget('Root.User[123]').key, '123');
});

test('key 中含特殊字符不破坏解析', () => {
  const node = PathParser.extractTarget("Root.Post['a-b_c.1']");
  assert.strictEqual(node.object_name, 'Post/a-b_c.1');
  assert.strictEqual(node.key, 'a-b_c.1');
});

test('extractTarget 返回末段节点', () => {
  const target = PathParser.extractTarget("Root.User['a'].Post[1]");
  assert.strictEqual(target.object_name, 'Post/1');
  assert.strictEqual(target.parent_name, 'User/a');
});

test('纯 Root 路径返回单节点', () => {
  const nodes = PathParser.parse('Root');
  assert.strictEqual(nodes.length, 1);
  assert.strictEqual(nodes[0].object_name, 'Root');
});

test('不以 Root 开头应报错', () => {
  assert.throws(() => PathParser.parse("User['a']"), ODDMPathError);
  assert.throws(() => PathParser.parse("user['a']"), ODDMPathError);
});

test('空路径与非法类型应报错', () => {
  assert.throws(() => PathParser.parse(''), ODDMPathError);
  assert.throws(() => PathParser.parse(null), ODDMPathError);
  assert.throws(() => PathParser.parse(undefined), ODDMPathError);
});

test('末端属性访问给出明确的不支持提示', () => {
  assert.throws(
    () => PathParser.parse("Root.User['a'].name"),
    (err) => err instanceof ODDMPathError && /无法解析的路径片段/.test(err.message)
  );
});

test('缺少 key 的路径段应报错', () => {
  assert.throws(() => PathParser.parse('Root.User[]'), (err) =>
    /无法解析的路径片段/.test(err.message)
  );
});

test('只有 Root 前缀但无对象段应报错', () => {
  assert.throws(() => PathParser.parse('Root.User'), (err) =>
    /无法解析的路径片段/.test(err.message)
  );
});

test('toSegment 由物理标识还原路径段', () => {
  assert.strictEqual(PathParser.toSegment('User/apanda'), ".User['apanda']");
});
