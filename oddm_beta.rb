require 'sqlite3'
require 'json'
require 'time'

module ODDM
  # ---------------------------------------------------------
  # 1. 基础依赖组件 (Schema, MetaClassManager, PathParser, TreeNavigator, Repository, Client)
  # ---------------------------------------------------------
  class Schema
    def self.init_system_tables!(db)
      db.execute <<-SQL
        CREATE TABLE IF NOT EXISTS oddm_root_index (
          object_name TEXT PRIMARY KEY,
          class_name  TEXT NOT NULL,
          version     TEXT NOT NULL,
          parent_name TEXT,
          created_at  TEXT DEFAULT CURRENT_TIMESTAMP
        );
      SQL
      db.execute <<-SQL
        CREATE TABLE IF NOT EXISTS ODDM_Meta_Classes (
          class_name     TEXT NOT NULL,
          version        TEXT NOT NULL,
          attribute_name TEXT NOT NULL,
          data_type      TEXT NOT NULL,
          PRIMARY KEY (class_name, version, attribute_name)
        );
      SQL
      db.execute <<-SQL
        INSERT INTO oddm_root_index (object_name, class_name, version, parent_name)
        VALUES ('Root', 'System', '1.0', NULL)
        ON CONFLICT(object_name) DO NOTHING;
      SQL
    end

    def self.ensure_class_table!(db, class_name, version)
      table_name = "#{class_name}_V#{version.to_s.tr('.', '_')}"
      db.execute <<-SQL
        CREATE TABLE IF NOT EXISTS #{table_name} (
          object_name    TEXT NOT NULL,
          attribute_name TEXT NOT NULL,
          v_string       TEXT,
          v_int          INTEGER,
          v_float        REAL,
          v_boolean      INTEGER,
          v_datetime     TEXT,
          v_json         TEXT,
          PRIMARY KEY (object_name, attribute_name)
        );
      SQL
      table_name
    end
  end

  class MetaClassManager
    @schema_cache = {}
    class << self
      def get_schema(db, class_name, version)
        cache_key = "#{class_name}:#{version}"
        return @schema_cache[cache_key] if @schema_cache.key?(cache_key)
        rows = db.execute("SELECT attribute_name, data_type FROM ODDM_Meta_Classes WHERE class_name = ? AND version = ?", [class_name, version])
        return nil if rows.empty?
        schema = rows.each_with_object({}) { |(attr, type), hash| hash[attr] = type }
        @schema_cache[cache_key] = schema
        schema
      end

      def define_class(db, class_name:, version: "1.0", schema_hash:)
        db.transaction do
          schema_hash.each do |attr_name, data_type|
            db.execute(
              "INSERT INTO ODDM_Meta_Classes (class_name, version, attribute_name, data_type) VALUES (?, ?, ?, ?) ON CONFLICT(class_name, version, attribute_name) DO UPDATE SET data_type = excluded.data_type;",
              [class_name, version, attr_name.to_s, data_type.to_s]
            )
          end
        end
        @schema_cache["#{class_name}:#{version}"] = schema_hash.transform_keys(&:to_s).transform_values(&:to_s)
      end
    end
  end

  class PathParser
    def self.parse(path_string)
      clean_path = path_string.strip
      raise ArgumentError, "路径必须以 Root 开头" unless clean_path.start_with?("Root")
      return [{ object_name: "Root", class_name: "System", parent_name: nil }] if clean_path == "Root"

      pattern = /\.([A-Za-z0-9_]+)\[(?:'([^']+)'|"([^"]+)"|(\d+))\]/
      matches = clean_path.scan(pattern)
      nodes = [{ object_name: "Root", class_name: "System", parent_name: nil }]
      current_parent = "Root"

      matches.each do |class_name, single_quoted, double_quoted, index_num|
        key = single_quoted || double_quoted || index_num
        object_name = "#{class_name}/#{key}"
        nodes << { object_name: object_name, class_name: class_name, key: key, parent_name: current_parent }
        current_parent = object_name
      end
      nodes
    end

    def self.extract_target(path_string)
      parse(path_string).last
    end
  end

  class TreeNavigator
    def self.ancestors(db, object_name)
      sql = "WITH RECURSIVE ancestor_tree AS (SELECT object_name, class_name, version, parent_name, 0 AS level FROM oddm_root_index WHERE object_name = ? UNION ALL SELECT r.object_name, r.class_name, r.version, r.parent_name, a.level + 1 FROM oddm_root_index r INNER JOIN ancestor_tree a ON r.object_name = a.parent_name) SELECT object_name, class_name, version, parent_name, level FROM ancestor_tree ORDER BY level DESC;"
      db.execute(sql, [object_name]).map { |r| { object_name: r[0], class_name: r[1], version: r[2], parent_name: r[3], level: r[4] } }
    end

    def self.descendants(db, parent_object_name)
      sql = "WITH RECURSIVE descendant_tree AS (SELECT object_name, class_name, version, parent_name, 1 AS depth FROM oddm_root_index WHERE parent_name = ? UNION ALL SELECT r.object_name, r.class_name, r.version, r.parent_name, d.depth + 1 FROM oddm_root_index r INNER JOIN descendant_tree d ON r.parent_name = d.object_name) SELECT object_name, class_name, version, parent_name, depth FROM descendant_tree ORDER BY depth ASC;"
      db.execute(sql, [parent_object_name]).map { |r| { object_name: r[0], class_name: r[1], version: r[2], parent_name: r[3], depth: r[4] } }
    end

    def self.resolve_canonical_path(db, object_name)
      chain = ancestors(db, object_name)
      return "" if chain.empty?
      path_parts = []
      chain.each do |node|
        if node[:object_name] == "Root"
          path_parts << "Root"
        else
          key = node[:object_name].split('/').last
          path_parts << ".#{node[:class_name]}['#{key}']"
        end
      end
      path_parts.join
    end
  end

  class Repository
    TYPE_TO_COLUMN = { 'string' => :v_string, 'int' => :v_int, 'float' => :v_float, 'boolean' => :v_boolean, 'datetime' => :v_datetime, 'json' => :v_json }.freeze

    def self.save_object(db, class_name:, version: "1.0", object_name:, parent_name: "Root", attributes:)
      schema = MetaClassManager.get_schema(db, class_name, version)
      raise "未定义类型 #{class_name}" unless schema
      table_name = Schema.ensure_class_table!(db, class_name, version)

      db.execute(
        "INSERT INTO oddm_root_index (object_name, class_name, version, parent_name) VALUES (?, ?, ?, ?) ON CONFLICT(object_name) DO UPDATE SET class_name=excluded.class_name, version=excluded.version, parent_name=excluded.parent_name;",
        [object_name, class_name, version, parent_name]
      )

      attributes.each do |attr_name, attr_value|
        expected_type = schema[attr_name.to_s]
        next unless expected_type
        col_name = TYPE_TO_COLUMN[expected_type]
        casted_val = cast_value_for_type(attr_value, expected_type)

        db.execute("INSERT INTO #{table_name} (object_name, attribute_name) VALUES (?, ?) ON CONFLICT(object_name, attribute_name) DO NOTHING;", [object_name, attr_name.to_s])
        db.execute("UPDATE #{table_name} SET #{col_name} = ? WHERE object_name = ? AND attribute_name = ?", [casted_val, object_name, attr_name.to_s])
      end
    end

    def self.find_object(db, object_name)
      idx_info = db.get_first_row("SELECT class_name, version FROM oddm_root_index WHERE object_name = ?", [object_name])
      return nil unless idx_info
      class_name, version = idx_info
      schema = MetaClassManager.get_schema(db, class_name, version)
      table_name = Schema.ensure_class_table!(db, class_name, version)

      rows = db.execute("SELECT attribute_name, v_string, v_int, v_float, v_boolean, v_datetime, v_json FROM #{table_name} WHERE object_name = ?", [object_name])
      result = {}
      rows.each do |attr_name, v_str, v_int, v_flt, v_bool, v_dt, v_json|
        expected_type = schema[attr_name]
        val = case expected_type
              when 'int'      then v_int
              when 'float'    then v_flt
              when 'boolean'  then (v_bool == 1 if v_bool)
              when 'datetime' then Time.parse(v_dt) if v_dt
              when 'json'     then JSON.parse(v_json) if v_json
              else                 v_str
              end
        result[attr_name] = val
      end
      result
    end

    def self.cast_value_for_type(value, type)
      case type
      when 'boolean'  then (value ? 1 : 0)
      when 'datetime' then value.is_a?(Time) ? value.iso8601 : value.to_s
      when 'json'     then value.is_a?(String) ? value : value.to_json
      else                 value
      end
    end
  end

  class Client
    attr_reader :db
    def initialize(sqlite_db_or_path)
      @db = sqlite_db_or_path.is_a?(String) ? SQLite3::Database.new(sqlite_db_or_path) : sqlite_db_or_path
      Schema.init_system_tables!(@db)
    end

    def define_class(class_name, schema_hash, version: "1.0")
      MetaClassManager.define_class(@db, class_name: class_name, version: version, schema_hash: schema_hash)
    end

    def put(path_or_object_name, attributes, version: "1.0")
      if path_or_object_name.start_with?("Root")
        target = PathParser.extract_target(path_or_object_name)
        Repository.save_object(@db, class_name: target[:class_name], version: version, object_name: target[:object_name], parent_name: target[:parent_name], attributes: attributes)
      else
        idx_info = @db.get_first_row("SELECT class_name FROM oddm_root_index WHERE object_name = ?", [path_or_object_name])
        raise "不可识别的对象: #{path_or_object_name}" unless idx_info
        Repository.save_object(@db, class_name: idx_info[0], version: version, object_name: path_or_object_name, parent_name: "Root", attributes: attributes)
      end
    end

    def get(path_or_object_name)
      object_name = resolve_to_object_name(path_or_object_name)
      Repository.find_object(@db, object_name)
    end

    def resolve_to_object_name(path_or_object_name)
      path_or_object_name.start_with?("Root") ? PathParser.extract_target(path_or_object_name)[:object_name] : path_or_object_name
    end
  end

  # ---------------------------------------------------------
  # 2. 数据库扩展功能封装：ODDM::DBHelper
  # ---------------------------------------------------------
  class DBHelper
    attr_reader :client, :db

    def initialize(client)
      @client = client
      @db = client.db
    end

    # --- 功能 1: 事务块包装器 ---
    def transaction(&block)
      @db.transaction(&block)
    end

    # --- 功能 2: 属性差异化更新 (Diff Update) ---
    def update_diff(path_or_object_name, new_attributes, version: "1.0")
      object_name = @client.resolve_to_object_name(path_or_object_name)
      current_attributes = @client.get(object_name) || {}

      # 过滤出只有真正被修改或新增的属性
      diff = {}
      new_attributes.each do |k, v|
        attr_key = k.to_s
        diff[attr_key] = v if !current_attributes.key?(attr_key) || current_attributes[attr_key] != v
      end

      return false if diff.empty?

      # 仅提交变更的字段
      @client.put(object_name, diff, version: version)
      true
    end

    # --- 功能 3: 基于条件聚合 SQL 的多属性条件查询 (Where) ---
    def where(class_name, conditions, version: "1.0")
      schema = MetaClassManager.get_schema(@db, class_name, version)
      table_name = Schema.ensure_class_table!(@db, class_name, version)
      return [] unless schema

      where_clauses = []
      params = []

      conditions.each do |attr_name, expr|
        attr_str = attr_name.to_s
        type = schema[attr_str]
        next unless type

        col = Repository::TYPE_TO_COLUMN[type]

        # 语法解析：支持等值判断与操作符 (如 "> 30", "<= 100", 18..35)
        if expr.is_a?(Range)
          where_clauses << "(attribute_name = ? AND #{col} BETWEEN ? AND ?)"
          params.push(attr_str, expr.first, expr.last)
        elsif expr.is_a?(String) && expr =~ /^(>=|<=|>|<|!=)\s*(.+)$/
          op, val = $1, $2
          casted_val = Repository.cast_value_for_type(val.strip, type)
          where_clauses << "(attribute_name = ? AND #{col} #{op} ?)"
          params.push(attr_str, casted_val)
        else
          casted_val = Repository.cast_value_for_type(expr, type)
          where_clauses << "(attribute_name = ? AND #{col} = ?)"
          params.push(attr_str, casted_val)
        end
      end

      return [] if where_clauses.empty?

      # 基于方案 2（条件聚合 + HAVING 汇总）构建的高性能单条 SQL
      sql = <<-SQL
        SELECT object_name
        FROM #{table_name}
        WHERE #{where_clauses.join(' OR ')}
        GROUP BY object_name
        HAVING COUNT(DISTINCT attribute_name) = ?;
      SQL

      params << conditions.size
      rows = @db.execute(sql, params)
      rows.map(&:first)
    end

    # --- 功能 4: 拓扑操作 (Children, Siblings, MoveTo) ---
    def children(path_or_object_name)
      object_name = @client.resolve_to_object_name(path_or_object_name)
      rows = @db.execute("SELECT object_name, class_name FROM oddm_root_index WHERE parent_name = ?", [object_name])
      rows.map { |obj, cls| { object_name: obj, class_name: cls } }
    end

    def siblings(path_or_object_name)
      object_name = @client.resolve_to_object_name(path_or_object_name)
      parent = @db.get_first_value("SELECT parent_name FROM oddm_root_index WHERE object_name = ?", [object_name])
      return [] unless parent

      rows = @db.execute("SELECT object_name, class_name FROM oddm_root_index WHERE parent_name = ? AND object_name != ?", [parent, object_name])
      rows.map { |obj, cls| { object_name: obj, class_name: cls } }
    end

    def move_to(target_path_or_object, new_parent_path_or_object)
      target_name = @client.resolve_to_object_name(target_path_or_object)
      new_parent_name = @client.resolve_to_object_name(new_parent_path_or_object)

      transaction do
        @db.execute("UPDATE oddm_root_index SET parent_name = ? WHERE object_name = ?", [new_parent_name, target_name])
      end
      true
    end

    # --- 功能 5: 级联清理 (Destroy) ---
    def destroy(path_or_object_name, recursive: true)
      target_name = @client.resolve_to_object_name(path_or_object_name)

      transaction do
        targets_to_delete = [target_name]
        if recursive
          descendants = TreeNavigator.descendants(@db, target_name)
          targets_to_delete += descendants.map { |node| node[:object_name] }
        end

        targets_to_delete.each do |obj_name|
          row = @db.get_first_row("SELECT class_name, version FROM oddm_root_index WHERE object_name = ?", [obj_name])
          next unless row

          cls_name, ver = row
          table_name = Schema.ensure_class_table!(@db, cls_name, ver)

          # 清理物理行与索引行
          @db.execute("DELETE FROM #{table_name} WHERE object_name = ?", [obj_name])
          @db.execute("DELETE FROM oddm_root_index WHERE object_name = ?", [obj_name])
        end
      end
      true
    end
  end
end

# ---------------------------------------------------------
# DBHelper 自动化集成测试套件
# ---------------------------------------------------------

client = ODDM::Client.new(':memory:')
helper = ODDM::DBHelper.new(client)

# 1. 注册模型定义
client.define_class("User", { "name" => "string", "age" => "int", "score" => "float" })
client.define_class("Post", { "title" => "string" })

# 2. 插入测试数据
client.put("Root.User['user1']", { "name" => "Alice", "age" => 35, "score" => 95.5 })
client.put("Root.User['user2']", { "name" => "Bob", "age" => 25, "score" => 88.0 })
client.put("Root.User['user3']", { "name" => "Charlie", "age" => 42, "score" => 92.0 })

client.put("Root.User['user1'].Post[1]", { "title" => "Ruby ODDM 设计指南" })
client.put("Root.User['user1'].Post[2]", { "title" => "高级 SQL 级联优化" })

puts "=== 1. 测试多属性条件查询 (Where) ==="
# 筛选：age > 30 且 score > 90.0 的用户
matched_users = helper.where("User", { "age" => "> 30", "score" => "> 90.0" })
puts "符合条件 (age > 30 AND score > 90.0) 的结果集: #{matched_users.inspect}"

puts "\n=== 2. 测试属性增量/差异化更新 (Diff Update) ==="
puts "更新前 user1 属性: #{client.get("User/user1")}"
# 仅修改 score，name 和 age 保持不变
has_updated = helper.update_diff("User/user1", { "name" => "Alice", "age" => 35, "score" => 99.0 })
puts "是否触发物理落盘更新: #{has_updated}"
puts "更新后 user1 属性: #{client.get("User/user1")}"

puts "\n=== 3. 测试拓扑导航与重挂载 (MoveTo) ==="
puts "user1 的直系子节点: #{helper.children("User/user1").map { |n| n[:object_name] }}"
# 将 Post/2 从 User/user1 重挂载到 User/user2 下
helper.move_to("Post/2", "User/user2")
puts "重挂载后 user1 的直系子节点: #{helper.children("User/user1").map { |n| n[:object_name] }}"
puts "重挂载后 user2 的直系子节点: #{helper.children("User/user2").map { |n| n[:object_name] }}"

puts "\n=== 4. 测试事务性级联删除 (Destroy Recursive) ==="
# 级联删除 User/user1 及其下所有子节点 (Post/1)
helper.destroy("User/user1", recursive: true)
puts "删除 user1 后再次获取: #{client.get("User/user1").inspect}"
puts "级联删除后 Post/1 的数据: #{client.get("Post/1").inspect}"
