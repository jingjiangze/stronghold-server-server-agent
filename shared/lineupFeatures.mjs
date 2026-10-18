// shared/lineupFeatures.mjs — 布阵的特征提取（纯函数，浏览器与 Node 通用）。
//
// 为什么要有这一层：离线聚合（R2 的日期文件）与客户端评分都要把「一条布阵」变成可比较、可统计的数字。
// 这里只做**可证伪、无副作用**的几何统计——不猜强度、不碰战斗规则，强度由 rehearsal 的模拟结果给。
// 浏览器侧（Worker / 页内）与 Node 侧（聚合工具、测试）共用同一份实现，避免两边口径漂移。
//
// 输入是 lineupLibrary 记录的 cells：{ id, golden, row, col, dir }（坐标是玩家自己的棋盘坐标）。
// 输出是一个扁平对象，字段稳定、可 JSON 化、可直接做均值/分位数聚合。

/** 朝向名（与 server/sim/dir.js 的 dirName 一致）。 */
export const FACINGS = Object.freeze(['UP', 'DOWN', 'LEFT', 'RIGHT']);

/**
 * @typedef {object} LineupFeatures
 * @property {number} n            棋子数
 * @property {number} golden       金色（精二/异格等）棋子数
 * @property {number} rowMin @property {number} rowMax @property {number} rowMean
 * @property {number} colMin @property {number} colMax @property {number} colSpread
 * @property {Record<string, number>} facings  每个朝向的棋子数
 * @property {number} depthShare   落在「前半场」（row ≤ 中位行）的棋子占比，0..1
 * @property {number} centroidDist 到场地几何中心的平均切比雪夫距离
 */

/**
 * 一条布阵的特征。空/坏输入返回 null（调用方据此跳过，不要编造数字）。
 * @param {Array<{id?: string, golden?: boolean, row?: number, col?: number, dir?: string}>} cells
 * @param {{ rows?: number, cols?: number }} [field] 场地尺寸（默认按记录里的极值推断）
 * @returns {LineupFeatures | null}
 */
export function lineupFeatures(cells, field = {}) {
  if (!Array.isArray(cells) || !cells.length) return null;
  const ok = cells.filter((c) => c && Number.isFinite(c.row) && Number.isFinite(c.col));
  if (!ok.length) return null;

  let rowMin = Infinity, rowMax = -Infinity, colMin = Infinity, colMax = -Infinity;
  let golden = 0;
  const facings = Object.fromEntries(FACINGS.map((f) => [f, 0]));
  for (const c of ok) {
    if (c.golden) golden++;
    if (c.row < rowMin) rowMin = c.row;
    if (c.row > rowMax) rowMax = c.row;
    if (c.col < colMin) colMin = c.col;
    if (c.col > colMax) colMax = c.col;
    const dir = String(c.dir || '').toUpperCase();
    if (dir in facings) facings[dir]++;
  }
  const rowMean = ok.reduce((s, c) => s + c.row, 0) / ok.length;
  const rows = Number.isFinite(field.rows) && field.rows > 0 ? field.rows : rowMax + 1;
  const cols = Number.isFinite(field.cols) && field.cols > 0 ? field.cols : colMax + 1;
  const midRow = (rows - 1) / 2;
  const cr = (rows - 1) / 2, cc = (cols - 1) / 2;
  const centroidDist = ok.reduce((s, c) => s + Math.max(Math.abs(c.row - cr), Math.abs(c.col - cc)), 0) / ok.length;
  const front = ok.filter((c) => c.row <= midRow).length;

  return {
    n: ok.length,
    golden,
    rowMin, rowMax, rowMean,
    colMin, colMax, colSpread: colMax - colMin,
    facings,
    depthShare: front / ok.length,
    centroidDist,
  };
}

/**
 * 把一批特征压成可读的汇总（均值 / 中位数 / 极值）。离线聚合与客户端上报都用它。
 * @param {LineupFeatures[]} list
 */
export function summarizeFeatures(list) {
  const rows = (list || []).filter(Boolean);
  if (!rows.length) return { count: 0 };
  const mean = (pick) => rows.reduce((s, f) => s + pick(f), 0) / rows.length;
  const median = (pick) => {
    const v = rows.map(pick).sort((a, b) => a - b);
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const facings = Object.fromEntries(FACINGS.map((f) => [f, rows.reduce((s, x) => s + (x.facings[f] || 0), 0)]));
  return {
    count: rows.length,
    nMean: mean((f) => f.n),
    goldenMean: mean((f) => f.golden),
    rowMean: mean((f) => f.rowMean),
    rowMeanMedian: median((f) => f.rowMean),
    colSpreadMean: mean((f) => f.colSpread),
    depthShareMean: mean((f) => f.depthShare),
    centroidDistMean: mean((f) => f.centroidDist),
    facings,
  };
}
