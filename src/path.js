'use strict';

const { PATH_SEGMENT_RE, objectNameFor, parseObjectName } = require('./naming');
const { ODDMPathError } = require('./errors');

/**
 * ODL 路径解析
 *
 * 规范：Root.ClassName['Key'].ChildClass['ChildKey']
 * - 根节点固定为 Root，路径即拓扑：父节点由上一段推导，因此无需外键表。
 * - key 支持单引号、双引号、裸数字三种写法。
 */
class PathParser {
  static parse(pathString) {
    if (typeof pathString !== 'string' || pathString.trim() === '') {
      throw new ODDMPathError('路径不能为空', { path: pathString });
    }

    const cleanPath = pathString.trim();
    if (!cleanPath.startsWith('Root')) {
      throw new ODDMPathError('路径必须以 Root 开头', { path: pathString });
    }

    const nodes = [{ object_name: 'Root', class_name: 'System', key: null, parent_name: null }];

    const body = cleanPath.slice(4).trim();
    if (body === '') {
      // "Root" 或 "Root." —— 允许尾部多余的点
      if (/^\.*$/.test(body)) return nodes;
      throw new ODDMPathError('路径必须以 Root 开头', { path: pathString });
    }

    // 先把所有合法段抽走，剩下的内容说明语法不被支持（例如末端 .body 属性访问）
    const residual = body.replace(PATH_SEGMENT_RE, '').trim();
    if (residual !== '') {
      throw new ODDMPathError(
        `无法解析的路径片段: "${residual}"（当前仅支持 .ClassName['key'] 形式的完整对象段）`,
        { path: pathString }
      );
    }

    let currentParent = 'Root';
    const pattern = new RegExp(PATH_SEGMENT_RE.source, 'g');
    let match;

    while ((match = pattern.exec(body)) !== null) {
      const className = match[1];
      const key = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4];

      if (key === undefined || key === '') {
        throw new ODDMPathError(`路径段 ${className} 缺少 key`, { path: pathString });
      }

      const objectName = objectNameFor(className, key);
      nodes.push({
        object_name: objectName,
        class_name: className,
        key,
        parent_name: currentParent,
      });
      currentParent = objectName;
    }

    if (nodes.length === 1) {
      throw new ODDMPathError(`路径未包含任何对象段: ${pathString}`, { path: pathString });
    }

    return nodes;
  }

  static extractTarget(pathString) {
    const nodes = PathParser.parse(pathString);
    return nodes[nodes.length - 1];
  }

  /** 物理标识 -> ODL 路径段，如 User/apanda -> .User['apanda'] */
  static toSegment(objectName) {
    const { className, key } = parseObjectName(objectName);
    return `.${className}['${key}']`;
  }

  static isPath(input) {
    return typeof input === 'string' && input.trim().startsWith('Root');
  }
}

/**
 * 树导航 —— 全部基于 oddm_root_index 的递归 CTE
 *
 * 递归 CTE 内置 depth 上限，防止数据库中万一存在环时查询失控。
 */
class TreeNavigator {
  static MAX_SCAN_DEPTH = 64;

  static ancestors(db, objectName) {
    const sql = `
      WITH RECURSIVE ancestor_tree AS (
        SELECT object_name, class_name, version, parent_name, 0 AS level
        FROM oddm_root_index WHERE object_name = ?
        UNION ALL
        SELECT r.object_name, r.class_name, r.version, r.parent_name, a.level + 1
        FROM oddm_root_index r
        INNER JOIN ancestor_tree a ON r.object_name = a.parent_name
        WHERE a.level < ${TreeNavigator.MAX_SCAN_DEPTH}
      )
      SELECT object_name, class_name, version, parent_name, level
      FROM ancestor_tree ORDER BY level DESC;
    `;
    return db.prepare(sql).all(objectName);
  }

  static descendants(db, parentObjectName) {
    const sql = `
      WITH RECURSIVE descendant_tree AS (
        SELECT object_name, class_name, version, parent_name, 1 AS depth
        FROM oddm_root_index WHERE parent_name = ?
        UNION ALL
        SELECT r.object_name, r.class_name, r.version, r.parent_name, d.depth + 1
        FROM oddm_root_index r
        INNER JOIN descendant_tree d ON r.parent_name = d.object_name
        WHERE d.depth < ${TreeNavigator.MAX_SCAN_DEPTH}
      )
      SELECT object_name, class_name, version, parent_name, depth
      FROM descendant_tree ORDER BY depth ASC;
    `;
    return db.prepare(sql).all(parentObjectName);
  }

  /** 从索引反解完整 ODL 路径，如 User/apanda -> Root.User['apanda'] */
  static resolveCanonicalPath(db, objectName) {
    const chain = TreeNavigator.ancestors(db, objectName);
    if (chain.length === 0) return '';

    const parts = [];
    for (const node of chain) {
      if (node.object_name === 'Root') {
        parts.push('Root');
      } else {
        parts.push(PathParser.toSegment(node.object_name));
      }
    }
    return parts.join('');
  }

  /** 节点深度：Root 为 0，其直系子节点为 1 */
  static depthOf(db, objectName) {
    const chain = TreeNavigator.ancestors(db, objectName);
    return chain.length > 0 ? chain[0].level : -1;
  }

  /**
   * 判断 candidate 是否位于 ancestor 的子树内（含自身）
   * 用于 moveTo 的环检测：把父节点挂到自己的后代下会形成环。
   */
  static isSelfOrDescendant(db, candidate, ancestor) {
    if (candidate === ancestor) return true;
    const descendants = TreeNavigator.descendants(db, ancestor);
    return descendants.some((node) => node.object_name === candidate);
  }
}

module.exports = { PathParser, TreeNavigator };
