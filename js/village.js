/*
 * 村ジェネレーター：2 パス WFC
 *   1) レイアウトパス  … 32px グリッド相当。道 11 種 + 家 + 木 + 草地 = 14 モジュール
 *   2) ディテールパス  … 1 セルを 4×4 スポットに分割。花・キノコ・草・小石・茂み・柵
 */
(function (root) {
  'use strict';
  const W_ = root.WFC || require('./solver.js');
  const { RNG, Solver, OPP, popcount, lowBit } = W_;

  // ------------------------------------------------------------------
  // 共通: ソケットペアから互換テーブルを作る
  // ------------------------------------------------------------------
  function buildCompat(modules, pairs) {
    const ok = new Set();
    for (const [a, b] of pairs) { ok.add(a + '|' + b); ok.add(b + '|' + a); }
    const compat = [];
    for (let d = 0; d < 4; d++) {
      const arr = new Int32Array(modules.length);
      for (let a = 0; a < modules.length; a++) {
        let mask = 0;
        for (let b = 0; b < modules.length; b++) {
          if (ok.has(modules[a].sockets[d] + '|' + modules[b].sockets[OPP[d]])) mask |= 1 << b;
        }
        arr[a] = mask;
      }
      compat.push(arr);
    }
    return compat;
  }

  // ------------------------------------------------------------------
  // レイアウトモジュール
  // ------------------------------------------------------------------
  const GRASS = 0, HOUSE = 1, TREE = 2;
  const LAYOUT = [
    { key: 'grass', name: '草地', kind: 'grass', sockets: ['G', 'G', 'G', 'G'], weight: 2.2 },
    { key: 'house', name: '家', kind: 'house', sockets: ['G', 'G', 'D', 'G'], weight: 1.6 },
    { key: 'tree', name: '木', kind: 'tree', sockets: ['G', 'G', 'G', 'G'], weight: 1.4 },
  ];
  const SHAPE = { straight: 1.4, corner: 0.7, tee: 0.3, cross: 0.08 };
  const SHAPE_NAME = { straight: '道・直線', corner: '道・カーブ', tee: '道・T字', cross: '道・十字' };
  for (let mask = 0; mask < 16; mask++) {
    const c = popcount(mask);
    if (c < 2) continue; // 行き止まりなし
    let shape;
    if (c === 4) shape = 'cross';
    else if (c === 3) shape = 'tee';
    else shape = (mask === 0b0101 || mask === 0b1010) ? 'straight' : 'corner';
    const sockets = [0, 1, 2, 3].map(d => (mask >> d) & 1 ? 'R' : 's');
    const dirs = [0, 1, 2, 3].filter(d => (mask >> d) & 1).map(d => 'NESW'[d]).join('');
    LAYOUT.push({ key: 'road_' + dirs, name: SHAPE_NAME[shape] + ' ' + dirs, kind: 'road', shape, mask, sockets, weight: 0.3 * SHAPE[shape] });
  }
  const LAYOUT_PAIRS = [['R', 'R'], ['s', 'G'], ['s', 's'], ['G', 'G'], ['s', 'D'], ['D', 'R']];
  const LAYOUT_COMPAT = buildCompat(LAYOUT, LAYOUT_PAIRS);
  const LAYOUT_FULL = (1 << LAYOUT.length) - 1;

  function createLayoutSolver(seed, W, H) {
    const rng = new RNG(seed);
    const N = W * H, n = LAYOUT.length;
    const domains = new Int32Array(N).fill(LAYOUT_FULL);
    // 単項ルール: 最下段には家を置かない（ドアの前に道が必要）
    for (let x = 0; x < W; x++) domains[(H - 1) * W + x] &= ~(1 << HOUSE);
    const weights = new Float64Array(N * n);
    for (let i = 0; i < N; i++) for (let m = 0; m < n; m++) weights[i * n + m] = LAYOUT[m].weight;
    const s = new Solver({ W, H, n, compat: LAYOUT_COMPAT, weights, domains, rng, noise: 0.05 });
    s.init();
    // 最初の一手: 中央 4 セルのどれかに家を置く → 村がひと塊で外へ育つ
    const cx = Math.floor(W / 2) - 1, cy = Math.floor(H / 2) - 1;
    const mids = [cy * W + cx, cy * W + cx + 1, (cy + 1) * W + cx, (cy + 1) * W + cx + 1];
    const first = mids[Math.floor(rng.next() * 4)];
    const e = s.entropyOf(first), opts = popcount(s.domains[first]);
    s.collapse(first, HOUSE);
    s.steps = 1;
    s.last = { cell: first, module: HOUSE, entropy: e, options: opts, step: 1, forced: true };
    s.firstHouse = first;
    return s;
  }

  /** 矛盾したら次のシードで再挑戦するレイアウトジョブ */
  class LayoutJob {
    constructor(seed, W, H, maxAttempts = 50) {
      this.seed = seed; this.W = W; this.H = H; this.maxAttempts = maxAttempts;
      this.attempt = 0; this.contradictions = 0; this.totalSteps = 0;
      this.failed = false; this.pendingRestart = false;
      this.solver = createLayoutSolver(seed, W, H);
    }
    get done() { return this.solver.done && !this.pendingRestart; }
    step() {
      if (this.failed) return 'failed';
      if (this.pendingRestart) {
        this.pendingRestart = false;
        this.attempt++;
        if (this.attempt >= this.maxAttempts) { this.failed = true; return 'failed'; }
        this.solver = createLayoutSolver(this.seed + this.attempt, this.W, this.H);
        return 'restart';
      }
      const r = this.solver.step();
      if (r === 'picked') this.totalSteps++;
      if (r === 'contradiction') { this.contradictions++; this.pendingRestart = true; }
      return r;
    }
    runToEnd() {
      let r;
      do { r = this.step(); } while (r !== 'done' && r !== 'failed');
      return r;
    }
    modules() {
      const s = this.solver, out = new Int16Array(s.N);
      for (let i = 0; i < s.N; i++) out[i] = s.moduleAt(i);
      return out;
    }
  }

  // ------------------------------------------------------------------
  // スポット（8px 相当）の地面判定  ※描画とディテールパスで共有
  // ------------------------------------------------------------------
  const SUB = 4; // 1 セル = 4×4 スポット

  /** layoutMods: Int16Array(W*H)、未確定は -1。戻り値 Uint8Array(SW*SH) 1=土 */
  function dirtMap(layoutMods, W, H) {
    const SW = W * SUB, SH = H * SUB;
    const D = new Uint8Array(SW * SH);
    for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) {
      const m = layoutMods[cy * W + cx];
      if (m < 0) continue;
      const mod = LAYOUT[m];
      if (mod.kind === 'road') {
        const k = mod.mask;
        for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) {
          const midX = sx === 1 || sx === 2, midY = sy === 1 || sy === 2;
          const dirt = (midX && midY) ||
            ((k & 1) && midX && sy === 0) || ((k & 4) && midX && sy === 3) ||
            ((k & 2) && midY && sx === 3) || ((k & 8) && midY && sx === 0);
          if (dirt) D[(cy * SUB + sy) * SW + cx * SUB + sx] = 1;
        }
      } else if (mod.kind === 'house' && cy + 1 < H) {
        // 玄関前の小道（下のセルの上 2 スポット）
        for (let sy = 0; sy < 2; sy++) for (let sx = 1; sx <= 2; sx++)
          D[((cy + 1) * SUB + sy) * SW + cx * SUB + sx] = 1;
      }
    }
    return D;
  }

  // ------------------------------------------------------------------
  // ディテールモジュール
  // ------------------------------------------------------------------
  const D_EMPTY = 0, D_FLOWER = 1, D_MUSH = 2, D_TUFT = 3, D_PEBBLE = 4, D_BUSH = 5,
    D_FL = 6, D_FM1 = 7, D_FM2 = 8, D_FR = 9;
  const O = ['o', 'o', 'o', 'o'];
  const DETAIL = [
    { key: 'empty', name: '空き', sockets: O },
    { key: 'flower', name: '花', sockets: O },
    { key: 'mushroom', name: 'キノコ', sockets: O },
    { key: 'tuft', name: '草むら', sockets: O },
    { key: 'pebble', name: '小石', sockets: O },
    { key: 'bush', name: '茂み', sockets: O },
    { key: 'fenceL', name: '柵・左端', sockets: ['x', 'Le', 'x', 'o'] },
    { key: 'fenceM1', name: '柵・中1', sockets: ['x', 'M1e', 'x', 'M1w'] },
    { key: 'fenceM2', name: '柵・中2', sockets: ['x', 'M2e', 'x', 'M2w'] },
    { key: 'fenceR', name: '柵・右端', sockets: ['x', 'o', 'x', 'Rw'] },
  ];
  const DETAIL_PAIRS = [['o', 'o'], ['o', 'x'], ['Le', 'M1w'], ['M1e', 'M2w'], ['M2e', 'Rw'], ['M2e', 'M1w']];
  const DETAIL_COMPAT = buildCompat(DETAIL, DETAIL_PAIRS);

  /** レイアウトからスポットごとの地面種別を作る: 0=草 1=土 2=覆われている */
  function spotInfo(layoutMods, W, H) {
    const SW = W * SUB, SH = H * SUB;
    const dirt = dirtMap(layoutMods, W, H);
    const ground = new Uint8Array(SW * SH);
    const kindAt = (cx, cy) => (cx < 0 || cy < 0 || cx >= W || cy >= H) ? null : LAYOUT[layoutMods[cy * W + cx]].kind;
    const nearHouseCell = new Uint8Array(W * H), nearTreeCell = new Uint8Array(W * H);
    for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const k = kindAt(cx + dx, cy + dy);
        if (k === 'house') nearHouseCell[cy * W + cx] = 1;
        if (k === 'tree') nearTreeCell[cy * W + cx] = 1;
      }
    }
    for (let gy = 0; gy < SH; gy++) for (let gx = 0; gx < SW; gx++) {
      const i = gy * SW + gx, cx = (gx / SUB) | 0, cy = (gy / SUB) | 0, sy = gy % SUB;
      const k = kindAt(cx, cy);
      if (dirt[i]) ground[i] = 1;
      else if (k === 'house') ground[i] = 2;
      else if (k === 'tree' && sy < 3) ground[i] = 2;
      else {
        // 家や木のスプライトが上に張り出す → 上のセルの最下段には何も置かない
        const below = kindAt(cx, cy + 1);
        if (sy === 3 && (below === 'house' || below === 'tree')) ground[i] = 2;
      }
    }
    // 家の足元から 1 スポット以内（花の判定）
    const nearHouseSpot = new Uint8Array(SW * SH);
    for (let gy = 0; gy < SH; gy++) for (let gx = 0; gx < SW; gx++) {
      for (let dy = -1; dy <= 1 && !nearHouseSpot[gy * SW + gx]; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = gx + dx, y = gy + dy;
        if (x < 0 || y < 0 || x >= SW || y >= SH) continue;
        if (kindAt((x / SUB) | 0, (y / SUB) | 0) === 'house') { nearHouseSpot[gy * SW + gx] = 1; break; }
      }
    }
    return { SW, SH, dirt, ground, nearHouseCell, nearTreeCell, nearHouseSpot };
  }

  function createDetailSolver(layoutMods, W, H, firstHouse, seed) {
    const info = spotInfo(layoutMods, W, H);
    const { SW, SH, ground } = info;
    const N = SW * SH, n = DETAIL.length;
    const domains = new Int32Array(N);
    const weights = new Float64Array(N * n);
    for (let gy = 0; gy < SH; gy++) for (let gx = 0; gx < SW; gx++) {
      const i = gy * SW + gx, cell = ((gy / SUB) | 0) * W + ((gx / SUB) | 0);
      const w = new Float64Array(n);
      const g = ground[i];
      if (g === 2) { w[D_EMPTY] = 1; }
      else if (g === 1) { w[D_EMPTY] = 5; w[D_PEBBLE] = 0.55; }
      else {
        w[D_EMPTY] = 5;
        w[D_TUFT] = 0.9;
        w[D_BUSH] = 0.12;
        w[D_MUSH] = info.nearTreeCell[cell] ? 0.55 : 0.03;
        w[D_FLOWER] = info.nearHouseSpot[i] ? 2.2 : 0.07;
        if (info.nearHouseCell[cell]) { // 家の庭だけ柵が立つ
          w[D_FL] = 0.22; w[D_FM1] = 1; w[D_FM2] = 1; w[D_FR] = 1.3;
        }
        // マップ端で柵が途切れないように
        if (gx === SW - 1) { w[D_FL] = 0; w[D_FM1] = 0; w[D_FM2] = 0; }
        if (gx === 0) { w[D_FM1] = 0; w[D_FM2] = 0; w[D_FR] = 0; }
      }
      let mask = 0;
      for (let m = 0; m < n; m++) { weights[i * n + m] = w[m]; if (w[m] > 0) mask |= 1 << m; }
      domains[i] = mask;
    }
    const rng = new RNG(seed);
    const s = new Solver({ W: SW, H: SH, n, compat: DETAIL_COMPAT, weights, domains, rng, noise: 0.3 });
    s.info = info;
    if (!s.init()) return s;
    // 最初の家の玄関に一番近い草地スポットから始める
    const hx = (firstHouse % W) * SUB + 1.5, hy = ((firstHouse / W) | 0) * SUB + SUB;
    let best = -1, bd = Infinity;
    for (let i = 0; i < N; i++) {
      if (s.decided[i] || ground[i] !== 0) continue;
      const dx = (i % SW) - hx, dy = ((i / SW) | 0) - hy, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) {
      const e = s.entropyOf(best), opts = popcount(s.domains[best]);
      const m = s.pickModule(best);
      s.collapse(best, m);
      s.steps = 1;
      s.last = { cell: best, module: m, entropy: e, options: opts, step: 1 };
    }
    return s;
  }

  class DetailJob {
    constructor(layoutMods, W, H, firstHouse, seed, maxAttempts = 20) {
      Object.assign(this, { layoutMods, W, H, firstHouse, seed, maxAttempts });
      this.attempt = 0; this.contradictions = 0; this.failed = false; this.pendingRestart = false;
      this.solver = createDetailSolver(layoutMods, W, H, firstHouse, seed);
    }
    get done() { return this.solver.done && !this.pendingRestart; }
    step() {
      if (this.failed) return 'failed';
      if (this.pendingRestart) {
        this.pendingRestart = false;
        this.attempt++;
        if (this.attempt >= this.maxAttempts) { this.failed = true; return 'failed'; }
        this.solver = createDetailSolver(this.layoutMods, this.W, this.H, this.firstHouse, this.seed + this.attempt * 101);
        return 'restart';
      }
      const r = this.solver.step();
      if (r === 'contradiction') { this.contradictions++; this.pendingRestart = true; }
      return r;
    }
    runToEnd() {
      let r;
      do { r = this.step(); } while (r !== 'done' && r !== 'failed');
      return r;
    }
    modules() {
      const s = this.solver, out = new Int16Array(s.N);
      for (let i = 0; i < s.N; i++) out[i] = s.moduleAt(i);
      return out;
    }
  }

  /** 一括生成（テスト・即時生成用） */
  function generateVillage(seed, W, H) {
    const lj = new LayoutJob(seed, W, H);
    if (lj.runToEnd() === 'failed') return { failed: true, layoutJob: lj };
    const layout = lj.modules();
    const dj = new DetailJob(layout, W, H, lj.solver.firstHouse, seed * 31 + 7);
    dj.runToEnd();
    return { failed: dj.failed, layoutJob: lj, detailJob: dj, layout, detail: dj.modules(), info: dj.solver.info };
  }

  const api = {
    LAYOUT, LAYOUT_COMPAT, LAYOUT_PAIRS, GRASS, HOUSE, TREE,
    DETAIL, DETAIL_COMPAT, DETAIL_PAIRS,
    D: { EMPTY: D_EMPTY, FLOWER: D_FLOWER, MUSH: D_MUSH, TUFT: D_TUFT, PEBBLE: D_PEBBLE, BUSH: D_BUSH, FL: D_FL, FM1: D_FM1, FM2: D_FM2, FR: D_FR },
    SUB, dirtMap, spotInfo, LayoutJob, DetailJob, generateVillage,
  };
  root.WFC = Object.assign(root.WFC || {}, { Village: api });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
