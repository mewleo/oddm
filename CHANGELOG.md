# ODDM 变更记录

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
