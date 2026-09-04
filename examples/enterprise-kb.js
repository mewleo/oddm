'use strict';

/**
 * ODDM 企业多人知识库 —— 端到端示例（草案 v0）
 *
 * ⚠️ 本示例沿用了 docs/企业知识库设计.md 的草案 v0 假设（核心实体、字段定义、
 *    权限位掩码、租户策略等）。方案未定稿前，不要把本文件当作产品规范。
 *
 * 运行：node examples/enterprise-kb.js
 *
 * 演示 v0.3.1 的全部新增能力：
 *   - 多用户 / 多租户（Organization -> User）
 *   - 树状文档（Post -> Block）
 *   - ref / refs 属性（自动包成 LazyRef / CollectionProxy）
 *   - createChild / findChild 层级便捷方法
 *   - Query DSL（链式 where / order / limit / page）
 *   - Helper.createCollectionView + views.queryObjects
 *   - 版本演进（defineClass V2.0 + Client.migrate）
 *   - APL 日志输出（AI 可消费的寻址路径日志）
 *   - introspect() 全文快照
 */

const { Client, DBHelper } = require('../src/oddm');

// =============================================================
// 0. 启动 —— 内存库、调试日志、AI 友好的寻址路径日志
// =============================================================

const aplLogs = [];
const aplWriter = {};
for (const name of ['error', 'warn', 'info', 'debug']) {
  aplWriter[name] = (m) => aplLogs.push(m);
}

const client = new Client({
  path: ':memory:',
  apl: { level: 'info', writer: aplWriter, includeSql: false },
  identityMap: true, // 演示可选用身份映射
});
const helper = new DBHelper(client);

function section(t) {
  console.log('\n=== ' + t + ' ===');
}

// =============================================================
// 1. 注册 Schema —— 组织 / 用户 / 文档 / 块 / 评论 / 标签
// =============================================================

section('1. 注册 Schema');

client.defineClass('Organization', {
  name:        'string',
  plan:        'string',
  description: 'string',
  created_at:  'datetime',
});

client.defineClass('User', {
  name:      'string',
  email:     'string',
  role:      'string',   // admin / editor / viewer
  joined_at: 'datetime',
});

// 继承示例：Admin 是 User 的子类，复用 User 的物理表
client.defineClass(
  'Admin',
  { level: 'int', scope: 'string' },         // Admin 特有字段
  '1.0',
  { parentClass: 'User' }
);

client.defineClass('Post', {
  title:      'string',
  body:       'json',
  status:     'string',    // draft / published / archived
  author:     'ref',
  org:        'ref',
  tags:       'refs',
  permission: 'int',
  created_at: 'datetime',
  updated_at: 'datetime',
});

client.defineClass('Block', {
  type:    'string',     // heading / paragraph / list / code / quote / image
  content: 'json',
  order:   'int',
  post:    'ref',
  author:  'ref',
});

client.defineClass('Comment', {
  body:       'string',
  author:     'ref',
  target:     'ref',      // 指向 Post 或 Block
  parent:     'ref',      // 二级评论
  created_at: 'datetime',
});

client.defineClass('Tag', {
  name:  'string',
  color: 'string',
  org:   'ref',
});

console.log('已注册类:',
  client.introspect().classes.map(c => c.className).join(', '));

// =============================================================
// 2. 创建组织 + 用户（使用 createChild 一步完成挂载 + 集合视图登记）
// =============================================================

section('2. 创建组织与用户');

client.createChild('Organization', 'acme', 'User', 'alice', {
  name: 'Alice', email: 'alice@acme.com', role: 'editor', joined_at: new Date('2025-01-15'),
});
client.createChild('Organization', 'acme', 'User', 'bob', {
  name: 'Bob', email: 'bob@acme.com', role: 'viewer', joined_at: new Date('2025-03-22'),
});
client.createChild('Organization', 'acme', 'User', 'carol', {
  name: 'Carol', email: 'carol@acme.com', role: 'editor', joined_at: new Date('2025-06-01'),
});

// Admin（继承自 User）—— 物理上仍写在 User_V1_0 表，靠 __class__ 列区分
client.createChild('Organization', 'acme', 'Admin', 'dora', {
  name: 'Dora', email: 'dora@acme.com', role: 'admin',
  joined_at: new Date('2024-09-09'),
  level: 9, scope: 'global',
});

console.log('acme 的子节点:', helper.children('Organization/acme'));
console.log('alice 的全路径:', helper.canonicalPath('User/alice'));
console.log('dora 反解:', helper.canonicalPath('Admin/dora'),
  '(物理表 User_V1_0, __class__=Admin)');

// findChild：精确父子校验，跨父节点误用返回 null
const wrongParent = client.findChild('Organization', 'evil-corp', 'User', 'alice');
console.log('跨组织 findChild(alice):', wrongParent); // 应为 null

// =============================================================
// 3. 创建标签 + 文档 + 块（ref / refs 自动包装为 LazyRef / CollectionProxy）
// =============================================================

section('3. 标签 + 文档 + 块');

client.createChild('Organization', 'acme', 'Tag', 'tech', {
  name: '技术', color: '#1677ff', org: 'Organization/acme',
});
client.createChild('Organization', 'acme', 'Tag', 'design', {
  name: '设计', color: '#52c41a', org: 'Organization/acme',
});

// 文档 1：alice 的设计文档
client.createChild('User', 'alice', 'Post', 'doc-1', {
  title:      'ODDM 设计方案',
  body:       { type: 'doc', content: [] },
  status:     'published',
  author:     'User/alice',
  org:        'Organization/acme',
  tags:       ['Tag/tech', 'Tag/design'],
  permission: 2,                  // 仅组织内可见
  created_at: new Date(),
  updated_at: new Date(),
});

// 块（挂在 doc-1 下）
const blocks = [
  { type: 'heading',   content: { level: 1, text: '引言' },           order: 0 },
  { type: 'paragraph', content: { text: 'ODDM 是对象数据库' },         order: 1 },
  { type: 'code',      content: { lang: 'js', code: 'const c = new Client();' }, order: 2 },
  { type: 'list',      content: { items: ['面向对象', '路径寻址', 'AI 友好'] }, order: 3 },
];
for (const b of blocks) {
  client.createChild('User', 'alice', 'Block', `b${b.order}`, {
    ...b, post: 'Post/doc-1', author: 'User/alice',
  });
}

// 文档 2：alice 的草稿
client.createChild('User', 'alice', 'Post', 'doc-2', {
  title:      '（草稿）权限模型',
  body:       { type: 'doc', content: [] },
  status:     'draft',
  author:     'User/alice',
  org:        'Organization/acme',
  tags:       [],
  permission: 2,
  created_at: new Date(),
  updated_at: new Date(),
});

// 文档 3：bob 的入门文档
client.createChild('User', 'bob', 'Post', 'doc-3', {
  title:      '新人入门手册',
  body:       { type: 'doc', content: [] },
  status:     'published',
  author:     'User/bob',
  org:        'Organization/acme',
  tags:       ['Tag/design'],
  permission: 1,                  // 公开
  created_at: new Date(),
  updated_at: new Date(),
});

const doc1 = client.get('Post/doc-1');
console.log('doc-1 title:', doc1.title);
console.log('doc-1 author (LazyRef):', doc1.author.toString(),
  '→ 通过 Proxy 自动加载，访问属性即触发:', doc1.author.name);
console.log('doc-1 tags (CollectionProxy):', doc1.tags.toString(), '→ count =', doc1.tags.length);

// =============================================================
// 4. 评论 —— 引用 target / parent，演示二级评论
// =============================================================

section('4. 评论');

client.put("Root.Organization['acme'].User['bob'].Comment['c1']", {
  body: '写得真好，期待 ODDM 0.4',
  author: 'User/bob',
  target: 'Post/doc-1',
  parent: null,
  created_at: new Date(),
});
client.put("Root.Organization['acme'].User['carol'].Comment['c2']", {
  body: '同意，特别是 ref / refs 自动包装这点。',
  author: 'User/carol',
  target: 'Post/doc-1',
  parent: 'Comment/c1',
  created_at: new Date(),
});

console.log('doc-1 下的评论数（按 target 查询）:',
  client.Comment.where({ target: 'Post/doc-1' }).count());

// =============================================================
// 5. Query DSL —— 链式 where / order / limit / page
// =============================================================

section('5. Query DSL');

const published = client.Post.where({ status: 'published' }).toArray();
console.log('已发布文档:', published.map(p => p.title));

const aliceDocs = client.Post
  .where({ author: 'User/alice' })
  .order({ title: 'asc' })
  .toArray();
console.log('alice 的文档（按标题升序）:', aliceDocs.map(p => p.title));

// 复合条件（注意：当前 Query DSL 对 `refs` 字段的「数组包含」过滤还未支持，
// 需借助 helper.query() 写原生 SQL，或在 v0.3.2 引入 `$contains` 操作符）
const techDocs = client.Post.where({
  status: 'published',
  author: 'User/alice',
}).count();
console.log('alice 名下已发布文档数:', techDocs);

// 迭代
console.log('所有 User:');
for (const u of client.User.all()) {
  console.log('  -', u.name, '/', u.role);
}

// =============================================================
// 6. 集合视图 —— 固化常用查询
// =============================================================

section('6. 集合视图');

// createChild 已经为 User_alice_Posts 自动登记了集合视图
console.log('视图 User_alice_Posts 的查询结果:',
  client.views.queryObjects('User_alice_Posts').map(p => p.title));

// 显式再建一个：注意 Posts 在我们的拓扑里是挂在 User 下而非 Organization 下，
// 所以 Organization_acme_Posts 视图返回 0 个 —— 这是拓扑的真实表达，不是 bug。
// 整组织可见的 Post 应该走递归遍历（Helper.descendants）或自定义 SQL：
client.helper.createCollectionView('Organization', 'acme', 'Post');
const directUnderOrg = client.views.queryObjects('Organization_acme_Posts');
console.log('Organization 直挂 Post:', directUnderOrg.length, '（预期 0，Post 都挂在 User 下）');

const orgDescendants = helper.descendants('Organization/acme');
const allOrgPosts = orgDescendants.filter(n => n.class_name === 'Post');
console.log('整组织可见的 Post (递归子树, 数量):', allOrgPosts.length);

// 视图路由表
console.log('已注册视图:', client.helper.routes().map(r => r.name));

// =============================================================
// 7. 版本演进 —— V1.0 → V2.0，保留 created_at，可选 transform
// =============================================================

section('7. 版本演进');

// 注册 V2.0 Post：新增 pinned 字段
client.defineClass('Post', {
  title:      'string',
  body:       'json',
  status:     'string',
  author:     'ref',
  org:        'ref',
  tags:       'refs',
  permission: 'int',
  created_at: 'datetime',
  updated_at: 'datetime',
  pinned:     'boolean',   // 新增
}, '2.0');

const before = client.meta$('Post/doc-1').__created_at__;
const migrated = client.migrate('Post', '1.0', '2.0', (ent) => ({
  ...ent,
  pinned: false,
}));
console.log(`已迁移 ${migrated} 条 Post 到 V2.0`);
console.log('doc-1 现在:',
  JSON.stringify(client.get('Post/doc-1'), (k, v) =>
    v && typeof v === 'object' && v.__ref ? `[ref:${v.__ref}]` : v));
console.log('doc-1 created_at 保留:',
  +client.meta$('Post/doc-1').__created_at__ === +before);

// =============================================================
// 8. introspect() —— 给 AI Agent 的全文快照
// =============================================================

section('8. introspect()');

const snap = client.introspect({ treeDepth: 3, includeSample: true });
console.log('已注册类:', snap.classes.map(c =>
  `${c.className}@${c.version} (${c.instanceCount} 实例)`).join(', '));
console.log('视图:', snap.views.map(v => v.name).join(', '));
console.log('统计:', snap.stats);

// =============================================================
// 9. 清理 + 总结
// =============================================================

section('9. APL 日志样本（最后 5 条）');

aplLogs.slice(-5).forEach(line => console.log('  ', line));

console.log('\n=== 示例结束 ===');
console.log('提示：把上面的 client.introspect() 输出喂给 AI Agent，');
console.log('     Agent 即可无 schema 知识地开始操作这个知识库。');
