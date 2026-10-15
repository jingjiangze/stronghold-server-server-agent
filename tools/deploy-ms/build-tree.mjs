// tools/deploy-ms/build-tree.mjs — 叠加式部署树构建（上游 pristine + 声明式叠加层）。
//
// 这是「叠加式上游自动同步链」的建树步骤（替代 _tmp/upstream-deploy-audit-2026-10-13/mktree2.py 的固化版）。
// 流程：read-tree <上游SHA>^{tree} → 按 overlay.json 叠加我方文件 → write-tree。
// 门控（drift check）在 workflow 里做：overlay 里每个「改上游文件」的条目带 baseSha（上游原 blob），
// 上游一动到它 ⇒ 指名失败，防止静默把我们的接线打掉（"补丁清零遗留"的解药）。
//
// 用法：node tools/deploy-ms/build-tree.mjs --upstream <sha> [--out tree.txt]
//       环境变量 MS_DEPLOY_GIT 可指定 git 可执行（默认 git）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const git = process.env.MS_DEPLOY_GIT || 'git';

const argv = process.argv.slice(2);
const upIdx = argv.indexOf('--upstream');
const UPSTREAM = upIdx >= 0 ? argv[upIdx + 1] : null;
if (!UPSTREAM) { console.error('usage: node tools/deploy-ms/build-tree.mjs --upstream <commit-sha> [--overlay <path>] [--out tree.txt]'); process.exit(2); }
const ovIdx = argv.indexOf('--overlay');
const overlayPath = ovIdx >= 0 ? path.resolve(argv[ovIdx + 1]) : path.join(HERE, 'overlay.json');

const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
const tmpBase = process.env.TMP || process.env.TEMP || '/tmp';
const IDX = path.join(fs.mkdtempSync(path.join(tmpBase, 'ms-tree-')), 'idx');
const env = { ...process.env, GIT_INDEX_FILE: IDX };
const g = (args) => execFileSync(git, args, { env, cwd: ROOT, encoding: 'utf8' }).trim();

if (fs.existsSync(IDX)) fs.rmSync(IDX, { force: true });
g(['read-tree', UPSTREAM + '^{tree}']);
console.log('read-tree', UPSTREAM, 'ok');

const added = [];
for (const entry of overlay.entries) {
  const srcAbs = path.isAbsolute(entry.from) ? entry.from : path.join(ROOT, entry.from);
  if (!fs.existsSync(srcAbs)) throw new Error('overlay 来源不存在: ' + entry.from);
  // 门控①：改上游文件的条目必须核对 baseSha（上游原 blob）。上游动了它 ⇒ 指名失败。
  if (entry.baseSha !== undefined) {
    let current = null;
    try { current = g(['rev-parse', UPSTREAM + ':' + entry.path]); } catch { /* 上游本来没有该文件 */ }
    if (current && current !== entry.baseSha) {
      console.error(`\n✗ DRIFT: 上游 ${UPSTREAM.slice(0, 10)} 的 "${entry.path}" blob 已变（overlay 记录 ${entry.baseSha.slice(0, 10)}，现 ${current.slice(0, 10)}）`);
      console.error(`  → 该文件被我们 patch 过（${entry.note || ''}）；请先 diff 上游新版本，重打 tools/deploy-ms/patched/ 后更新 overlay.json 的 baseSha。`);
      process.exit(3);
    }
  }
  const sha = execFileSync(git, ['hash-object', '-w', '--path', entry.path, srcAbs], { cwd: ROOT, encoding: 'utf8' }).trim();
  g(['update-index', '--add', '--cacheinfo', `100644,${sha},${entry.path}`]);
  added.push(`  + ${entry.path} (${entry.kind}) ${sha.slice(0, 10)}`);
}
console.log(added.join('\n'));

const tree = g(['write-tree']);
console.log('TREE=' + tree);
if (argv.includes('--out')) {
  const out = argv[argv.indexOf('--out') + 1];
  fs.writeFileSync(path.isAbsolute(out) ? out : path.join(ROOT, out), tree);
}
// 门控②：树形自证 —— 除 overlay 清单外不得有任何差异（对着上游逐文件 diff，多/少都算失败）。
const changed = g(['diff', '--name-status', UPSTREAM + '^{tree}', tree]).split('\n').filter(Boolean);
const listed = new Set(overlay.entries.map((e) => e.path));
const unexpected = changed.filter((l) => { const p = l.slice(2).replace(/^\s+/, ''); return !listed.has(p); });   // git diff 输出是 "M	路径"（含制表符），不能固定切 4 字符
if (unexpected.length) {
  console.error('\n✗ TREE DRIFT: 以下差异不在 overlay 清单内：');
  for (const l of unexpected) console.error('  ' + l);
  process.exit(4);
}
console.log(`tree-vs-upstream diff = ${changed.length} 文件（overlay ${overlay.entries.length} 条，全部在清单内 ✓）`);
