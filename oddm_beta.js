const Database = require('better-sqlite3');

// ---------------------------------------------------------
// 1. 基础依赖组件
// ---------------------------------------------------------
class Schema {
    static initSystemTables(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS oddm_root_index (
                object_name TEXT PRIMARY KEY,
                class_name  TEXT NOT NULL,
                version     TEXT NOT NULL,
                parent_name TEXT,
                created_at  TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS ODDM_Meta_Classes (
                class_name     TEXT NOT NULL,
                version        TEXT NOT NULL,
                attribute_name TEXT NOT NULL,
                data_type      TEXT NOT NULL,
                PRIMARY KEY (class_name, version, attribute_name)
            );
            INSERT INTO oddm_root_index (object_name, class_name, version, parent_name)
            VALUES ('Root', 'System', '1.0', NULL)
            ON CONFLICT(object_name) DO NOTHING;
        `);
    }

    static ensureClassTable(db, className, version) {
        const tableName = `${className}_V${version.replace(/\./g, '_')}`;
        db.exec(`
            CREATE TABLE IF NOT EXISTS ${tableName} (
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
        `);
        return tableName;
    }
}

class MetaClassManager {
    static _schemaCache = {};

    static getSchema(db, className, version) {
        const cacheKey = `${className}:${version}`;
        if (this._schemaCache[cacheKey]) {
            return this._schemaCache[cacheKey];
        }

        const stmt = db.prepare("SELECT attribute_name, data_type FROM ODDM_Meta_Classes WHERE class_name = ? AND version = ?");
        const rows = stmt.all(className, version);
        
        if (rows.length === 0) return null;

        const schema = {};
        rows.forEach(row => schema[row.attribute_name] = row.data_type);
        this._schemaCache[cacheKey] = schema;
        return schema;
    }

    static defineClass(db, className, schemaHash, version = "1.0") {
        const insertStmt = db.prepare(`
            INSERT INTO ODDM_Meta_Classes (class_name, version, attribute_name, data_type) 
            VALUES (?, ?, ?, ?) 
            ON CONFLICT(class_name, version, attribute_name) 
            DO UPDATE SET data_type = excluded.data_type;
        `);

        const tx = db.transaction(() => {
            for (const [attrName, dataType] of Object.entries(schemaHash)) {
                insertStmt.run(className, version, String(attrName), String(dataType));
            }
        });
        tx();

        const cacheKey = `${className}:${version}`;
        this._schemaCache[cacheKey] = {};
        for (const [k, v] of Object.entries(schemaHash)) {
            this._schemaCache[cacheKey][String(k)] = String(v);
        }
    }
}

class PathParser {
    static parse(pathString) {
        const cleanPath = pathString.trim();
        if (!cleanPath.startsWith("Root")) {
            throw new Error("路径必须以 Root 开头");
        }

        const nodes = [{ object_name: "Root", class_name: "System", parent_name: null }];
        if (cleanPath === "Root") return nodes;

        const pattern = /\.([A-Za-z0-9_]+)\[(?:'([^']+)'|"([^"]+)"|(\d+))\]/g;
        let match;
        let currentParent = "Root";

        while ((match = pattern.exec(cleanPath)) !== null) {
            const className = match[1];
            const key = match[2] || match[3] || match[4];
            const objectName = `${className}/${key}`;

            nodes.push({
                object_name: objectName,
                class_name: className,
                key: key,
                parent_name: currentParent
            });
            currentParent = objectName;
        }

        return nodes;
    }

    static extractTarget(pathString) {
        const nodes = this.parse(pathString);
        return nodes[nodes.length - 1];
    }
}

class TreeNavigator {
    static descendants(db, parentObjectName) {
        const sql = `
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
        `;
        return db.prepare(sql).all(parentObjectName);
    }
}

class Repository {
    static TYPE_TO_COLUMN = {
        'string': 'v_string', 'int': 'v_int', 'float': 'v_float',
        'boolean': 'v_boolean', 'datetime': 'v_datetime', 'json': 'v_json'
    };

    static saveObject(db, className, objectName, attributes, parentName = "Root", version = "1.0") {
        const schema = MetaClassManager.getSchema(db, className, version);
        if (!schema) throw new Error(`未定义类型 ${className}`);

        const tableName = Schema.ensureClassTable(db, className, version);

        const tx = db.transaction(() => {
            db.prepare(`
                INSERT INTO oddm_root_index (object_name, class_name, version, parent_name) 
                VALUES (?, ?, ?, ?) 
                ON CONFLICT(object_name) DO UPDATE SET 
                    class_name=excluded.class_name, version=excluded.version, parent_name=excluded.parent_name;
            `).run(objectName, className, version, parentName);

            const insertAttr = db.prepare(`INSERT INTO ${tableName} (object_name, attribute_name) VALUES (?, ?) ON CONFLICT(object_name, attribute_name) DO NOTHING;`);
            
            for (const [attrName, attrValue] of Object.entries(attributes)) {
                const expectedType = schema[attrName];
                if (!expectedType) continue;

                const colName = this.TYPE_TO_COLUMN[expectedType];
                const castedVal = this.castValueForType(attrValue, expectedType);

                insertAttr.run(objectName, attrName);
                db.prepare(`UPDATE ${tableName} SET ${colName} = ? WHERE object_name = ? AND attribute_name = ?;`)
                  .run(castedVal, objectName, attrName);
            }
        });
        tx();
    }

    static findObject(db, objectName) {
        const row = db.prepare("SELECT class_name, version FROM oddm_root_index WHERE object_name = ?").get(objectName);
        if (!row) return null;

        const { class_name, version } = row;
        const schema = MetaClassManager.getSchema(db, class_name, version);
        const tableName = Schema.ensureClassTable(db, class_name, version);

        const rows = db.prepare(`SELECT attribute_name, v_string, v_int, v_float, v_boolean, v_datetime, v_json FROM ${tableName} WHERE object_name = ?`).all(objectName);

        const result = {};
        for (const r of rows) {
            const expectedType = schema[r.attribute_name];
            let val = null;

            if (expectedType === 'int') val = r.v_int;
            else if (expectedType === 'float') val = r.v_float;
            else if (expectedType === 'boolean') val = r.v_boolean !== null ? Boolean(r.v_boolean) : null;
            else if (expectedType === 'datetime') val = r.v_datetime ? new Date(r.v_datetime) : null;
            else if (expectedType === 'json') val = r.v_json ? JSON.parse(r.v_json) : null;
            else val = r.v_string;

            result[r.attribute_name] = val;
        }
        return result;
    }

    static castValueForType(value, typeStr) {
        if (value === null || value === undefined) return null;
        if (typeStr === 'boolean') return value ? 1 : 0;
        if (typeStr === 'datetime') return value instanceof Date ? value.toISOString() : String(value);
        if (typeStr === 'json') return typeof value === 'object' ? JSON.stringify(value) : String(value);
        return value;
    }
}

// ---------------------------------------------------------
// 2. 核心门面与辅助类
// ---------------------------------------------------------
class Client {
    constructor(dbPath = ":memory:") {
        this.db = new Database(dbPath);
        Schema.initSystemTables(this.db);
    }

    defineClass(className, schemaHash, version = "1.0") {
        MetaClassManager.defineClass(this.db, className, schemaHash, version);
    }

    put(pathOrObjectName, attributes, version = "1.0") {
        if (pathOrObjectName.startsWith("Root")) {
            const target = PathParser.extractTarget(pathOrObjectName);
            Repository.saveObject(this.db, target.class_name, target.object_name, attributes, target.parent_name, version);
        } else {
            const row = this.db.prepare("SELECT class_name FROM oddm_root_index WHERE object_name = ?").get(pathOrObjectName);
            if (!row) throw new Error(`不可识别的对象: ${pathOrObjectName}`);
            Repository.saveObject(this.db, row.class_name, pathOrObjectName, attributes, "Root", version);
        }
    }

    get(pathOrObjectName) {
        return Repository.findObject(this.db, this.resolveToObjectName(pathOrObjectName));
    }

    resolveToObjectName(pathOrObjectName) {
        if (pathOrObjectName.startsWith("Root")) {
            return PathParser.extractTarget(pathOrObjectName).object_name;
        }
        return pathOrObjectName;
    }
}

class DBHelper {
    constructor(client) {
        this.client = client;
        this.db = client.db;
    }

    transaction(fn) {
        const tx = this.db.transaction(fn);
        return tx();
    }

    updateDiff(pathOrObjectName, newAttributes, version = "1.0") {
        const objectName = this.client.resolveToObjectName(pathOrObjectName);
        const currentAttributes = this.client.get(objectName) || {};

        const diff = {};
        for (const [k, v] of Object.entries(newAttributes)) {
            const attrKey = String(k);
            // 简单对象对比
            if (!(attrKey in currentAttributes) || JSON.stringify(currentAttributes[attrKey]) !== JSON.stringify(v)) {
                diff[attrKey] = v;
            }
        }

        if (Object.keys(diff).length === 0) return false;

        this.client.put(objectName, diff, version);
        return true;
    }

    where(className, conditions, version = "1.0") {
        const schema = MetaClassManager.getSchema(this.db, className, version);
        if (!schema) return [];
        const tableName = Schema.ensureClassTable(this.db, className, version);
        
        const whereClauses = [];
        const params = [];

        for (const [attrName, expr] of Object.entries(conditions)) {
            const expectedType = schema[attrName];
            if (!expectedType) continue;

            const col = Repository.TYPE_TO_COLUMN[expectedType];
            
            if (typeof expr === 'string' && /^(>=|<=|>|<|!=)\s*(.+)$/.test(expr)) {
                const match = expr.match(/^(>=|<=|>|<|!=)\s*(.+)$/);
                const op = match[1];
                const val = Repository.castValueForType(match[2].trim(), expectedType);
                whereClauses.push(`(attribute_name = ? AND ${col} ${op} ?)`);
                params.push(attrName, val);
            } else if (Array.isArray(expr) && expr.length === 2) {
                // Node.js 中用长度为 2 的数组代表范围 (Range)
                whereClauses.push(`(attribute_name = ? AND ${col} BETWEEN ? AND ?)`);
                params.push(attrName, expr[0], expr[1]);
            } else {
                const val = Repository.castValueForType(expr, expectedType);
                whereClauses.push(`(attribute_name = ? AND ${col} = ?)`);
                params.push(attrName, val);
            }
        }

        if (whereClauses.length === 0) return [];

        params.push(Object.keys(conditions).length);
        const sql = `
            SELECT object_name FROM ${tableName}
            WHERE ${whereClauses.join(' OR ')}
            GROUP BY object_name HAVING COUNT(DISTINCT attribute_name) = ?;
        `;
        
        return this.db.prepare(sql).all(...params).map(r => r.object_name);
    }

    children(pathOrObjectName) {
        const objectName = this.client.resolveToObjectName(pathOrObjectName);
        return this.db.prepare("SELECT object_name, class_name FROM oddm_root_index WHERE parent_name = ?").all(objectName);
    }

    moveTo(targetPath, newParentPath) {
        const targetName = this.client.resolveToObjectName(targetPath);
        const newParentName = this.client.resolveToObjectName(newParentPath);

        this.transaction(() => {
            this.db.prepare("UPDATE oddm_root_index SET parent_name = ? WHERE object_name = ?").run(newParentName, targetName);
        });
        return true;
    }

    destroy(pathOrObjectName, recursive = true) {
        const targetName = this.client.resolveToObjectName(pathOrObjectName);

        this.transaction(() => {
            const targetsToDelete = [targetName];
            if (recursive) {
                const descendants = TreeNavigator.descendants(this.db, targetName);
                descendants.forEach(n => targetsToDelete.push(n.object_name));
            }

            for (const objName of targetsToDelete) {
                const row = this.db.prepare("SELECT class_name, version FROM oddm_root_index WHERE object_name = ?").get(objName);
                if (!row) continue;
                
                const tableName = Schema.ensureClassTable(this.db, row.class_name, row.version);
                this.db.prepare(`DELETE FROM ${tableName} WHERE object_name = ?`).run(objName);
                this.db.prepare("DELETE FROM oddm_root_index WHERE object_name = ?").run(objName);
            }
        });
        return true;
    }
}

// ---------------------------------------------------------
// 3. 自动化实战测试 (Run with: node oddm.js)
// ---------------------------------------------------------
if (require.main === module) {
    console.log("初始化 ODDM Node.js 客户端...");
    const client = new Client();
    const helper = new DBHelper(client);

    // 1. 定义 Schema
    client.defineClass("User", { name: "string", age: "int", score: "float", tags: "json" });
    client.defineClass("Post", { title: "string" });

    // 2. 插入测试数据
    client.put("Root.User['u1']", { name: "Alice", age: 35, score: 95.5, tags: ["js", "node"] });
    client.put("Root.User['u2']", { name: "Bob", age: 25, score: 88.0 });
    client.put("Root.User['u1'].Post['p1']", { title: "ODDM JS Port" });
    client.put("Root.User['u1'].Post['p2']", { title: "SQLite on Node" });

    console.log("\n=== 1. 读取基础对象属性 ===");
    const u1Data = client.get("User/u1");
    console.log("User u1:", u1Data);
    console.log("JSON 数组解析验证:", Array.isArray(u1Data.tags) ? "成功" : "失败", u1Data.tags);

    console.log("\n=== 2. 测试复合条件查询 (Where) ===");
    // 使用 [min, max] 代表区间
    const results = helper.where("User", { age: "> 30", score: [90.0, 100.0] });
    console.log("匹配 age > 30 且 score 介于 90~100 的对象:", results);

    console.log("\n=== 3. 测试差异化增量更新 (Diff Update) ===");
    const updated = helper.updateDiff("User/u1", { name: "Alice", score: 99.0 });
    console.log("是否触发数据库更新:", updated);
    console.log("更新后 u1 属性:", client.get("User/u1"));

    console.log("\n=== 4. 测试拓扑重挂载 (MoveTo) ===");
    console.log("挂载前 u1 的子节点:", helper.children("User/u1").map(n => n.object_name));
    helper.moveTo("Post/p1", "User/u2");
    console.log("挂载后 u1 的子节点:", helper.children("User/u1").map(n => n.object_name));
    console.log("挂载后 u2 的子节点:", helper.children("User/u2").map(n => n.object_name));

    console.log("\n=== 5. 测试级联销毁 (Destroy) ===");
    helper.destroy("User/u1", true);
    console.log("删除后读取 u1:", client.get("User/u1"));
    console.log("删除后读取其遗留子节点 p2:", client.get("Post/p2"));
}