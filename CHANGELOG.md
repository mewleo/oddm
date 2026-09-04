# ODDM 变更记录

## [0.3.1] - 2026-09-04 —— 面向 Ruby v0.3.1 的特性对齐

以《版本对比 js与ruby》的结论为依据：**Node v0.2.0 保留 APL / introspect 等 AI 友好特性（灵魂层），
把 Ruby 的面向对象能力（LazyRef / CollectionProxy / Query DSL / 继承 / 视图 / Helper）移植过来**。
新增 `migrate`（版本数据迁移）、`createChild`/`findChild`（层级便捷方法）、可选用身份映射、
`Helper.createCollectionView` 等关键能力，使 Node 版本与 Ruby v0.3.1 在公开语义层基本对齐。

测试从 89 项扩展为 106 项，全绿。

### 新增能力

- **`Client.migrate(className, fromVersion, toVersion, transform?)`**
  对齐 Ruby `Root#migrate`。把 `fromVersion` 表里所有对象搬到 `toVersion` 表，
  在事务内执行；可选 `transform(attributes, meta) => newAttrs` 回调用于字段重塑，
  默认保留新旧 schema 的属性交集。`__created_at__` 透传保留原始创建时间，
  迁移完成后清理源表的孤儿属性行。返回迁移对象数。
- **`Client.createChild(parentClass, parentKey, childClass, childKey, attributes?)`**
  对齐 Ruby `Root#create_child`。一步完成"父节点挂子节点 + 自动登记集合视图路由
  （生成 Node 安全标识符的 SQL view，可被 `queryObjects` 直接查询）"。
- **`Client.findChild(parentClass, parentKey, childClass, childKey)`**
  对齐 Ruby `Root#find_child`。校验父子关系是否一致，不匹配返回 `null`
  （Ruby 返回 `nil`，避免对调用方抛错）。
- **`ClassScope.createChild / findChild`** —— `db.User.createChild('apanda', 'Post', 'p1', {...})` 风格调用。
- **`Client.identityMap` 选项** —— 默认关闭，开启后：
  - `get(key)` 命中缓存时返回同一引用，避免在循环中重复反序列化。
  - `put` / `dbHelper.destroy` 写入成功后自动失效对应键。
  - `dbHelper.transaction` 提交或回滚后清空整个缓存，保证跨事务拿到的是新快照。
  - `get(key, { fresh: true })` 可绕过缓存。
  - `client.clearIdentityMap()` 手动清空。
- **`Helper.createCollectionView(parentClass, parentName, childClass)`**
  对齐 Ruby `Helper#create_collection_view`，与 `createChild` 内部使用同一路径。
- **`ViewManager.registerCollection` 真正生成 SQL view**
  之前仅为"路由登记"，无实际 DDL。v0.3.1 起会创建一张过滤 `oddm_root_index`
  （按 `parent_name` + `class_name`）的轻量视图，可直接被 `queryObjects` 查询。

### 内部改进

- **`Repository.saveObject` 支持 `createdAt` 透传**
  旧版本无差别覆写 `__created_at__`，迁移时丢失原始创建时间。
  现在显式传入时以传入值为准，否则仍按"首次写定、永不改写"的原规则。
- **`Repository.deleteAttributeRows` 新增**
  仅删除 EAV 行的方法，不动 `oddm_root_index`。供 `migrate` 在搬表后清理孤儿属性。
- **`Client.dbHelper.transaction` 增加事务深度追踪**
  仅在最外层事务提交/回滚时清空身份映射缓存，避免嵌套事务里误清空。
- **`File-Header` 版本号统一升至 `v0.3.1`**，与 `package.json` / `constants.VERSION` 三处保持一致。

### 与 Ruby v0.3.1 的语义差异（有意保留）

| 能力 | Node v0.3.1 | Ruby v0.3.1 | 说明 |
| --- | --- | --- | --- |
| `Query` | SQL 下推到 SQLite（`MAX(CASE WHEN…)`、`HAVING COUNT(DISTINCT attribute_name)`） | 内存过滤 | 节点走 SQL 下推以利用 EAV 索引；Ruby 因 ORM 选型保持内存过滤 |
| 集合视图名 | 标识符白名单强制 | `User:apanda:Posts` 等带冒号 | Node 视图名要拼进 DDL，必须白名单 |
| `find_by_name` | 返回 `null` | 返回 `nil` | 同一意图，不同语言习惯 |
| 身份映射 | 默认关闭、可选启用 | 默认开启 | Node 默认关闭以不破坏既有"每次 get 都是新快照"语义 |

---

## [0.3.0] - 2026-09-03 —— OOP 特性全面对齐 Ruby v0.3.x

把 Ruby 已实现的「类范围 / 懒引用 / 集合代理 / 查询 DSL / 继承 / 视图 / 辅助类」全套移植过来。
本次不引入新的存储层，全部仍以 SQLite 为底层。

### 新增模块

- **`src/classscope.js`** —— `ClassScope`，对齐 Ruby `ClassScope`：
  `find / findOrFail / create / put / update / touch / destroy / exists / meta /
  all / objectNames / where / order / limit / page / count / children / ancestors /
  descendants / query / queryObjects / transaction / createChild / findChild`。
  通过 `db.User` 代理访问。
- **`src/query.js`** —— 查询 DSL，SQL 下推实现（与 Ruby 的内存过滤不同）：
  `where / order / limit / offset / page` 可链式调用；
  终端方法 `objectNames / toArray / count / first / last / map / filter / [Symbol.iterator]`。
  支持 `$gte` / `$lte` / `$gt` / `$lt` / `$ne` / `$in` / `$exists` / 正则 / 数组 BETWEEN。
- **`src/lazyref.js`** —— `LazyRef`，对齐 Ruby `LazyRef`：`get()` 按需加载，
  `toString()` 展示物理标识，未加载前属性访问抛 `LazyRefNotLoadedError`。
- **`src/helper.js`** —— `Helper` 类，对齐 Ruby `Helper`：6 个方法模块
  （特殊对象 / 视图 / 根路由 / 类管理 / DB 信息 / 便捷方法）。
- **`src/views.js`** —— 视图管理器，对齐 Ruby `create_view / drop_view / query_objects`，
  支持 `object / collection / custom` 三种视图类型 + DDL 注入防护。
- **`src/constants.js`** —— 集中常量（`SYS_TABLE` / `SYS_ATTR` / `VIEW_TYPE` /
  `QUERY_OP` / `OP_TO_SQL` / `VERSION` / `FILE_HEADER` / `AUTHOR`）。

### 核心能力

- **类继承**：`defineClass('Admin', {...}, '1.0', { parentClass: 'User' })`。
  Admin 对象复用 User 的物理表，靠 `__class__` 列做多态。
- **`ref` / `refs` 属性**：自动包装为 `LazyRef` / `CollectionProxy`。
- **`Client.introspect()` 与 `introspectClass()`**：v0.2.0 已有，v0.3.0 扩展至含视图、视图路由、引用关系。
- **`APL` 寻址路径日志**：保留并细化，按层级、操作、耗时三维度。

### 测试

`node --test tests/*.test.js` —— 89 项全绿（v0.3.0 起新增 query / classscope / introspect / tree 用例）。

---

## [0.2.0] - 2026-09-01 —— JS 实现工程化改造

以 `oddm_beta.js` 为基础重构为可测试、可维护、可被 AI 工具链消费的实现。
原 `oddm_beta.js` / `.py` / `.rb` 保留为历史参考，不再改动。

### 目录结构

```
src/
  errors.js      错误体系（带 path / layer / sql 上下文）
  apl.js         APL 寻址路径日志
  naming.js      标识符白名单、表名构造、类型编解码
  schema.js      Schema（建表 + 索引）、MetaClassManager（实例级缓存）
  path.js        PathParser、TreeNavigator（递归 CTE）
  repository.js  物理读写，带 APL 包装
  client.js      Client、DBHelper
  oddm.js        统一导出
tests/           node:test 测试套件（89 项）
bin/oddm.js      CLI：inspect / classes / path
examples/demo.js 端到端演示
```

### 修复的缺陷

**P0-1 用物理名写入会重置父节点**
`put("Post/p2", …)` 或 `updateDiff("Post/p2", …)` 会把节点从原父级重挂到 Root。
根因：`saveObject` 的 upsert 覆写了 `parent_name`。
修复：冲突时只更新 `class_name` / `version`，拓扑变更一律走 `moveTo`。
这是原实现对非根节点做差量更新必然踩中的坑，测试脚本只演示根节点所以没暴露。

**P0-2 schema 缓存进程级共享**
`MetaClassManager._schemaCache` 是类静态字段，多个 Client 指向不同数据库时会串 schema。
修复：缓存降为实例级，每个 Client 持有独立的 MetaClassManager。

**P0-3 路径中间节点不进入拓扑索引（新发现）**
`put("Root.User['u1'].Post['p1']", …)` 只登记末端节点，中间层不入库，
导致 `ancestors` / `resolveCanonicalPath` 在中间层断链，反解不出完整路径。
修复：写入前为路径上的中间节点补建占位记录，版本取该类已注册的最新版本。

**P1-1 where 的 HAVING 计数错误**
用 `conditions` 总数而非实际生成的子句数做 `HAVING COUNT(DISTINCT attribute_name)`，
一旦混入未注册属性就永远匹配不上，静默返回空数组。
修复：改用子句数；全部条件均未定义时改为明确报错，部分未定义时 warn 并继续。

**P1-2 条件值未显式转型**
`"> 30"` 解析出的 `"30"` 原样绑定为 TEXT，依赖 SQLite 隐式亲和性，
数值与字典序语义会在边界情况下分叉。
修复：`where` 按 schema 显式转型，非法字面量报 `ODDM_TYPE_ERROR`。

**P1-3 表名字符串插值存在注入面**
`class_name` 未校验即拼进 DDL/DML。
修复：新增标识符白名单（`^[A-Za-z_][A-Za-z0-9_]*$`）与版本号校验。

**P1-4 moveTo 缺少环检测（新发现）**
把节点挂到自身后代下会形成环，使递归 CTE 失控。
修复：`moveTo` 前置 `isSelfOrDescendant` 检测，并校验重挂载后的子树深度。

**P2-1 schema 外属性静默丢弃**
修复：默认 strict 模式直接报错；可按需传 `{ strict: false }`，跳过项记入 `result.skipped`。

**P2-2 物理名写入引发版本分裂**
用物理名 `put` 时使用传入 version（默认 1.0），会把已存在的 V2.0 对象改写成 V1.0。
修复：已存在对象沿用索引中记录的版本，只有显式 `migrate: true` 才允许改写。

**P2-3 缺索引**
`oddm_root_index.parent_name` 与属性表的 `(attribute_name, v_xxx)` 均无索引，
递归遍历与条件查询全部退化为全表扫描。修复：建表时一并创建。

**P2-4 属性类型变更后旧值残留**
原实现只 UPDATE 目标列，其他类型列不清空。
修复：属性写入改为覆盖全部六个类型列的 UPSERT，写入幂等。

### 新增能力

- **`introspect()`** —— 全库自省快照：已注册类、schema、列映射、实例数、示例 ODL 路径、示例对象、对象树概要、统计信息。对应概念文档 6.2 节承诺的「元对象自省接口」，此前未实现。
- **`introspectClass(name, version)`** —— 单类详情，标注每个属性支持哪些比较运算。
- **APL 寻址路径日志** —— 每条 SQL 携带 ODL 路径、操作类型、耗时；失败时输出 `[APL-ERROR] 失败路径: … | 层级: …`，与概念文档 6.2 节一致。默认关闭，可注入 writer。
- **错误体系** —— `ODDMError` 及 8 个子类，携带 `path` / `layer` / `sql`，带 `ODDM_*_ERROR` 错误码。
- **`TreeNavigator.ancestors` / `resolveCanonicalPath` / `depthOf`** —— JS 版此前缺失。
- **`DBHelper.siblings` / `canonicalPath` / `ancestors` / `descendants`** —— 补齐导航 API。
- **深度限制** —— `maxDepth`（默认 10，对齐概念文档），`put` 与 `moveTo` 双向校验。
- **CLI** —— `inspect` / `classes` / `path`，`--json` 输出可直接喂给工具链。

### 测试

89 项 `node:test` 用例，覆盖路径解析、类型往返、拓扑不变式、条件查询、
多库隔离、注入防护、版本语义、自省与日志。其中 P0/P1 缺陷各有一到多条回归用例，
命名以 `[P0-1]` 等形式标注，便于定位原委。

运行：`npm test`　演示：`npm run demo`
