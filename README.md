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
---
```
# oddm
# 文件名: oddm_interface_demo.rb
# 模块: ODDM 对象驱动层接口演示
# 目标: 展示 ODDM 如何在 Ruby 中实现面向对象的寻址和操作，以替代传统 ORM/SQL。
#
# ODDM 的核心优势在于将数据操作转换为对象图的遍历和原子性操作，
# 极大地简化了应用层的业务逻辑代码。

# 假设 ODL (Object-Driven Layer) 驱动层已被初始化，并暴露了 Root 接口。
# ODL 负责将以下操作翻译成高效的 Redis 命令序列或 SQL 子查询。

module ODDM
  # 模拟 ODL 提供的根对象接口
  Root = ODL_Driver.new_connection 
end

# =========================================================================
# 场景一：创建一个新的对象实例 (Class + Instance Naming)
# =========================================================================

puts "--- 场景一: 创建新的对象实例 ---"
# ODDM 操作: 从 Root 节点挂载一个新的 'User' 实例，具名为 'gemini-panda'
begin
  new_user = ODDM::Root.User.create(
    name: "Gemini Panda",
    email: "ai@google.com",
    role: "Developer",
    is_active: true
  )
  puts "✅ 创建成功: #{new_user.path} (自动分配版本: V1.0)"

rescue ODDM::IntegrityError => e
  puts "❌ 创建失败 (事务回滚): #{e.message}"
end


# =========================================================================
# 场景二：复杂路径寻址与功能式查询 (Functionality Query)
# =========================================================================

puts "\n--- 场景二: 复杂路径寻址与功能式查询 ---"

# 业务需求: 找到用户 'apanda' 所有处于 'draft' 状态的 Post 集合。
# 传统方法需要 JOIN 或多次 SELECT。

draft_posts = ODDM::Root            # 从根开始
              .User['apanda']      # 寻址到具名对象 'apanda'
              .Posts               # 访问其子对象集合 'Posts' (挂载关系)
              .where(status: :draft) # 功能式筛选 (ODL 翻译成高效的 WHERE/IN 查询)
              .order_by(:created_at, :desc)

puts "✅ 查询成功: 找到 #{draft_posts.count} 篇草稿文章。"
puts "   返回类型: ODDM::ObjectCollection (而非数据库行)"
puts "   ---"


# =========================================================================
# 场景三：原子性更新 (Atomic Update)
# =========================================================================

puts "\n--- 场景三: 原子性更新 (路径寻址和操作原子化) ---"

# 业务需求: 找到 'apanda' 的第一篇草稿 Post 的名字是 'ODDM-POC-V1' 的评论，并将其内容标记为 '已审核'。

target_comment = draft_posts      # 沿用上一步的集合结果
                 .find { |p| p.title == 'ODDM-POC-V1' } # 内存或二次查找
                 .Comments['C001'] # 寻址到具名子对象 'C001'
                 
if target_comment
  # ODDM 操作: 对单个对象进行原子性更新
  target_comment.update(
    content: target_comment.content.gsub("TODO", ""), # 业务逻辑
    status: :approved,
    updated_by: ODDM::Root.User['gemini-panda'] # 记录引用路径
  )
  
  puts "✅ 更新成功: 路径 #{target_comment.path} 的状态已更新为 :approved"
  # ODL 确保：[content]、[status]、[updated_by] 的修改在底层存储是原子性事务。

else
  puts "❌ 未找到目标文章或评论。"
end

# =========================================================================
# AI 协作优势彰显：可追溯的错误处理
# =========================================================================

puts "\n--- AI 协作优势: 路径化错误处理 ---"

# 假设 ODL 尝试读取一个不存在的属性
begin
  non_existent_value = ODDM::Root.User['apanda'].Posts[999].non_existent_attribute
rescue ODDM::AddressingError => e
  # ODL 抛出的错误信息直接是对象路径，AI 无需解析 SQL 错误
  puts "🚨 ODL 捕获错误: #{e.message}"
  # 协作优势: AI 可立即诊断出问题在 'Posts' 集合的第 999 号实例上。
  puts "   => AI 诊断: 问题发生在对象路径层，而非底层 SQL/Redis 语法。"
end

# 协作总结: ODDM 使得我们可以在同一套对象语言上进行设计、编码和错误诊断。
```
