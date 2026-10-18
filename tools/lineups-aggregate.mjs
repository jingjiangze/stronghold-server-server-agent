#!/usr/bin/env node
// tools/lineups-aggregate.mjs — 把 R2 上的学习库日期文件（只增不改的历史）聚合成可用的语料。
//
// 为什么需要：R2 里 `packs/lineup-library/<模式>__<难度>-<YYYY-MM-DD>.jsonl` 是**完整历史**（键只增不改），
// 但游戏侧读的只是「每库最新一份别名」和 4000 行滚动窗口。要做离线分析 / 训练集，就必须把历史全量拉下来
// 去重合并——这就是本工具。它**不联网**：先把 R2 前缀同步成本地目录（rclone / wrangler / CDN 仓的脚本），
// 再对目录跑本工具，口径确定、可复现、可进 CI 做数据集快照。
//
// 输入目录里认两种文件名：
//   <模式>__<难度>-<YYYY-MM-DD>.jsonl   R2 日期文件（可多层目录，按内容判断而不是路径）
//   lineups_<模式>__<难度>.jsonl        已合并的库（重复跑本工具时读自己的输出）
//
// 用法：
//   node tools/lineups-aggregate.mjs <输入目录…>                  # 只报告
//   node tools/lineups-aggregate.mjs <输入目录> --out <目录>       # 写合并后的 lineups_<键>.jsonl + stats.json
//   node tools/lineups-aggregate.mjs <输入目录> --since 2026-10-01 --max-lines 20000
//
// 去重键是记录里的 sig（cells 的规范签名）；缺 sig 的行按 cells 现算。坏行计数后丢弃，绝不写进输出。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lineupFeatures, summarizeFeatures } from '../shared/lineupFeatures.mjs';

const DATED = /^(.+?)-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MERGED = /^lineups_(.+)\.jsonl$/;

/** 与 server/lineupLibrary.js 的 sigOf 同构（cells 排序拼接）——聚合口径必须与写库端一致。 */
export function sigOf(cells) {
  return (cells || [])
    .map((c) => `${c.id}:${c.golden ? 1 : 0}:${c.row}:${c.col}:${c.dir}`)
    .sort()
    .join('|');
}

/** 从文件名解析 { key, date }；两种命名都认，认不出返回 null。 */
export function parseName(name) {
  const dated = DATED.exec(name);
  if (dated) return { key: dated[1], date: dated[2] };
  const merged = MERGED.exec(name);
  if (merged) return { key: merged[1], date: null };
  return null;
}

/** 递归收集 .jsonl 文件（深度有上限，避免误扫大目录）。 */
function collect(dir, depth = 0, out = []) {
  if (depth > 6) return out;
  let names;
  try { names = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of names) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('.')) collect(abs, depth + 1, out); }
    else if (e.name.endsWith('.jsonl')) out.push(abs);
  }
  return out;
}

/**
 * 聚合。
 * @param {string[]} inputs 目录
 * @param {{ since?: string, maxLines?: number, out?: string, log?: Function }} [opts]
 */
export function aggregate(inputs, { since = null, maxLines = 0, out = null, log = console.log } = {}) {
  const report = { files: 0, rowsIn: 0, rowsOut: 0, dupes: 0, invalid: 0, keys: {}, errors: [] };
  /** @type {Map<string, Map<string, object>>} key → sig → rec */
  const byKey = new Map();

  for (const dir of inputs || []) {
    if (!existsSync(dir)) { report.errors.push(`没有这个目录：${dir}`); continue; }
    for (const abs of collect(dir)) {
      const parsed = parseName(abs.split(/[\\/]/).pop());
      if (!parsed) continue;
      if (since && parsed.date && parsed.date < since) continue;
      report.files++;
      let text;
      try { text = readFileSync(abs, 'utf8'); } catch (e) { report.errors.push(`${abs}: ${e.message}`); continue; }
      for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        report.rowsIn++;
        let rec;
        try { rec = JSON.parse(s); } catch { report.invalid++; continue; }
        if (!rec || !Array.isArray(rec.cells) || rec.cells.length < 2) { report.invalid++; continue; }
        const sig = rec.sig && typeof rec.sig === 'string' ? rec.sig : sigOf(rec.cells);
        if (!byKey.has(parsed.key)) byKey.set(parsed.key, new Map());
        const bucket = byKey.get(parsed.key);
        if (bucket.has(sig)) { report.dupes++; continue; }
        bucket.set(sig, { ...rec, sig });
      }
    }
  }

  for (const [key, bucket] of [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let recs = [...bucket.values()].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || a.sig.localeCompare(b.sig));
    if (maxLines > 0 && recs.length > maxLines) recs = recs.slice(recs.length - maxLines); // 保留最新
    report.keys[key] = { rows: recs.length, features: summarizeFeatures(recs.map((r) => lineupFeatures(r.cells))) };
    report.rowsOut += recs.length;
    log(`${key}: ${recs.length} 行`);
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `lineups_${key}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    }
  }
  if (out) writeFileSync(join(out, 'stats.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

if (process.argv[1] && process.argv[1].endsWith('lineups-aggregate.mjs')) {
  const args = process.argv.slice(2);
  const inputs = [];
  let since = null, maxLines = 0, out = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--since') { since = args[++i]; continue; }
    if (args[i] === '--max-lines') { maxLines = Number(args[++i]) || 0; continue; }
    if (args[i] === '--out') { out = args[++i]; continue; }
    inputs.push(args[i]);
  }
  const rep = aggregate(inputs, { since, maxLines, out });
  console.log(`${out ? 'wrote' : 'report'}: ${rep.files} 个文件、${rep.rowsIn} 行 → ${rep.rowsOut} 行`
    + `（去重 ${rep.dupes}、坏行 ${rep.invalid}、${Object.keys(rep.keys).length} 个库）`
    + `${rep.errors.length ? `、${rep.errors.length} 个错误` : ''}`);
  for (const e of rep.errors) console.error('  !', e);
  process.exit(rep.errors.length ? 1 : 0);
}
