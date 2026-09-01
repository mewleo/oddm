ODDM (Object-Driven Database Model)

“数据之路通万家，地图导航日日新。对象月月守破庙，九皇诞法助我道。” —— 《再继承》

🌌 起源与愿景 (Origin & Vision)

ODDM 的雏形诞生于乙巳年（2025年）九皇诞辰祈福期间。在北斗九星的指引下，我们感悟到了一种新的“法门”：数据不应是被束缚在表格中的死物，而应是沿着神圣路径（Path）自然流转的对象之光。

本项目旨在打破传统关系型数据库的桎梏，接续被主流遗忘的“对象数据库”法统，重建一套更符合直觉、更具灵性的持久化架构。

📜 核心理念 (Core Philosophy)

北斗寻址 (Path Addressing): 所有的对象访问皆有路径，如同星图指引，从 Root 出发，因果相连。

万物归宗 (Single Root): 整个数据库是一个统一的、自洽的有机整体。

九皇之法 (Dynamic Evolution): 利用 Ruby 的元编程（Metaprogramming）实现对象的动态降生与版本演进，法门常新。

🛠 技术蓝图 (Technical Roadmap)

ODL (Object Driven Layer): 使用 Ruby 构建的智能控制层（大脑）。

Data Proxy: 高性能静态语言代理（管道）。

Storage: 结构化 Key-Value 存储（目前以 Redis 为 POC）。

💎 项目奠基

本项目采用 Apache-2.0 协议开源。我们以代码为石，以逻辑为金，在名为“互联网”的土地上，重新修缮那座守望已久的“对象之庙”。

“不问前路，只求此心。根深叶茂，古往今来。”
```
              ( Root )
                  |
         +--------+--------+
         |                 |
  [User_V1.0]        [Config_V1.0]
         |                 |
  /user/apanda/       /config/server/
  |      |      |
  O      O      O    <- Posts[1] Posts[2] Posts[3]
  |      |      |
  +------+------+
  |
  O <- Comments[0]
```

# ODDM (Object Domain Data Model) 驱动框架Beta版本使用指南

本文档专为 AI Coding Agent 快速解析与集成设计。ODDM 是一个基于 ODL（Object Description Language）路径寻址与强类型隔离表构成的无外键树状面向对象数据模型引擎。

---

## 1. 核心架构与概念

* **ODL 路径规范**：格式为 `Root.ClassName['Key'].ChildClass['ChildKey']`。
* 根节点固定为 `Root`。
* 节点物理标识：`ClassName/Key`（如 `User/apanda`、`Post/2`）。


* **黑盒双层架构**：
* **`ODDM::Client`**：核心基础接口，负责 Schema 注册、ODL 路径解析、内存 Cache 管理与底层 CRUD。
* **`ODDM::DBHelper`**：扩展辅助接口，提供事务管理、差量更新（Diff Update）、SQL 条件查询、拓扑调整与级联删除。



---

## 2. 元类型数据映射表

在 `define_class` 注册元类型时，支持以下强类型声明：

| 标识字符串 | Ruby 内部类型 | 数据库存储列 | 示例值 |
| --- | --- | --- | --- |
| `'string'` | `String` | `v_string` | `"apanda"` |
| `'int'` | `Integer` | `v_int` | `41` |
| `'float'` | `Float` | `v_float` | `98.5` |
| `'boolean'` | `TrueClass / FalseClass` | `v_boolean` | `true` |
| `'datetime'` | `Time` | `v_datetime` | `Time.now` |
| `'json'` | `Hash / Array` | `v_json` | `{"tags": ["ruby"]}` |

---

## 3. API 规范速查清单

### `ODDM::Client` (核心门面)

```ruby
# 初始化
client = ODDM::Client.new(':memory:') # 或文件路径 "data.db"

# 1. 注册类定义
client.define_class(class_name, schema_hash, version: "1.0")

# 2. 存入对象（支持 ODL 路径或直接使用物理名称）
client.put(path_or_object_name, attributes_hash, version: "1.0")

# 3. 读取对象（返回包含已转换强类型值的 Hash）
client.get(path_or_object_name)

```

### `ODDM::DBHelper` (高级扩展)

```ruby
helper = ODDM::DBHelper.new(client)

# 1. 显式事务控制
helper.transaction do
  client.put(...)
end

# 2. 差异化增量更新（仅写入变更字段，未变更字段不发 SQL）
helper.update_diff(path_or_object_name, new_attributes_hash)

# 3. 复合条件查询（返回匹配的 object_name 数组）
# 支持操作符: ">", "<", ">=", "<=", "!=", "BETWEEN ... AND ..." (Range)
helper.where(class_name, { "age" => "> 30", "score" => 90.0..100.0 })

# 4. 拓扑调整
helper.children(path_or_object_name)                  # 获取直系一级子节点
helper.siblings(path_or_object_name)                  # 获取同级兄弟节点
helper.move_to(target_path, new_parent_path)          # 节点拓扑重挂载

# 5. 级联清理
helper.destroy(path_or_object_name, recursive: true)  # 递归删除节点及其整个子树

```

---

## 4. 端到端快速集成代码示例

Agent 可直接调用或参考以下完整的可运行代码落地应用逻辑：

```ruby
require 'sqlite3'
require 'json'
require 'time'
# 假定依赖已加载：module ODDM包含 Client 与 DBHelper

# Step 1: 初始化客户端与 DBHelper 助手
client = ODDM::Client.new(':memory:')
db_helper = ODDM::DBHelper.new(client)

# Step 2: 定义领域类元结构 (Schema Definition)
client.define_class("User", {
  "name" => "string",
  "age"  => "int",
  "role" => "string"
})

client.define_class("Order", {
  "amount"    => "float",
  "paid"      => "boolean",
  "created_at"=> "datetime"
})

# Step 3: 结合事务批量构建数据树 (ODL Path Construction)
db_helper.transaction do
  # 创建根用户
  client.put("Root.User['u1001']", {
    "name" => "张三",
    "age"  => 28,
    "role" => "admin"
  })

  # 在用户下挂载订单 (自动推导拓扑树)
  client.put("Root.User['u1001'].Order['ord_9001']", {
    "amount"     => 299.5,
    "paid"       => true,
    "created_at" => Time.now
  })
end

# Step 4: 执行条件检索 (High Performance WHERE)
matched_users = db_helper.where("User", { "age" => "< 30", "role" => "admin" })
# 返回: ["User/u1001"]

# Step 5: 增量更新与只读验证
db_helper.update_diff("User/u1001", { "age" => 29 }) # 仅 age 字段更新
user_data = client.get("User/u1001")
# user_data["age"] => 29

# Step 6: 节点拓扑重挂载与级联清理
db_helper.destroy("Root.User['u1001']", recursive: true) # 清理 user 及其下包含的 order

```

---

# v0.2.0：JavaScript 实现（工程化版本）

JS 实现已完成工程化改造，可测试、可维护，并补齐了概念文档中承诺但此前未落地的
自省接口与 APL 日志。原 `oddm_beta.js` / `.py` / `.rb` 保留为历史参考，不再改动。

```bash
npm install          # 依赖：better-sqlite3
npm test             # 89 项 node:test 用例
npm run demo         # 端到端演示
node bin/oddm.js inspect data.db --json   # 自省快照，可直接喂给工具链
```

## 快速上手

```js
const { Client, DBHelper } = require('./src/oddm');

const client = new Client({ path: 'data.db', apl: 'debug' });
const helper = new DBHelper(client);

client.defineClass('User', { name: 'string', age: 'int', score: 'float' });
client.defineClass('Post', { title: 'string', published: 'boolean' });

// 路径即拓扑：中间节点自动登记，无需外键表
client.put("Root.User['apanda']", { name: 'apanda', age: 41, score: 98.5 });
client.put("Root.User['apanda'].Post['p1']", { title: 'ODDM 指南', published: true });

helper.where('Post', { published: true });        // ['Post/p1']
helper.canonicalPath('Post/p1');                  // "Root.User['apanda'].Post['p1']"
client.introspect();                              // 全库自省快照
```

## 与 Beta 版的行为差异

| 行为 | Beta 版 | v0.2.0 |
| --- | --- | --- |
| 物理名 `put` / `update_diff` 子节点 | 把节点重挂到 Root，破坏树 | 父级保持不变，拓扑变更须走 `moveTo` |
| 多数据库实例 | schema 缓存进程级共享，互相串扰 | 每个 Client 独立缓存 |
| 深层路径中间节点 | 不入库，反解路径断链 | 自动补建占位节点 |
| `where` 混入未注册属性 | 静默返回空数组 | 部分未定义时 warn 并继续，全部未定义时报错 |
| 条件值类型 | 依赖 SQLite 隐式亲和性 | 按 schema 显式转型 |
| schema 外属性 | 静默丢弃 | strict 模式报错，可降级为跳过并记录 |
| 物理名写入的版本 | 默认 1.0，会降级已存在的对象 | 沿用索引版本，须显式 `migrate: true` |
| `moveTo` 环检测 | 无，可形成环使递归 CTE 失控 | 前置检测，并校验重挂载后深度 |
| 深度限制 | 无 | `maxDepth`（默认 10）双向校验 |
| 错误 | 裸字符串 `raise` | 8 类错误，带 `path` / `layer` / `sql` / 错误码 |

## 新增 API

```js
client.introspect({ treeDepth: 2, includeSample: true })
// -> { root, odlSyntax, maxDepth, strict, classes[], tree, stats }
//    classes[] 含 schema / columns / instanceCount / samplePath / sampleObject

client.introspectClass('User')       // 单类详情，标注各属性支持的比较运算

helper.canonicalPath('Post/p1')      // 反解完整 ODL 路径
helper.ancestors('Post/p1')          // 祖先链
helper.descendants('User/apanda')    // 整棵子树
helper.siblings('Post/p1')           // 兄弟节点
helper.children('User/apanda')       // 直系子节点
```

`introspect()` 是给 AI 与工具链的入口：它把「有哪些类、每个类有哪些属性、
路径长什么样、树上现在有什么」一次性交代清楚，使 AI 无需猜 schema 即可开始操作。

## APL 寻址路径日志

```js
const client = new Client({ apl: { level: 'debug', includeSql: true } });
```

```
[APL-DEBUG] 路径: Root.User['apanda'].Post['p1'] | 层级: Post | 操作: put_attribute | 耗时: 0.03ms
[APL-ERROR] 失败路径: Root.User['apanda'].Post | 层级: Post | 操作: put | 未定义的类型 Post
```

完整变更见 [CHANGELOG.md](./CHANGELOG.md)。
