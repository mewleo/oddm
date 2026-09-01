#!/usr/bin/env node
'use strict';

/**
 * ODDM 命令行工具
 *
 *   node bin/oddm.js inspect <db路径> [--json] [--depth 3] [--sql]
 *   node bin/oddm.js classes <db路径>
 *   node bin/oddm.js path <db路径> <物理标识>     反解完整 ODL 路径
 *
 * 设计目的：部署与调试时不必写代码即可看清库的结构，
 * 同时 --json 输出可直接喂给 AI 工具链。
 */

const path = require('node:path');
const { Client, DBHelper } = require('../src/oddm');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') args.json = true;
    else if (token === '--sql') args.sql = true;
    else if (token === '--depth') args.depth = Number(argv[++i]);
    else if (token === '--help' || token === '-h') args.help = true;
    else args._.push(token);
  }
  return args;
}

function usage() {
  console.log(`
ODDM 命令行工具

用法:
  node bin/oddm.js inspect <db路径> [--json] [--depth N]   输出全库自省快照
  node bin/oddm.js classes <db路径>                        仅列出已注册的类
  node bin/oddm.js path <db路径> <物理标识>                 反解完整 ODL 路径

选项:
  --json     以 JSON 输出（供工具链消费）
  --depth N  对象树展开层数，默认 2
  --sql      同时打印 APL 的 SQL 日志
`);
}

function openClient(dbPath, args) {
  if (!dbPath) {
    console.error('缺少数据库路径');
    usage();
    process.exit(1);
  }
  const resolved = path.resolve(process.cwd(), dbPath);
  return new Client({ path: resolved, apl: args.sql ? 'debug' : 'off' });
}

function printHuman(snap) {
  console.log(`ODDM 自省快照`);
  console.log(`  ODL 语法 : ${snap.odlSyntax}`);
  console.log(`  深度上限 : ${snap.maxDepth} | strict: ${snap.strict}`);
  console.log(`  对象总数 : ${snap.stats.totalObjects} | 最大深度: ${snap.stats.maxDepth}`);

  console.log('\n已注册类:');
  for (const cls of snap.classes) {
    console.log(`\n  ${cls.className} V${cls.version}  ->  ${cls.table}`);
    console.log(`    实例数: ${cls.instanceCount}`);
    console.log(`    示例路径: ${cls.samplePath}`);
    const schema = Object.entries(cls.schema)
      .map(([attr, type]) => `${attr}:${type}`)
      .join(', ');
    console.log(`    schema: ${schema}`);
    if (cls.sampleObject) {
      console.log(`    示例对象: ${JSON.stringify(cls.sampleObject)}`);
    }
  }

  console.log('\n对象树:');
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      console.log(`${'    '.repeat(depth + 1)}${node.path}  [${node.className}]`);
      walk(node.children, depth + 1);
    }
  };
  console.log('    Root');
  walk(snap.tree.nodes, 1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (args.help || !command) {
    usage();
    return;
  }

  if (command === 'inspect') {
    const client = openClient(args._[1], args);
    const snap = client.introspect({ treeDepth: args.depth || 2 });
    if (args.json) console.log(JSON.stringify(snap, null, 2));
    else printHuman(snap);
    client.close();
    return;
  }

  if (command === 'classes') {
    const client = openClient(args._[1], args);
    const rows = client.meta.listClasses();
    if (args.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      for (const row of rows) {
        const attrs = Object.entries(row.schema)
          .map(([k, v]) => `${k}:${v}`)
          .join(', ');
        console.log(`${row.className} V${row.version}  ${row.table}  {${attrs}}`);
      }
    }
    client.close();
    return;
  }

  if (command === 'path') {
    const client = openClient(args._[1], args);
    const helper = new DBHelper(client);
    const target = args._[2];
    if (!target) {
      console.error('缺少物理标识，例如 User/apanda');
      process.exit(1);
    }
    const full = helper.canonicalPath(target);
    console.log(full || `未找到对象: ${target}`);
    client.close();
    return;
  }

  console.error(`未知命令: ${command}`);
  usage();
  process.exit(1);
}

main();
