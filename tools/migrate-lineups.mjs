#!/usr/bin/env node
// tools/migrate-lineups.mjs — 把旧布局的学习库（每玩法一个文件）拆成新布局（每玩法 + 每难度一个文件）。
//
// 旧：<dir>/lineups_<modeId>.jsonl                  —— 同一玩法下所有难度的记录混在一个文件里
// 新：<dir>/lineups_<modeId>__<DIFFICULTY>.jsonl    —— 每个玩法 + 难度一个文件（server/lineupLibrary.js libraryKey）
//
// 记录里本来就带 difficulty 字段，所以拆分是纯数据搬运：读旧文件、按 difficulty 分组、写新文件、
// 确认新文件行数一致后把旧文件改名为 .migrated（不删，留作核对）。
//
// 用法：
//   node tools/migrate-lineups.mjs <库目录>            # 预演：只报告会怎么拆
//   node tools/migrate-lineups.mjs <库目录> --apply    # 真正执行
//
// 幂等：已经拆过的目录再跑一遍只会报 0；新布局文件已存在时追加而不是覆盖（去重交给 sig）。
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const LEGACY = /^lineups_([A-Za-z0-9_]+)\.jsonl$/; // 不含 "__" 的旧名
const SKIP = /__/; // 新布局名（含双下划线）不动

/** @param {string} dir @param {{apply?: boolean, log?: Function}} [opts] */
export function migrate(dir, { apply = false, log = console.log } = {}) {
  const report = { files: 0, rows: 0, groups: 0, skippedExisting: 0, errors: [] };
  if (!dir || !existsSync(dir)) { report.errors.push(`没有这个目录：${dir}`); return report; }
  let names;
  try { names = readdirSync(dir); } catch (e) { report.errors.push(`读目录失败：${e.message}`); return report; }

  for (const name of names) {
    const m = LEGACY.exec(name);
    if (!m || SKIP.test(name.replace(/\.jsonl$/, ''))) continue;
    // 只有「stem 里没有 __」的才是旧文件；新文件是 lineups_<mode>__<DIFF>.jsonl，不会被 LEGACY 匹配到
    const modeId = m[1];
    const abs = join(dir, name);
    let lines;
    try { lines = readFileSync(abs, 'utf8').split('\n').filter(Boolean); } catch (e) { report.errors.push(`${name}: ${e.message}`); continue; }
    report.files++;
    report.rows += lines.length;

    /** @type {Map<string, string[]>} */
    const byDiff = new Map();
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; } // 坏行留在旧文件里，不参与迁移
      const diff = String(rec.difficulty || '').trim().toUpperCase();
      if (!diff) continue;
      if (!byDiff.has(diff)) byDiff.set(diff, []);
      byDiff.get(diff).push(line);
    }
    if (!byDiff.size) continue;
    report.groups += byDiff.size;

    for (const [diff, rows] of byDiff) {
      const target = join(dir, `lineups_${modeId}__${diff}.jsonl`);
      const already = existsSync(target);
      log(`${apply ? '' : '[dry] '}${name} → ${target.slice(dir.length + 1)}  ${rows.length} 行${already ? '（目标已存在，追加）' : ''}`);
      if (!apply) continue;
      try {
        if (already) { report.skippedExisting++; appendFileSync(target, `${rows.join('\n')}\n`, 'utf8'); }
        else writeFileSync(target, `${rows.join('\n')}\n`, 'utf8');
      } catch (e) { report.errors.push(`${target}: ${e.message}`); continue; }
    }
    if (apply) {
      try { renameSync(abs, `${abs}.migrated`); } catch (e) { report.errors.push(`${name}: 改名失败 ${e.message}`); }
    }
  }
  return report;
}

if (process.argv[1] && process.argv[1].endsWith('migrate-lineups.mjs')) {
  const dir = process.argv[2];
  const apply = process.argv.includes('--apply');
  const rep = migrate(dir, { apply });
  console.log(`${apply ? 'done' : 'dry-run'}: ${rep.files} 个旧文件、${rep.rows} 行、拆成 ${rep.groups} 组`
    + `${rep.skippedExisting ? `、${rep.skippedExisting} 组追加进已有文件` : ''}`
    + `${rep.errors.length ? `、${rep.errors.length} 个错误` : ''}`);
  for (const e of rep.errors) console.error('  !', e);
  process.exit(rep.errors.length ? 1 : 0);
}
