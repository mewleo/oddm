'use strict';

/**
 * ODDM 演示脚本
 *
 * 运行：npm run demo
 *
 * 覆盖：schema 注册 -> 路径寻址写入 -> 深层自动建链 -> 条件查询 ->
 *       差量更新 -> 拓扑重挂载 -> 级联删除 -> 自省快照 -> APL 日志
 */

const { Client, DBHelper } = require('../src/oddm');

const logs = [];
const writer = {};
for (const name of ['error', 'warn', 'info', 'debug']) {
  writer[name] = (msg) => logs.push(msg);
}

const client = new Client({ apl: { level: 'debug', writer, includeSql: false } });
const helper = new DBHelper(client);

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// 1. 注册元类型
section('1. 注册元类型');
client.defineClass('User', { name: 'string', age: 'int', score: 'float', tags: 'json' });
client.defineClass('Post', { title: 'string', published: 'boolean', createdAt: 'datetime' });
client.defineClass('Comment', { body: 'string' });
console.log('已注册: User / Post / Comment');

// 2. 路径寻址写入，中间节点自动建链
section('2. 路径寻址写入（中间节点自动登记）');
client.put("Root.User['apanda']", {
  name: 'apanda',
  age: 41,
  score: 98.5,
  tags: ['ruby', 'oddm'],
});
client.put("Root.User['apanda'].Post['p1']", {
  title: 'ODDM 设计指南',
  published: true,
  createdAt: new Date(),
});
client.put("Root.User['apanda'].Post['p2']", {
  title: 'SQLite 递归 CTE 优化',
  published: false,
  createdAt: new Date(),
});
// 只写最深层，中间两层自动补建
client.put("Root.User['guest'].Post['p9'].Comment['c1']", { body: '路过' });

console.log('中间节点 User/guest 是否存在:', client.exists('User/guest'));
console.log('深层节点完整路径:', helper.canonicalPath('Comment/c1'));

// 3. 条件查询
section('3. 条件查询（AND 语义，无 JOIN）');
console.log('已发布文章:', helper.where('Post', { published: true }));
console.log('score 在 90~100 的用户:', helper.where('User', { score: [90, 100] }));
console.log('age > 30 且 score > 95:', helper.where('User', { age: '> 30', score: '> 95' }));

// 4. 差量更新 —— 修复后不再破坏父级挂载
section('4. 差量更新（子节点父级保持不变）');
console.log('更新前 children(User/apanda):', helper.children('User/apanda').map((n) => n.object_name));
helper.updateDiff('Post/p1', { title: 'ODDM 设计指南（修订版）', published: true });
console.log('更新后 children(User/apanda):', helper.children('User/apanda').map((n) => n.object_name));
console.log('Post/p1 路径:', helper.canonicalPath('Post/p1'));
console.log('重复更新是否落盘:', helper.updateDiff('Post/p1', { title: 'ODDM 设计指南（修订版）' }));

// 5. 拓扑操作
section('5. 拓扑操作');
console.log('Post/p1 的兄弟:', helper.siblings('Post/p1').map((n) => n.object_name));
helper.moveTo('Post/p2', 'User/guest');
console.log('移动后 Post/p2 路径:', helper.canonicalPath('Post/p2'));

// 环检测
try {
  helper.moveTo('User/guest', 'Comment/c1');
} catch (err) {
  console.log('环检测拦截:', err.code, '-', err.message);
}

// 6. 自省快照（AI/工具链消费入口）
section('6. 自省快照');
const snap = client.introspect({ treeDepth: 3 });
console.log('ODL 语法:', snap.odlSyntax);
console.log('对象总数:', snap.stats.totalObjects, '| 最大深度:', snap.stats.maxDepth);
for (const cls of snap.classes) {
  console.log(
    `  ${cls.className} V${cls.version} -> ${cls.table}` +
      ` | 实例 ${cls.instanceCount} | 示例路径 ${cls.samplePath}`
  );
}
console.log('对象树:', JSON.stringify(snap.tree.nodes.map((n) => n.path)));

// 7. 级联删除
section('7. 级联删除');
helper.destroy('User/guest', { recursive: true });
console.log('删除后 Comment/c1:', client.get('Comment/c1'));
console.log('剩余对象数:', client.introspect().stats.totalObjects);

// 8. APL 日志
section('8. APL 日志（末尾 6 条）');
for (const line of logs.slice(-6)) console.log(' ', line);

client.close();
