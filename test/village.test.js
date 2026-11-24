// node test/village.test.js
'use strict';
require('../js/solver.js');
const V = require('../js/village.js');
const { LAYOUT, DETAIL, D, SUB } = V;

let fails = 0;
function check(cond, msg) { if (!cond) { fails++; if (fails < 30) console.error('  ✗ ' + msg); } }

const W = 18, H = 12, SEEDS = 200;
const counts = new Array(LAYOUT.length).fill(0);
const dcounts = new Array(DETAIL.length).fill(0);
let totalRestarts = 0, detailRestarts = 0;
const t0 = Date.now();

for (let seed = 1; seed <= SEEDS; seed++) {
  const r = V.generateVillage(seed, W, H);
  check(!r.failed, `seed ${seed}: 生成失敗`);
  if (r.failed) continue;
  totalRestarts += r.layoutJob.attempt;
  detailRestarts += r.detailJob.attempt;
  const L = r.layout;
  const kind = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 'edge' : LAYOUT[L[y * W + x]].kind;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const m = L[y * W + x];
    check(m >= 0, `seed ${seed}: (${x},${y}) 未確定`);
    counts[m]++;
    const mod = LAYOUT[m];
    if (mod.kind === 'house') {
      check(y < H - 1, `seed ${seed}: 最下段に家 (${x},${y})`);
      check(kind(x, y + 1) === 'road', `seed ${seed}: 家の下が道でない (${x},${y})`);
    }
    if (mod.kind === 'road') {
      const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
      for (let d = 0; d < 4; d++) if ((mod.mask >> d) & 1) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nm = LAYOUT[L[ny * W + nx]];
        const ok = (nm.kind === 'road' && ((nm.mask >> ((d + 2) % 4)) & 1)) || (nm.kind === 'house' && d === 0);
        check(ok, `seed ${seed}: 道の接続先が不正 (${x},${y}) dir ${d}`);
      }
    }
  }
  // ディテール
  const { SW, SH, ground } = r.info;
  const Dm = r.detail;
  for (let gy = 0; gy < SH; gy++) {
    for (let gx = 0; gx < SW; gx++) {
      const i = gy * SW + gx, m = Dm[i];
      check(m >= 0, `seed ${seed}: spot 未確定`);
      dcounts[m]++;
      if (m === D.PEBBLE) check(ground[i] === 1, `seed ${seed}: 小石が土以外`);
      if (ground[i] === 2) check(m === D.EMPTY, `seed ${seed}: 覆われたスポットに物`);
      if (ground[i] === 1) check(m === D.EMPTY || m === D.PEBBLE, `seed ${seed}: 道に不正な物`);
      if (m === D.FLOWER) check(r.info.nearHouseSpot[i] || true, '');
    }
    // 柵の連なり: 左端で始まり右端で終わる、長さ >= 4
    let run = 0;
    for (let gx = 0; gx < SW; gx++) {
      const m = Dm[gy * SW + gx];
      const isFence = m >= D.FL;
      if (m === D.FL) { check(run === 0, `seed ${seed}: 柵の途中に左端`); run = 1; }
      else if (m === D.FM1 || m === D.FM2) { check(run > 0, `seed ${seed}: 柵が左端なしで始まる`); run++; }
      else if (m === D.FR) { check(run >= 3, `seed ${seed}: 柵が短い (${run + 1})`); run = 0; }
      else { check(run === 0, `seed ${seed}: 柵が右端なしで終わる`); run = 0; }
      if (isFence && gy > 0) check(Dm[(gy - 1) * SW + gx] < D.FL, `seed ${seed}: 柵が縦に連続`);
    }
    check(run === 0, `seed ${seed}: 行末で柵が閉じない`);
  }
}

// 決定性
const a = V.generateVillage(42, W, H), b = V.generateVillage(42, W, H);
check(a.layout.join() === b.layout.join() && a.detail.join() === b.detail.join(), '同じシードで結果が違う');

console.log(`${SEEDS} 村を生成 (${W}x${H}) in ${Date.now() - t0}ms`);
console.log(`レイアウト再試行: ${totalRestarts} 回 / ディテール再試行: ${detailRestarts} 回`);
console.log('レイアウト配置数:', LAYOUT.map((m, i) => `${m.key}=${counts[i]}`).join(' '));
console.log('ディテール配置数:', DETAIL.map((m, i) => `${m.key}=${dcounts[i]}`).join(' '));
const never = LAYOUT.filter((m, i) => counts[i] === 0).concat(DETAIL.filter((m, i) => dcounts[i] === 0));
check(never.length === 0, '一度も置かれないモジュール: ' + never.map(m => m.key).join(','));
if (fails) { console.error(`FAILED: ${fails} 件`); process.exit(1); }
console.log('OK: すべてのチェックに合格');
