/*
 * 汎用 Wave Function Collapse ソルバー（シンプルタイル／ソケット方式）
 *  - 各セルの候補はビットマスク（最大 31 モジュール）
 *  - セルごとの重み → シャノンエントロピー + 微小ノイズで同点崩し
 *  - 確定済みセルに隣接する「フロンティア」から優先して選ぶ
 *  - スタックベースの伝播（アーク整合）
 *  - Park–Miller 乱数で完全に再現可能
 */
(function (root) {
  'use strict';

  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // N E S W
  const OPP = [2, 3, 0, 1];

  // ---- Park–Miller (minimal standard) RNG ----
  class RNG {
    constructor(seed) {
      let s = Math.floor(Math.abs(seed)) % 2147483647;
      if (s <= 0) s += 2147483646;
      this.state = s;
    }
    nextInt() {
      this.state = (this.state * 16807) % 2147483647;
      return this.state;
    }
    next() { return (this.nextInt() - 1) / 2147483646; }
  }

  function popcount(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  function lowBit(x) { return 31 - Math.clz32(x & -x); }

  class Solver {
    /**
     * @param {object} o
     *  W,H         グリッドサイズ
     *  n           モジュール数
     *  compat      compat[dir][m] = dir 方向の隣に置けるモジュールのマスク
     *  weights     Float64Array(W*H*n) セルごとの重み
     *  domains     Int32Array(W*H) 初期候補（単項ルール適用済み）
     *  rng         RNG
     *  noise       エントロピーに足す乱数ノイズの最大値
     */
    constructor(o) {
      this.W = o.W; this.H = o.H; this.n = o.n;
      this.compat = o.compat;
      this.weights = o.weights;
      this.rng = o.rng;
      this.noise = o.noise;
      const N = this.W * this.H;
      this.N = N;
      this.domains = Int32Array.from(o.domains);
      this.decided = new Uint8Array(N);
      this.frontier = new Uint8Array(N);
      this.picked = new Uint8Array(N);
      this.order = new Int32Array(N).fill(-1); // 確定した順番（描画アニメ用）
      this.entropy = new Float64Array(N);
      this.entDirty = new Uint8Array(N).fill(1);
      this.supportCache = [new Map(), new Map(), new Map(), new Map()];
      this.started = false;
      this.steps = 0;
      this.decidedCount = 0;
      this.contradiction = -1;
      this.done = false;
      this.last = null;
      this.changed = []; // 直近ステップで確定したセル（描画差分用）
    }

    neighbor(i, d) {
      const x = (i % this.W) + DIRS[d][0];
      const y = ((i / this.W) | 0) + DIRS[d][1];
      if (x < 0 || y < 0 || x >= this.W || y >= this.H) return -1;
      return y * this.W + x;
    }

    support(d, dom) {
      const cache = this.supportCache[d];
      let s = cache.get(dom);
      if (s === undefined) {
        s = 0;
        let m = dom;
        while (m) { const b = lowBit(m); s |= this.compat[d][b]; m &= m - 1; }
        cache.set(dom, s);
      }
      return s;
    }

    markDecided(i) {
      if (this.decided[i]) return;
      this.decided[i] = 1;
      this.order[i] = this.decidedCount++;
      this.changed.push(i);
      if (this.started) {
        for (let d = 0; d < 4; d++) {
          const nb = this.neighbor(i, d);
          if (nb >= 0) this.frontier[nb] = 1;
        }
      }
    }

    /** 単項ルールを全体に伝播させる。false なら初期状態で矛盾。 */
    init() {
      const stack = [];
      for (let i = 0; i < this.N; i++) {
        if (this.domains[i] === 0) { this.contradiction = i; return false; }
        stack.push(i);
      }
      const ok = this.propagate(stack);
      for (let i = 0; i < this.N; i++) if (popcount(this.domains[i]) === 1) this.markDecided(i);
      this.started = true;
      this.changed.length = 0;
      return ok;
    }

    propagate(stack) {
      while (stack.length) {
        const c = stack.pop();
        const dom = this.domains[c];
        for (let d = 0; d < 4; d++) {
          const nb = this.neighbor(c, d);
          if (nb < 0) continue;
          const nd = this.domains[nb] & this.support(d, dom);
          if (nd !== this.domains[nb]) {
            if (nd === 0) { this.domains[nb] = 0; this.contradiction = nb; return false; }
            this.domains[nb] = nd;
            this.entDirty[nb] = 1;
            if (this.started && popcount(nd) === 1) this.markDecided(nb);
            stack.push(nb);
          }
        }
      }
      return true;
    }

    entropyOf(i) {
      if (!this.entDirty[i]) return this.entropy[i];
      const base = i * this.n;
      let sw = 0, swl = 0, m = this.domains[i];
      while (m) {
        const b = lowBit(m); m &= m - 1;
        const w = this.weights[base + b];
        if (w > 0) { sw += w; swl += w * Math.log(w); }
      }
      const e = sw > 0 ? Math.log(sw) - swl / sw : 0;
      this.entropy[i] = e;
      this.entDirty[i] = 0;
      return e;
    }

    pickCell() {
      let best = -1, bestE = Infinity;
      let anyFrontier = false;
      for (let pass = 0; pass < 2 && best < 0; pass++) {
        for (let i = 0; i < this.N; i++) {
          if (this.decided[i]) continue;
          if (pass === 0 && !this.frontier[i]) continue;
          anyFrontier = true;
          const e = this.entropyOf(i) + this.rng.next() * this.noise;
          if (e < bestE) { bestE = e; best = i; }
        }
        if (pass === 0 && anyFrontier) break;
      }
      return best;
    }

    pickModule(i) {
      const base = i * this.n;
      let m = this.domains[i], total = 0;
      while (m) { const b = lowBit(m); m &= m - 1; total += Math.max(0, this.weights[base + b]); }
      let r = this.rng.next() * total;
      m = this.domains[i];
      let lastB = lowBit(m);
      while (m) {
        const b = lowBit(m); m &= m - 1;
        const w = Math.max(0, this.weights[base + b]);
        lastB = b;
        if (total <= 0) return b;
        if (r < w) return b;
        r -= w;
      }
      return lastB;
    }

    /** セル i をモジュール m に確定させて伝播 */
    collapse(i, m) {
      this.changed.length = 0;
      this.domains[i] = 1 << m;
      this.entDirty[i] = 1;
      this.picked[i] = 1;
      this.decided[i] = 0;
      this.markDecided(i);
      for (let d = 0; d < 4; d++) { const nb = this.neighbor(i, d); if (nb >= 0) this.frontier[nb] = 1; }
      return this.propagate([i]);
    }

    /** 1 ステップ進める。戻り値: 'picked' | 'done' | 'contradiction' */
    step() {
      if (this.contradiction >= 0) return 'contradiction';
      if (this.done) return 'done';
      const i = this.pickCell();
      if (i < 0) { this.done = true; this.changed.length = 0; return 'done'; }
      const entropy = this.entropyOf(i);
      const options = popcount(this.domains[i]);
      const m = this.pickModule(i);
      this.steps++;
      const ok = this.collapse(i, m);
      this.last = { cell: i, module: m, entropy, options, step: this.steps };
      if (!ok) return 'contradiction';
      return 'picked';
    }

    run(maxSteps = Infinity) {
      let r = 'picked', k = 0;
      while (r === 'picked' && k++ < maxSteps) r = this.step();
      return r;
    }

    moduleAt(i) { return this.decided[i] ? lowBit(this.domains[i]) : -1; }
  }

  const api = { RNG, Solver, DIRS, OPP, popcount, lowBit };
  root.WFC = Object.assign(root.WFC || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
