import sqlite3
import json
import re
from datetime import datetime
from contextlib import contextmanager

# ---------------------------------------------------------
# 1. 基础依赖组件 (Schema, MetaClassManager, PathParser, TreeNavigator, Repository)
# ---------------------------------------------------------
class Schema:
    @staticmethod
    def init_system_tables(conn: sqlite3.Connection):
        conn.execute("""
            CREATE TABLE IF NOT EXISTS oddm_root_index (
                object_name TEXT PRIMARY KEY,
                class_name  TEXT NOT NULL,
                version     TEXT NOT NULL,
                parent_name TEXT,
                created_at  TEXT DEFAULT CURRENT_TIMESTAMP
            );
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS ODDM_Meta_Classes (
                class_name     TEXT NOT NULL,
                version        TEXT NOT NULL,
                attribute_name TEXT NOT NULL,
                data_type      TEXT NOT NULL,
                PRIMARY KEY (class_name, version, attribute_name)
            );
        """)
        conn.execute("""
            INSERT INTO oddm_root_index (object_name, class_name, version, parent_name)
            VALUES ('Root', 'System', '1.0', NULL)
            ON CONFLICT(object_name) DO NOTHING;
        """)
        conn.commit()

    @staticmethod
    def ensure_class_table(conn: sqlite3.Connection, class_name: str, version: str) -> str:
        table_name = f"{class_name}_V{version.replace('.', '_')}"
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS {table_name} (
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
        """)
        return table_name

class MetaClassManager:
    _schema_cache = {}

    @classmethod
    def get_schema(cls, conn: sqlite3.Connection, class_name: str, version: str) -> dict:
        cache_key = f"{class_name}:{version}"
        if cache_key in cls._schema_cache:
            return cls._schema_cache[cache_key]
        
        cursor = conn.execute(
            "SELECT attribute_name, data_type FROM ODDM_Meta_Classes WHERE class_name = ? AND version = ?",
            (class_name, version)
        )
        rows = cursor.fetchall()
        if not rows:
            return None
        
        schema = {row[0]: row[1] for row in rows}
        cls._schema_cache[cache_key] = schema
        return schema

    @classmethod
    def define_class(cls, conn: sqlite3.Connection, class_name: str, schema_hash: dict, version: str = "1.0"):
        with conn:
            for attr_name, data_type in schema_hash.items():
                conn.execute("""
                    INSERT INTO ODDM_Meta_Classes (class_name, version, attribute_name, data_type) 
                    VALUES (?, ?, ?, ?) 
                    ON CONFLICT(class_name, version, attribute_name) 
                    DO UPDATE SET data_type = excluded.data_type;
                """, (class_name, version, str(attr_name), str(data_type)))
        
        cache_key = f"{class_name}:{version}"
        cls._schema_cache[cache_key] = {str(k): str(v) for k, v in schema_hash.items()}

class PathParser:
    @staticmethod
    def parse(path_string: str) -> list:
        clean_path = path_string.strip()
        if not clean_path.startswith("Root"):
            raise ValueError("路径必须以 Root 开头")
        
        nodes = [{"object_name": "Root", "class_name": "System", "parent_name": None}]
        if clean_path == "Root":
            return nodes

        pattern = r"\.([A-Za-z0-9_]+)\[(?:'([^']+)'|\"([^\"]+)\"|(\d+))\]"
        matches = re.findall(pattern, clean_path)
        
        current_parent = "Root"
        for match in matches:
            class_name = match[0]
            key = match[1] or match[2] or match[3]
            object_name = f"{class_name}/{key}"
            
            nodes.append({
                "object_name": object_name,
                "class_name": class_name,
                "key": key,
                "parent_name": current_parent
            })
            current_parent = object_name
            
        return nodes

    @staticmethod
    def extract_target(path_string: str) -> dict:
        return PathParser.parse(path_string)[-1]

class TreeNavigator:
    @staticmethod
    def ancestors(conn: sqlite3.Connection, object_name: str) -> list:
        sql = """
            WITH RECURSIVE ancestor_tree AS (
                SELECT object_name, class_name, version, parent_name, 0 AS level 
                FROM oddm_root_index WHERE object_name = ?
                UNION ALL
                SELECT r.object_name, r.class_name, r.version, r.parent_name, a.level + 1 
                FROM oddm_root_index r
                INNER JOIN ancestor_tree a ON r.object_name = a.parent_name
            )
            SELECT object_name, class_name, version, parent_name, level 
            FROM ancestor_tree ORDER BY level DESC;
        """
        return [{"object_name": r[0], "class_name": r[1], "version": r[2], "parent_name": r[3], "level": r[4]} 
                for r in conn.execute(sql, (object_name,)).fetchall()]

    @staticmethod
    def descendants(conn: sqlite3.Connection, parent_object_name: str) -> list:
        sql = """
            WITH RECURSIVE descendant_tree AS (
                SELECT object_name, class_name, version, parent_name, 1 AS depth 
                FROM oddm_root_index WHERE parent_name = ?
                UNION ALL
                SELECT r.object_name, r.class_name, r.version, r.parent_name, d.depth + 1 
                FROM oddm_root_index r
                INNER JOIN descendant_tree d ON r.parent_name = d.object_name
            )
            SELECT object_name, class_name, version, parent_name, depth 
            FROM descendant_tree ORDER BY depth ASC;
        """
        return [{"object_name": r[0], "class_name": r[1], "version": r[2], "parent_name": r[3], "depth": r[4]} 
                for r in conn.execute(sql, (parent_object_name,)).fetchall()]

class Repository:
    TYPE_TO_COLUMN = {
        'string': 'v_string', 'int': 'v_int', 'float': 'v_float',
        'boolean': 'v_boolean', 'datetime': 'v_datetime', 'json': 'v_json'
    }

    @classmethod
    def save_object(cls, conn: sqlite3.Connection, class_name: str, object_name: str, attributes: dict, parent_name: str = "Root", version: str = "1.0"):
        schema = MetaClassManager.get_schema(conn, class_name, version)
        if not schema:
            raise ValueError(f"未定义类型 {class_name}")
        
        table_name = Schema.ensure_class_table(conn, class_name, version)

        with conn:
            conn.execute("""
                INSERT INTO oddm_root_index (object_name, class_name, version, parent_name) 
                VALUES (?, ?, ?, ?) 
                ON CONFLICT(object_name) DO UPDATE SET 
                    class_name=excluded.class_name, version=excluded.version, parent_name=excluded.parent_name;
            """, (object_name, class_name, version, parent_name))

            for attr_name, attr_value in attributes.items():
                expected_type = schema.get(str(attr_name))
                if not expected_type:
                    continue
                
                col_name = cls.TYPE_TO_COLUMN[expected_type]
                casted_val = cls.cast_value_for_type(attr_value, expected_type)

                conn.execute(f"""
                    INSERT INTO {table_name} (object_name, attribute_name) 
                    VALUES (?, ?) ON CONFLICT(object_name, attribute_name) DO NOTHING;
                """, (object_name, str(attr_name)))
                
                conn.execute(f"""
                    UPDATE {table_name} SET {col_name} = ? 
                    WHERE object_name = ? AND attribute_name = ?;
                """, (casted_val, object_name, str(attr_name)))

    @classmethod
    def find_object(cls, conn: sqlite3.Connection, object_name: str) -> dict:
        row = conn.execute("SELECT class_name, version FROM oddm_root_index WHERE object_name = ?", (object_name,)).fetchone()
        if not row:
            return None
            
        class_name, version = row
        schema = MetaClassManager.get_schema(conn, class_name, version)
        table_name = Schema.ensure_class_table(conn, class_name, version)

        rows = conn.execute(f"""
            SELECT attribute_name, v_string, v_int, v_float, v_boolean, v_datetime, v_json 
            FROM {table_name} WHERE object_name = ?
        """, (object_name,)).fetchall()

        result = {}
        for r in rows:
            attr_name = r[0]
            expected_type = schema.get(attr_name)
            
            if expected_type == 'int': val = r[2]
            elif expected_type == 'float': val = r[3]
            elif expected_type == 'boolean': val = bool(r[4]) if r[4] is not None else None
            elif expected_type == 'datetime': val = datetime.fromisoformat(r[5]) if r[5] else None
            elif expected_type == 'json': val = json.loads(r[6]) if r[6] else None
            else: val = r[1]
                
            result[attr_name] = val
        return result

    @staticmethod
    def cast_value_for_type(value, type_str):
        if value is None: return None
        if type_str == 'boolean': return 1 if value else 0
        if type_str == 'datetime': return value.isoformat() if isinstance(value, datetime) else str(value)
        if type_str == 'json': return json.dumps(value) if isinstance(value, (dict, list)) else str(value)
        return value

# ---------------------------------------------------------
# 2. 核心门面与辅助类 (Client & DBHelper)
# ---------------------------------------------------------
class Client:
    def __init__(self, db_path: str = ":memory:"):
        # check_same_thread=False 防止多线程测试时报错
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        Schema.init_system_tables(self.conn)

    def define_class(self, class_name: str, schema_hash: dict, version: str = "1.0"):
        MetaClassManager.define_class(self.conn, class_name=class_name, version=version, schema_hash=schema_hash)

    def put(self, path_or_object_name: str, attributes: dict, version: str = "1.0"):
        if path_or_object_name.startswith("Root"):
            target = PathParser.extract_target(path_or_object_name)
            Repository.save_object(self.conn, class_name=target["class_name"], version=version, 
                                   object_name=target["object_name"], parent_name=target["parent_name"], attributes=attributes)
        else:
            row = self.conn.execute("SELECT class_name FROM oddm_root_index WHERE object_name = ?", (path_or_object_name,)).fetchone()
            if not row:
                raise ValueError(f"不可识别的对象: {path_or_object_name}")
            Repository.save_object(self.conn, class_name=row[0], version=version, 
                                   object_name=path_or_object_name, parent_name="Root", attributes=attributes)

    def get(self, path_or_object_name: str) -> dict:
        return Repository.find_object(self.conn, self.resolve_to_object_name(path_or_object_name))

    def resolve_to_object_name(self, path_or_object_name: str) -> str:
        if path_or_object_name.startswith("Root"):
            return PathParser.extract_target(path_or_object_name)["object_name"]
        return path_or_object_name


class DBHelper:
    def __init__(self, client: Client):
        self.client = client
        self.conn = client.conn

    @contextmanager
    def transaction(self):
        try:
            self.conn.execute("BEGIN")
            yield
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise

    def update_diff(self, path_or_object_name: str, new_attributes: dict, version: str = "1.0") -> bool:
        object_name = self.client.resolve_to_object_name(path_or_object_name)
        current_attributes = self.client.get(object_name) or {}

        diff = {}
        for k, v in new_attributes.items():
            attr_key = str(k)
            if attr_key not in current_attributes or current_attributes[attr_key] != v:
                diff[attr_key] = v

        if not diff:
            return False

        self.client.put(object_name, diff, version=version)
        return True

    def where(self, class_name: str, conditions: dict, version: str = "1.0") -> list:
        schema = MetaClassManager.get_schema(self.conn, class_name, version)
        if not schema:
            return []
            
        table_name = Schema.ensure_class_table(self.conn, class_name, version)
        
        where_clauses = []
        params = []

        for attr_name, expr in conditions.items():
            attr_str = str(attr_name)
            expected_type = schema.get(attr_str)
            if not expected_type:
                continue

            col = Repository.TYPE_TO_COLUMN[expected_type]
            
            if isinstance(expr, str) and (match := re.match(r"^(>=|<=|>|<|!=)\s*(.+)$", expr)):
                op, val = match.groups()
                casted_val = Repository.cast_value_for_type(val.strip(), expected_type)
                where_clauses.append(f"(attribute_name = ? AND {col} {op} ?)")
                params.extend([attr_str, casted_val])
            elif isinstance(expr, tuple) and len(expr) == 2: # 区间用 tuple 替代 range
                where_clauses.append(f"(attribute_name = ? AND {col} BETWEEN ? AND ?)")
                params.extend([attr_str, expr[0], expr[1]])
            else:
                casted_val = Repository.cast_value_for_type(expr, expected_type)
                where_clauses.append(f"(attribute_name = ? AND {col} = ?)")
                params.extend([attr_str, casted_val])

        if not where_clauses:
            return []

        sql = f"""
            SELECT object_name FROM {table_name}
            WHERE {' OR '.join(where_clauses)}
            GROUP BY object_name HAVING COUNT(DISTINCT attribute_name) = ?;
        """
        params.append(len(conditions))
        
        return [r[0] for r in self.conn.execute(sql, params).fetchall()]

    def children(self, path_or_object_name: str) -> list:
        object_name = self.client.resolve_to_object_name(path_or_object_name)
        rows = self.conn.execute("SELECT object_name, class_name FROM oddm_root_index WHERE parent_name = ?", (object_name,)).fetchall()
        return [{"object_name": r[0], "class_name": r[1]} for r in rows]

    def siblings(self, path_or_object_name: str) -> list:
        object_name = self.client.resolve_to_object_name(path_or_object_name)
        parent_row = self.conn.execute("SELECT parent_name FROM oddm_root_index WHERE object_name = ?", (object_name,)).fetchone()
        if not parent_row or not parent_row[0]:
            return []
            
        rows = self.conn.execute("SELECT object_name, class_name FROM oddm_root_index WHERE parent_name = ? AND object_name != ?", 
                                 (parent_row[0], object_name)).fetchall()
        return [{"object_name": r[0], "class_name": r[1]} for r in rows]

    def move_to(self, target_path_or_object: str, new_parent_path_or_object: str) -> bool:
        target_name = self.client.resolve_to_object_name(target_path_or_object)
        new_parent_name = self.client.resolve_to_object_name(new_parent_path_or_object)

        with self.transaction():
            self.conn.execute("UPDATE oddm_root_index SET parent_name = ? WHERE object_name = ?", (new_parent_name, target_name))
        return True

    def destroy(self, path_or_object_name: str, recursive: bool = True) -> bool:
        target_name = self.client.resolve_to_object_name(path_or_object_name)

        with self.transaction():
            targets_to_delete = [target_name]
            if recursive:
                descendants = TreeNavigator.descendants(self.conn, target_name)
                targets_to_delete.extend([node["object_name"] for node in descendants])

            for obj_name in targets_to_delete:
                row = self.conn.execute("SELECT class_name, version FROM oddm_root_index WHERE object_name = ?", (obj_name,)).fetchone()
                if not row:
                    continue
                
                table_name = Schema.ensure_class_table(self.conn, row[0], row[1])
                self.conn.execute(f"DELETE FROM {table_name} WHERE object_name = ?", (obj_name,))
                self.conn.execute("DELETE FROM oddm_root_index WHERE object_name = ?", (obj_name,))
        return True

# ---------------------------------------------------------
# 3. 自动化实战测试 (Run tests when script executes)
# ---------------------------------------------------------
if __name__ == "__main__":
    print("初始化 ODDM Python 客户端...")
    client = Client()
    helper = DBHelper(client)

    # 1. 定义 Schema
    client.define_class("User", {"name": "string", "age": "int", "score": "float", "tags": "json"})
    client.define_class("Post", {"title": "string"})

    # 2. 插入测试数据
    client.put("Root.User['u1']", {"name": "Alice", "age": 35, "score": 95.5, "tags": ["python", "ai"]})
    client.put("Root.User['u2']", {"name": "Bob", "age": 25, "score": 88.0})
    client.put("Root.User['u1'].Post['p1']", {"title": "ODDM Python Port"})
    client.put("Root.User['u1'].Post['p2']", {"title": "SQLite Advanced"})

    print("\n=== 1. 读取基础对象属性 ===")
    u1_data = client.get("User/u1")
    print("User u1:", u1_data)
    print("JSON 解析验证 (tags):", type(u1_data.get("tags")), "->", u1_data.get("tags"))

    print("\n=== 2. 测试复合条件查询 (Where) ===")
    # 注意: Python 原生没有 Ruby 的 Range，我们这里约定使用 tuple (min, max) 来代表区间
    results = helper.where("User", {"age": "> 30", "score": (90.0, 100.0)})
    print("匹配 age > 30 且 score 介于 90~100 的对象:", results)

    print("\n=== 3. 测试差异化增量更新 (Diff Update) ===")
    # 改变 score，名字不变
    updated = helper.update_diff("User/u1", {"name": "Alice", "score": 99.0})
    print("是否触发数据库更新:", updated)
    print("更新后 u1 属性:", client.get("User/u1"))

    print("\n=== 4. 测试拓扑重挂载 (MoveTo) ===")
    print("挂载前 u1 的子节点:", [n["object_name"] for n in helper.children("User/u1")])
    helper.move_to("Post/p1", "User/u2")
    print("挂载后 u1 的子节点:", [n["object_name"] for n in helper.children("User/u1")])
    print("挂载后 u2 的子节点:", [n["object_name"] for n in helper.children("User/u2")])

    print("\n=== 5. 测试级联销毁 (Destroy) ===")
    helper.destroy("User/u1", recursive=True)
    print("删除后读取 u1:", client.get("User/u1"))
    print("删除后读取其遗留子节点 p2:", client.get("Post/p2"))
