/*
 * 描画: 手続き的スプライト + ノイズ地面 + 昼夜ライティング + 環境アニメーション
 */
(function (root) {
  'use strict';
  const V = root.WFC.Village;
  const { LAYOUT, DETAIL, D, SUB } = V;

  // ---------------- ユーティリティ ----------------
  function hash2(x, y, s) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }
  function vnoise(x, y, s) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, s, oct) {
    let t = 0, amp = 0.5, f = 1, norm = 0;
    for (let o = 0; o < oct; o++) { t += vnoise(x * f, y * f, s + o * 17) * amp; norm += amp; amp *= 0.5; f *= 2.03; }
    return t / norm;
  }
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  function shade(h, k) { // k>0 明るく / k<0 暗く
    const c = hex(h).map(v => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k)));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  function pick(arr, r) { return arr[Math.floor(r * arr.length) % arr.length]; }

  const ROOFS = ['#c4553b', '#b8452f', '#4e6c8c', '#6d7f3a', '#7d4a6c', '#c98a2e', '#a04a3a', '#3f5f6e'];
  const WALLS = ['#f3e6c8', '#efe2d0', '#e8d2b0', '#f6efe2', '#dcc6a4', '#e9dcc0'];
  const FLOWERS = ['#ff7aa8', '#ffd84d', '#ffffff', '#b58cff', '#ff8f5a', '#7fd3ff'];

  // ---------------- 地面のカラー ----------------
  const G1 = hex('#5f9a3f'), G2 = hex('#8ec25a'), G3 = hex('#4d8735');
  const DIRT1 = hex('#c79e68'), DIRT2 = hex('#a98150'), RIM = hex('#6e5233');

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.staticCanvas = document.createElement('canvas');
      this.groundCanvas = document.createElement('canvas');
      this.particles = [];
      this.fireflies = [];
      this.lights = [];
      this.chimneys = [];
      this.night = 0;
      this.lastEmit = 0;
    }

    setup(W, H, C, seed, dpr) {
      this.W = W; this.H = H; this.C = C; this.seed = seed;
      this.S = C / SUB;
      this.cw = W * C; this.ch = H * C;
      this.dpr = dpr || Math.min(window.devicePixelRatio || 1, 2);
      const c = this.canvas;
      c.width = Math.round(this.cw * this.dpr); c.height = Math.round(this.ch * this.dpr);
      c.style.aspectRatio = `${this.cw} / ${this.ch}`;
      this.staticCanvas.width = c.width; this.staticCanvas.height = c.height;
      // 地面はピクセル単位で生成するので解像度を少し抑える
      this.gs = Math.min(this.dpr, 2200 / this.cw);
      const gw = Math.round(this.cw * this.gs), gh = Math.round(this.ch * this.gs);
      this.groundCanvas.width = gw; this.groundCanvas.height = gh;
      this.gctx = this.groundCanvas.getContext('2d');
      this.gimg = this.gctx.createImageData(gw, gh);
      this.nLow = new Float32Array(gw * gh);
      this.nMid = new Float32Array(gw * gh);
      this.nHi = new Float32Array(gw * gh);
      for (let py = 0; py < gh; py++) for (let px = 0; px < gw; px++) {
        const lx = px / this.gs, ly = py / this.gs, i = py * gw + px;
        this.nLow[i] = fbm(lx / 90, ly / 90, 11, 3);
        this.nMid[i] = fbm(lx / 9, ly / 9, 23, 2);
        this.nHi[i] = hash2(px, py, 5);
      }
      this.prevMods = new Int16Array(W * H).fill(-2);
      this.dirt = new Float32Array(W * SUB * H * SUB);
      this.fireflies = Array.from({ length: Math.round(W * H / 6) }, (_, k) => ({
        x: hash2(k, 1, 9) * this.cw, y: hash2(k, 2, 9) * this.ch, ph: hash2(k, 3, 9) * 6.28, sp: 0.4 + hash2(k, 4, 9),
      }));
      this.particles = [];
    }

    // ---------- 地面（デュアルグリッド的に土スポット中心を双一次補間 → しきい値） ----------
    updateGround(mods) {
      const { W, H } = this;
      let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
      for (let i = 0; i < W * H; i++) {
        if (mods[i] !== this.prevMods[i]) {
          const x = i % W, y = (i / W) | 0;
          x0 = Math.min(x0, x - 1); x1 = Math.max(x1, x + 1);
          y0 = Math.min(y0, y - 1); y1 = Math.max(y1, y + 2);
        }
      }
      if (x1 < 0) return false;
      this.prevMods.set(mods);
      const Dm = V.dirtMap(mods, W, H);
      this.dirt = Dm;
      const gs = this.gs, C = this.C;
      const gw = this.groundCanvas.width, gh = this.groundCanvas.height;
      const px0 = clamp(Math.floor(x0 * C * gs), 0, gw), px1 = clamp(Math.ceil((x1 + 1) * C * gs), 0, gw);
      const py0 = clamp(Math.floor(y0 * C * gs), 0, gh), py1 = clamp(Math.ceil((y1 + 1) * C * gs), 0, gh);
      const SW = W * SUB, SH = H * SUB, S = this.S;
      const data = this.gimg.data;
      const at = (x, y) => Dm[clamp(y, 0, SH - 1) * SW + clamp(x, 0, SW - 1)];
      for (let py = py0; py < py1; py++) {
        const ly = py / gs, v = ly / S - 0.5, vy = Math.floor(v), fy = v - vy;
        for (let px = px0; px < px1; px++) {
          const i = py * gw + px;
          const lx = px / gs, u = lx / S - 0.5, ux = Math.floor(u), fx = u - ux;
          const a = at(ux, vy), b = at(ux + 1, vy), c = at(ux, vy + 1), d = at(ux + 1, vy + 1);
          const sfx = fx * fx * (3 - 2 * fx), sfy = fy * fy * (3 - 2 * fy);
          const bil = a + (b - a) * sfx + (c - a) * sfy + (a - b - c + d) * sfx * sfy;
          const nl = this.nLow[i], nm = this.nMid[i], nh = this.nHi[i];
          const f = bil + (nm - 0.5) * 0.34 + (nl - 0.5) * 0.08;
          let r, g, bl;
          if (f > 0.5) {
            const t = clamp((f - 0.5) / 0.13, 0, 1);
            const k = clamp(nl * 0.7 + nm * 0.5 - 0.1, 0, 1);
            r = DIRT2[0] + (DIRT1[0] - DIRT2[0]) * k; g = DIRT2[1] + (DIRT1[1] - DIRT2[1]) * k; bl = DIRT2[2] + (DIRT1[2] - DIRT2[2]) * k;
            // 轍のような明るい中央
            const center = clamp((bil - 0.85) * 4, 0, 1) * 0.08;
            r += (255 - r) * center; g += (255 - g) * center; bl += (255 - bl) * center;
            const rim = (1 - t) * (1 - t) * 0.75;
            r += (RIM[0] - r) * rim; g += (RIM[1] - g) * rim; bl += (RIM[2] - bl) * rim;
            if (nh > 0.965) { r += 28; g += 24; bl += 18; } else if (nh < 0.03) { r -= 30; g -= 26; bl -= 20; }
          } else {
            const k = clamp(nl * 1.25 - 0.12, 0, 1);
            r = G1[0] + (G2[0] - G1[0]) * k; g = G1[1] + (G2[1] - G1[1]) * k; bl = G1[2] + (G2[2] - G1[2]) * k;
            const patch = clamp((0.42 - nm) * 3, 0, 1) * 0.5;
            r += (G3[0] - r) * patch; g += (G3[1] - g) * patch; bl += (G3[2] - bl) * patch;
            const tex = (nm - 0.5) * 18;
            r += tex; g += tex * 1.2; bl += tex * 0.5;
            if (nh > 0.93) { r += 22; g += 26; bl += 10; } else if (nh < 0.07) { r -= 18; g -= 16; bl -= 12; }
            // 道のふちのアンビエントオクルージョン
            const ao = clamp((f - 0.26) / 0.24, 0, 1);
            const aok = 1 - 0.3 * ao * ao;
            r *= aok; g *= aok; bl *= aok;
          }
          const o = i * 4;
          data[o] = r; data[o + 1] = g; data[o + 2] = bl; data[o + 3] = 255;
        }
      }
      this.gctx.putImageData(this.gimg, 0, 0, px0, py0, px1 - px0, py1 - py0);
      return true;
    }

    // ---------- 静的レイヤー（地面 + 影 + スプライト + デバッグ表示） ----------
    renderStatic(scene, opt) {
      const { W, H, C, S } = this;
      const mods = scene.layoutMods;
      this.updateGround(mods);
      const ctx = this.staticCanvas.getContext('2d');
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.cw, this.ch);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.groundCanvas, 0, 0, this.cw, this.ch);

      const items = [];
      this.lights = []; this.chimneys = [];
      for (let i = 0; i < W * H; i++) {
        const m = mods[i];
        if (m < 0) continue;
        const k = LAYOUT[m].kind, x = (i % W) * C, y = ((i / W) | 0) * C;
        const cx = i % W, cy = (i / W) | 0;
        if (k === 'house') items.push({ y: y + C * 0.92, x, kind: 'house', px: x, py: y, cx, cy });
        else if (k === 'tree') items.push({ y: y + C * 0.88, x, kind: 'tree', px: x, py: y, cx, cy });
      }
      if (scene.detailMods && opt.showDetails) {
        const SW = W * SUB, dm = scene.detailMods;
        for (let i = 0; i < dm.length; i++) {
          const m = dm[i];
          if (m <= 0) continue;
          const gx = i % SW, gy = (i / SW) | 0;
          items.push({ y: gy * S + S * 0.8, x: gx * S, kind: 'd', m, px: gx * S, py: gy * S, gx, gy });
        }
      }
      // 影 → スプライト（下端でソート）
      for (const it of items) this.drawShadow(ctx, it);
      items.sort((a, b) => a.y - b.y || a.x - b.x);
      for (const it of items) {
        if (it.kind === 'house') this.drawHouse(ctx, it.px, it.py, it.cx, it.cy);
        else if (it.kind === 'tree') this.drawTree(ctx, it.px, it.py, it.cx, it.cy);
        else this.drawDetail(ctx, it.m, it.px, it.py, it.gx, it.gy);
      }

      // ---- デバッグ・可視化 ----
      if (opt.cellGrid) {
        ctx.strokeStyle = 'rgba(255,255,255,0.13)'; ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 1; x < W; x++) { ctx.moveTo(x * C + 0.5, 0); ctx.lineTo(x * C + 0.5, this.ch); }
        for (let y = 1; y < H; y++) { ctx.moveTo(0, y * C + 0.5); ctx.lineTo(this.cw, y * C + 0.5); }
        ctx.stroke();
      }
      if (opt.spotGrid) {
        ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 0.5;
        ctx.beginPath();
        for (let x = 1; x < W * SUB; x++) { ctx.moveTo(x * S, 0); ctx.lineTo(x * S, this.ch); }
        for (let y = 1; y < H * SUB; y++) { ctx.moveTo(0, y * S); ctx.lineTo(this.cw, y * S); }
        ctx.stroke();
        if (scene.detail && !scene.detailDone) {
          const sv = scene.detail, SW = W * SUB;
          for (let i = 0; i < sv.N; i++) {
            if (sv.decided[i]) continue;
            const n = WFC.popcount(sv.domains[i]);
            ctx.fillStyle = sv.frontier[i] ? 'rgba(255,214,120,0.9)' : `rgba(255,255,255,${0.15 + n * 0.06})`;
            ctx.beginPath();
            ctx.arc((i % SW) * S + S / 2, ((i / SW) | 0) * S + S / 2, sv.frontier[i] ? 1.8 : 1.2, 0, 6.29);
            ctx.fill();
          }
        }
      }
      if (scene.layout && !scene.layoutDone && opt.overlay !== 'none') this.drawLayoutOverlay(ctx, scene.layout, opt.overlay);
      this.scene = scene;
    }

    drawLayoutOverlay(ctx, s, mode) {
      const { W, H, C } = this;
      // 未確定セルの中で正規化して、色の差を見やすくする
      let eMin = Infinity, eMax = -Infinity;
      for (let i = 0; i < W * H; i++) {
        if (s.decided[i]) continue;
        const e = s.entropyOf(i);
        if (e < eMin) eMin = e;
        if (e > eMax) eMax = e;
      }
      const span = Math.max(1e-6, eMax - eMin);
      for (let i = 0; i < W * H; i++) {
        if (s.decided[i]) continue;
        const x = (i % W) * C, y = ((i / W) | 0) * C;
        const dom = s.domains[i];
        const e = s.entropyOf(i);
        const t = clamp((e - eMin) / span, 0, 1);
        if (mode === 'entropy') {
          // 低エントロピー = 暖色、高 = 寒色
          const hue = 220 - (1 - t) * 190;
          ctx.fillStyle = `hsla(${hue},70%,${22 + (1 - t) * 18}%,0.88)`;
          ctx.fillRect(x, y, C, C);
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.font = `600 ${Math.round(C * 0.24)}px "JetBrains Mono", ui-monospace, monospace`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(e.toFixed(2), x + C / 2, y + C / 2 - C * 0.08);
          ctx.fillStyle = 'rgba(255,255,255,0.55)';
          ctx.font = `${Math.round(C * 0.18)}px "JetBrains Mono", ui-monospace, monospace`;
          ctx.fillText(WFC.popcount(dom) + (this.optSuffix ?? '択'), x + C / 2, y + C / 2 + C * 0.2);
        } else {
          const g = ctx.createLinearGradient(x, y, x, y + C);
          g.addColorStop(0, 'rgba(24,28,44,0.90)'); g.addColorStop(1, 'rgba(16,19,32,0.94)');
          ctx.fillStyle = g;
          ctx.fillRect(x, y, C, C);
          const gs = C / 4, pad = gs * 0.1;
          for (let m = 0; m < LAYOUT.length; m++) {
            const gx = m % 4, gy = (m / 4) | 0;
            const on = (dom >> m) & 1;
            ctx.globalAlpha = on ? 1 : 0.09;
            drawGlyph(ctx, m, x + gx * gs + pad, y + gy * gs + pad, gs - pad * 2);
          }
          ctx.globalAlpha = 1;
          // 残りの選択肢数バッジ
          ctx.fillStyle = 'rgba(255,255,255,0.75)';
          ctx.font = `600 ${Math.round(C * 0.2)}px "JetBrains Mono", ui-monospace, monospace`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(String(WFC.popcount(dom)), x + C * 0.75 + gs * 0.1, y + C * 0.75 + gs * 0.1);
        }
        ctx.strokeStyle = s.frontier[i] ? 'rgba(255,205,110,0.85)' : 'rgba(255,255,255,0.06)';
        ctx.lineWidth = s.frontier[i] ? 1.5 : 1;
        ctx.strokeRect(x + 0.75, y + 0.75, C - 1.5, C - 1.5);
      }
    }

    // ---------------- スプライト ----------------
    drawShadow(ctx, it) {
      const C = this.C, S = this.S;
      ctx.fillStyle = 'rgba(20,35,15,0.28)';
      ctx.beginPath();
      if (it.kind === 'house') ctx.ellipse(it.px + C * 0.56, it.py + C * 0.86, C * 0.5, C * 0.16, 0, 0, 6.29);
      else if (it.kind === 'tree') ctx.ellipse(it.px + C * 0.58, it.py + C * 0.84, C * 0.4, C * 0.15, 0, 0, 6.29);
      else if (it.m === D.BUSH) ctx.ellipse(it.px + S * 0.6, it.py + S * 0.85, S * 0.6, S * 0.22, 0, 0, 6.29);
      else if (it.m === D.MUSH) ctx.ellipse(it.px + S * 0.55, it.py + S * 0.82, S * 0.35, S * 0.13, 0, 0, 6.29);
      else if (it.m >= D.FL) { ctx.rect(it.px, it.py + S * 0.72, S, S * 0.14); }
      else return;
      ctx.fill();
    }

    drawHouse(ctx, x, y, cx, cy) {
      const u = this.C / 48, sd = this.seed;
      const r1 = hash2(cx, cy, sd), r2 = hash2(cx, cy, sd + 1), r3 = hash2(cx, cy, sd + 2), r4 = hash2(cx, cy, sd + 3);
      const roof = pick(ROOFS, r1), wall = pick(WALLS, r2);
      const timber = r3 > 0.55;
      const wide = r4 > 0.5 ? 1 : 0;
      const L = x + (6 - wide) * u, R = x + (42 + wide) * u;
      const wallTop = y + 19 * u, base = y + 43 * u;

      // 壁
      let g = ctx.createLinearGradient(0, wallTop, 0, base);
      g.addColorStop(0, shade(wall, 0.12)); g.addColorStop(1, shade(wall, -0.12));
      ctx.fillStyle = g;
      ctx.fillRect(L, wallTop, R - L, base - wallTop);
      if (timber) {
        ctx.strokeStyle = '#6b4a2e'; ctx.lineWidth = 1.6 * u;
        ctx.strokeRect(L + 0.8 * u, wallTop + 0.5 * u, R - L - 1.6 * u, base - wallTop - 3 * u);
        ctx.beginPath();
        ctx.moveTo(L, y + 31 * u); ctx.lineTo(R, y + 31 * u);
        ctx.moveTo(L + 2 * u, wallTop); ctx.lineTo(x + 18 * u, y + 31 * u);
        ctx.moveTo(R - 2 * u, wallTop); ctx.lineTo(x + 30 * u, y + 31 * u);
        ctx.stroke();
      }
      // 石の土台
      ctx.fillStyle = '#8f8a80';
      ctx.fillRect(L - 0.5 * u, base - 3 * u, R - L + u, 3 * u);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      for (let sx = L; sx < R - 2 * u; sx += 5 * u) ctx.fillRect(sx + (cy % 2) * 2 * u, base - 2.6 * u, 3.4 * u, 1 * u);

      // 窓
      const win = (wx) => {
        const wy = y + 25 * u, ww = 6.5 * u, wh = 6.5 * u;
        ctx.fillStyle = '#5a3d27';
        ctx.fillRect(wx - 0.8 * u, wy - 0.8 * u, ww + 1.6 * u, wh + 1.6 * u);
        const wg = ctx.createLinearGradient(wx, wy, wx + ww, wy + wh);
        wg.addColorStop(0, '#fff1b8'); wg.addColorStop(1, '#f2b65a');
        ctx.fillStyle = wg;
        ctx.fillRect(wx, wy, ww, wh);
        ctx.fillStyle = '#5a3d27';
        ctx.fillRect(wx + ww / 2 - 0.45 * u, wy, 0.9 * u, wh);
        ctx.fillRect(wx, wy + wh / 2 - 0.45 * u, ww, 0.9 * u);
        // 植木鉢
        ctx.fillStyle = '#8b4f34';
        ctx.fillRect(wx - 0.6 * u, wy + wh + 0.8 * u, ww + 1.2 * u, 1.8 * u);
        for (let k = 0; k < 3; k++) {
          ctx.fillStyle = pick(FLOWERS, hash2(cx * 7 + k, cy, sd + wx));
          ctx.beginPath(); ctx.arc(wx + (1 + k * 2.2) * u, wy + wh + 0.6 * u, 1 * u, 0, 6.29); ctx.fill();
        }
        this.lights.push({ x: wx + ww / 2, y: wy + wh / 2, r: 16 * u });
      };
      win(x + 9.5 * u);
      win(x + 32 * u);

      // ドア（南向き＝道の側）
      const dx = x + 20 * u, dw = 8 * u, dTop = y + 30 * u;
      ctx.fillStyle = '#4a2f1c';
      ctx.beginPath();
      ctx.moveTo(dx - 0.8 * u, base); ctx.lineTo(dx - 0.8 * u, dTop + 3 * u);
      ctx.arc(dx + dw / 2, dTop + 3 * u, dw / 2 + 0.8 * u, Math.PI, 0);
      ctx.lineTo(dx + dw + 0.8 * u, base); ctx.fill();
      g = ctx.createLinearGradient(dx, 0, dx + dw, 0);
      g.addColorStop(0, '#8a5634'); g.addColorStop(1, '#6a3f24');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(dx, base); ctx.lineTo(dx, dTop + 3 * u);
      ctx.arc(dx + dw / 2, dTop + 3 * u, dw / 2, Math.PI, 0);
      ctx.lineTo(dx + dw, base); ctx.fill();
      ctx.fillStyle = '#f3c75a';
      ctx.beginPath(); ctx.arc(dx + dw - 2 * u, y + 37 * u, 0.8 * u, 0, 6.29); ctx.fill();
      // 玄関の踏み石
      ctx.fillStyle = '#b7afa0';
      ctx.fillRect(dx - 1.5 * u, base, dw + 3 * u, 2 * u);
      this.lights.push({ x: dx + dw / 2, y: dTop + 6 * u, r: 12 * u, door: true });

      // 屋根（寄棟）
      const eaveY = y + 21 * u, ridgeY = y - 5 * u;
      const rL = x + (2 - wide) * u, rR = x + (46 + wide) * u, tL = x + 10 * u, tR = x + 38 * u;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(rL, eaveY); ctx.lineTo(rR, eaveY); ctx.lineTo(tR, ridgeY); ctx.lineTo(tL, ridgeY); ctx.closePath();
      g = ctx.createLinearGradient(0, ridgeY, 0, eaveY);
      g.addColorStop(0, shade(roof, 0.22)); g.addColorStop(0.6, roof); g.addColorStop(1, shade(roof, -0.18));
      ctx.fillStyle = g; ctx.fill();
      ctx.clip();
      // 瓦の列
      const rows = 6;
      for (let r = 1; r <= rows; r++) {
        const ry = ridgeY + (eaveY - ridgeY) * r / (rows + 0.3);
        ctx.strokeStyle = shade(roof, -0.32); ctx.lineWidth = 0.9 * u;
        ctx.beginPath(); ctx.moveTo(rL, ry); ctx.lineTo(rR, ry); ctx.stroke();
        ctx.strokeStyle = shade(roof, -0.18); ctx.lineWidth = 0.6 * u;
        const step = 4 * u, off = (r % 2) * step / 2;
        ctx.beginPath();
        for (let sx = rL - step + off; sx < rR + step; sx += step) {
          ctx.moveTo(sx, ry); ctx.lineTo(sx, ry - (eaveY - ridgeY) / (rows + 0.3) * 0.8);
        }
        ctx.stroke();
      }
      // 寄棟の稜線
      ctx.strokeStyle = shade(roof, 0.25); ctx.lineWidth = 1.2 * u;
      ctx.beginPath();
      ctx.moveTo(tL, ridgeY); ctx.lineTo(rL + 3 * u, eaveY);
      ctx.moveTo(tR, ridgeY); ctx.lineTo(rR - 3 * u, eaveY);
      ctx.stroke();
      // 側面の陰影
      ctx.fillStyle = 'rgba(0,0,0,0.14)';
      ctx.beginPath(); ctx.moveTo(tR, ridgeY); ctx.lineTo(rR, eaveY); ctx.lineTo(rR, ridgeY); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath(); ctx.moveTo(tL, ridgeY); ctx.lineTo(rL, eaveY); ctx.lineTo(rL, ridgeY); ctx.fill();
      ctx.restore();
      // 棟と軒
      ctx.strokeStyle = shade(roof, 0.35); ctx.lineWidth = 1.8 * u; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(tL, ridgeY); ctx.lineTo(tR, ridgeY); ctx.stroke();
      ctx.strokeStyle = shade(roof, -0.4); ctx.lineWidth = 1.6 * u;
      ctx.beginPath(); ctx.moveTo(rL, eaveY); ctx.lineTo(rR, eaveY); ctx.stroke();
      ctx.lineCap = 'butt';
      // 軒下の影
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(L, eaveY + 0.8 * u, R - L, 2 * u);

      // 煙突
      const chx = x + (r3 > 0.5 ? 30 : 14) * u, chy = y - 9 * u;
      ctx.fillStyle = '#7d3f2e';
      ctx.fillRect(chx, chy, 5 * u, 11 * u);
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(chx, chy, 1.6 * u, 11 * u);
      ctx.fillStyle = '#5a5550';
      ctx.fillRect(chx - 0.8 * u, chy - 1.2 * u, 6.6 * u, 2 * u);
      this.chimneys.push({ x: chx + 2.5 * u, y: chy - 1.5 * u, u, ph: r4 * 10 });
    }

    drawTree(ctx, x, y, cx, cy) {
      const u = this.C / 48, sd = this.seed;
      const r1 = hash2(cx, cy, sd + 10), r2 = hash2(cx, cy, sd + 11), r3 = hash2(cx, cy, sd + 12);
      const ox = (r2 - 0.5) * 6 * u;
      // 幹
      const tx = x + 21.5 * u + ox;
      let g = ctx.createLinearGradient(tx, 0, tx + 5 * u, 0);
      g.addColorStop(0, '#8a5a34'); g.addColorStop(1, '#5a3a20');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(tx - 1 * u, y + 42 * u); ctx.lineTo(tx + 0.6 * u, y + 24 * u);
      ctx.lineTo(tx + 4.4 * u, y + 24 * u); ctx.lineTo(tx + 6 * u, y + 42 * u); ctx.fill();

      if (r1 < 0.3) {
        // 針葉樹
        const cxp = x + 24 * u + ox;
        const tiers = [[34, 17], [24, 14], [14, 11], [5, 7]];
        tiers.forEach(([ty, w], k) => {
          const top = y + (ty - 16) * u, bot = y + ty * u;
          g = ctx.createLinearGradient(cxp - w * u, 0, cxp + w * u, 0);
          g.addColorStop(0, '#4f8f4a'); g.addColorStop(0.5, '#2f6b3a'); g.addColorStop(1, '#1e4a2c');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(cxp, top - 2 * u);
          ctx.quadraticCurveTo(cxp + w * 0.5 * u, bot - 6 * u, cxp + w * u, bot);
          ctx.quadraticCurveTo(cxp, bot + 3 * u, cxp - w * u, bot);
          ctx.quadraticCurveTo(cxp - w * 0.5 * u, bot - 6 * u, cxp, top - 2 * u);
          ctx.fill();
          ctx.strokeStyle = 'rgba(160,220,140,0.25)'; ctx.lineWidth = 0.8 * u;
          ctx.beginPath(); ctx.moveTo(cxp - 1 * u, top + 1 * u); ctx.lineTo(cxp - w * 0.6 * u, bot - 1 * u); ctx.stroke();
        });
        return;
      }
      // 広葉樹
      const fruit = r1 > 0.82;
      const base = fruit ? ['#2f6a2c', '#4f9a3a', '#8fd05a'] : (r3 > 0.5 ? ['#2d6a34', '#4c9b45', '#9ad66a'] : ['#3a6a26', '#64a23c', '#b4dd6a']);
      const blobs = [[24, 12, 13], [14, 21, 10.5], [34, 21, 10.5], [24, 24, 12], [18, 9, 8], [31, 10, 8]];
      ctx.fillStyle = base[0];
      for (const [bx, by, br] of blobs) { ctx.beginPath(); ctx.arc(x + bx * u + ox, y + (by + 2.5) * u, br * u, 0, 6.29); ctx.fill(); }
      for (const [bx, by, br] of blobs) {
        const px = x + bx * u + ox, py = y + by * u;
        g = ctx.createRadialGradient(px - br * 0.4 * u, py - br * 0.5 * u, br * 0.1 * u, px, py, br * u);
        g.addColorStop(0, base[2]); g.addColorStop(0.55, base[1]); g.addColorStop(1, base[0]);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(px, py, br * u, 0, 6.29); ctx.fill();
      }
      // 葉のテクスチャ
      for (let k = 0; k < 22; k++) {
        const a = hash2(cx * 31 + k, cy, sd) * 6.28, rr = hash2(cx, cy * 31 + k, sd) * 15;
        const px = x + 24 * u + ox + Math.cos(a) * rr * u * 1.1, py = y + 17 * u + Math.sin(a) * rr * u * 0.8;
        ctx.fillStyle = k % 3 === 0 ? 'rgba(255,255,220,0.22)' : 'rgba(10,40,10,0.18)';
        ctx.beginPath(); ctx.arc(px, py, (1 + hash2(k, cx, cy) * 1.4) * u, 0, 6.29); ctx.fill();
      }
      if (fruit) {
        for (let k = 0; k < 7; k++) {
          const a = hash2(k, cx, sd + 5) * 6.28, rr = 4 + hash2(cy, k, sd + 6) * 10;
          const px = x + 24 * u + ox + Math.cos(a) * rr * u, py = y + 17 * u + Math.sin(a) * rr * u * 0.8;
          ctx.fillStyle = '#d8352a'; ctx.beginPath(); ctx.arc(px, py, 1.5 * u, 0, 6.29); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.beginPath(); ctx.arc(px - 0.5 * u, py - 0.5 * u, 0.5 * u, 0, 6.29); ctx.fill();
        }
      }
    }

    drawDetail(ctx, m, x, y, gx, gy) {
      const S = this.S, u = S / 12, sd = this.seed;
      const r = hash2(gx, gy, sd + 40), r2 = hash2(gx, gy, sd + 41);
      const cx = x + S / 2 + (r - 0.5) * 3 * u, cy = y + S / 2 + (r2 - 0.5) * 3 * u;
      switch (m) {
        case D.TUFT: {
          ctx.lineCap = 'round';
          for (let k = 0; k < 6; k++) {
            const dx = (k - 2.5) * 1.5 * u, h = (5 + hash2(gx * 9 + k, gy, sd) * 4) * u;
            ctx.strokeStyle = k % 2 ? '#3f7d2b' : '#a6d86a'; ctx.lineWidth = 1.1 * u;
            ctx.beginPath(); ctx.moveTo(cx + dx, cy + 4 * u);
            ctx.quadraticCurveTo(cx + dx * 1.2, cy, cx + dx * 1.9, cy + 4 * u - h); ctx.stroke();
          }
          ctx.lineCap = 'butt';
          break;
        }
        case D.FLOWER: {
          const n = 2 + Math.floor(r * 2);
          for (let k = 0; k < n; k++) {
            const fx = cx + (hash2(gx, gy * 5 + k, sd) - 0.5) * 8 * u, fy = cy + (hash2(gx * 5 + k, gy, sd) - 0.5) * 7 * u;
            const col = pick(FLOWERS, hash2(gx + k, gy, sd + 3));
            ctx.strokeStyle = '#3d7a2a'; ctx.lineWidth = 0.8 * u;
            ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx, fy + 3.5 * u); ctx.stroke();
            ctx.fillStyle = col;
            for (let p = 0; p < 5; p++) {
              const a = p / 5 * 6.283 + r;
              ctx.beginPath(); ctx.arc(fx + Math.cos(a) * 1.4 * u, fy + Math.sin(a) * 1.4 * u, 1.15 * u, 0, 6.29); ctx.fill();
            }
            ctx.fillStyle = '#ffcf3a';
            ctx.beginPath(); ctx.arc(fx, fy, 0.8 * u, 0, 6.29); ctx.fill();
          }
          break;
        }
        case D.MUSH: {
          const brown = r > 0.7;
          ctx.fillStyle = '#f1e6d0';
          ctx.fillRect(cx - 1.3 * u, cy - 1 * u, 2.6 * u, 4.5 * u);
          const g = ctx.createRadialGradient(cx - 1.5 * u, cy - 3 * u, 0.5 * u, cx, cy - 1 * u, 5 * u);
          g.addColorStop(0, brown ? '#d9a066' : '#ff6a50'); g.addColorStop(1, brown ? '#8a5a2e' : '#b3261c');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.ellipse(cx, cy - 1 * u, 4.2 * u, 3.4 * u, 0, Math.PI, 0); ctx.fill();
          if (!brown) {
            ctx.fillStyle = '#fff';
            [[-2, -2.4], [1.2, -3], [2.4, -1.4], [-0.5, -1.2]].forEach(([dx, dy]) => {
              ctx.beginPath(); ctx.arc(cx + dx * u, cy + dy * u, 0.6 * u, 0, 6.29); ctx.fill();
            });
          }
          if (r2 > 0.5) { // 小さいもう一本
            ctx.fillStyle = '#f1e6d0'; ctx.fillRect(cx + 3.5 * u, cy + 1 * u, 1.4 * u, 2.5 * u);
            ctx.fillStyle = brown ? '#a8703c' : '#d63a28';
            ctx.beginPath(); ctx.ellipse(cx + 4.2 * u, cy + 1.2 * u, 2.2 * u, 1.8 * u, 0, Math.PI, 0); ctx.fill();
          }
          break;
        }
        case D.PEBBLE: {
          const stones = [[-1.8, 0.8, 2.4, 1.6], [1.8, -0.6, 1.7, 1.2], [0.6, 2.2, 1.2, 0.9]];
          for (const [dx, dy, rx, ry] of stones) {
            ctx.fillStyle = 'rgba(60,40,20,0.35)';
            ctx.beginPath(); ctx.ellipse(cx + dx * u + 0.4 * u, cy + dy * u + 0.6 * u, rx * u, ry * u, 0, 0, 6.29); ctx.fill();
            ctx.fillStyle = r > 0.5 ? '#9c968a' : '#a59a86';
            ctx.beginPath(); ctx.ellipse(cx + dx * u, cy + dy * u, rx * u, ry * u, 0, 0, 6.29); ctx.fill();
            ctx.fillStyle = 'rgba(255,255,255,0.45)';
            ctx.beginPath(); ctx.ellipse(cx + dx * u - rx * 0.3 * u, cy + dy * u - ry * 0.35 * u, rx * 0.4 * u, ry * 0.3 * u, 0, 0, 6.29); ctx.fill();
          }
          break;
        }
        case D.BUSH: {
          const blobs = [[0, -1, 5.4], [-3.8, 1.4, 4], [3.8, 1.4, 4]];
          ctx.fillStyle = '#24502a';
          for (const [dx, dy, br] of blobs) { ctx.beginPath(); ctx.arc(cx + dx * u, cy + (dy + 1) * u, br * u, 0, 6.29); ctx.fill(); }
          for (const [dx, dy, br] of blobs) {
            const px = cx + dx * u, py = cy + dy * u;
            const g = ctx.createRadialGradient(px - br * 0.4 * u, py - br * 0.5 * u, 0.3 * u, px, py, br * u);
            g.addColorStop(0, '#93cf62'); g.addColorStop(0.6, '#3f8a3c'); g.addColorStop(1, '#24502a');
            ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, br * u, 0, 6.29); ctx.fill();
          }
          const berry = r > 0.5 ? '#e0344a' : '#5a6cff';
          for (let k = 0; k < 5; k++) {
            ctx.fillStyle = berry;
            ctx.beginPath(); ctx.arc(cx + (hash2(k, gx, gy) - 0.5) * 9 * u, cy + (hash2(gy, k, gx) - 0.5) * 5 * u, 0.9 * u, 0, 6.29); ctx.fill();
          }
          break;
        }
        default: { // 柵
          if (m < D.FL) break;
          const px = x + S / 2, py = y + S * 0.72;
          const from = m === D.FL ? px : x, to = m === D.FR ? px : x + S;
          ctx.fillStyle = '#6e4628';
          ctx.fillRect(from, py - 6.2 * u, to - from, 1.5 * u);
          ctx.fillRect(from, py - 2.8 * u, to - from, 1.5 * u);
          ctx.fillStyle = 'rgba(255,230,190,0.35)';
          ctx.fillRect(from, py - 6.2 * u, to - from, 0.5 * u);
          ctx.fillRect(from, py - 2.8 * u, to - from, 0.5 * u);
          // 杭
          const g = ctx.createLinearGradient(px - 1.3 * u, 0, px + 1.3 * u, 0);
          g.addColorStop(0, '#a6774a'); g.addColorStop(1, '#6a4224');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(px - 1.3 * u, py + 0.5 * u); ctx.lineTo(px - 1.3 * u, py - 8 * u);
          ctx.lineTo(px, py - 9.4 * u); ctx.lineTo(px + 1.3 * u, py - 8 * u); ctx.lineTo(px + 1.3 * u, py + 0.5 * u);
          ctx.fill();
        }
      }
    }

    // ---------------- 毎フレームの合成 ----------------
    frame(t, opt, highlight) {
      const ctx = this.ctx, { cw, ch, dpr } = this;
      const dt = Math.min(0.05, (t - (this.lastT || t)) / 1000);
      this.lastT = t;
      this.night += ((opt.night ? 1 : 0) - this.night) * Math.min(1, dt * 3);
      const nt = this.night;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.staticCanvas, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const ts = t / 1000;

      // 雲の影（昼）
      if (opt.ambient && nt < 0.99) {
        ctx.save();
        ctx.globalAlpha = (1 - nt) * 0.11;
        for (let k = 0; k < 4; k++) {
          const span = cw + 600;
          const x = ((ts * (12 + k * 3) + k * 420) % span) - 300;
          const y = (hash2(k, 7, 3) * 0.8 + 0.1) * ch;
          const rr = 140 + k * 30;
          const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
          g.addColorStop(0, '#0a1a2a'); g.addColorStop(1, 'rgba(10,26,42,0)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.ellipse(x, y, rr * 1.4, rr * 0.8, 0.2, 0, 6.29); ctx.fill();
        }
        ctx.restore();
      }

      // 煙突の煙
      if (opt.ambient) {
        if (ts - this.lastEmit > 0.12 && this.chimneys.length) {
          this.lastEmit = ts;
          for (const c of this.chimneys) {
            if (Math.random() < 0.35) this.particles.push({ x: c.x, y: c.y, vx: 0, vy: -8 * c.u, age: 0, life: 2.6 + Math.random(), r: 1.6 * c.u, u: c.u });
          }
        }
        for (let i = this.particles.length - 1; i >= 0; i--) {
          const p = this.particles[i];
          p.age += dt;
          if (p.age > p.life) { this.particles.splice(i, 1); continue; }
          p.vx += (Math.sin(ts * 0.6 + p.y * 0.05) * 2 + 4) * dt * p.u;
          p.x += p.vx * dt; p.y += p.vy * dt;
          const k = p.age / p.life;
          const a = (1 - k) * 0.45 * (k < 0.1 ? k * 10 : 1);
          ctx.fillStyle = nt > 0.5 ? `rgba(150,160,190,${a * 0.6})` : `rgba(240,240,245,${a})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r + k * 5 * p.u, 0, 6.29); ctx.fill();
        }
      } else this.particles.length = 0;

      // 昼の暖かい光
      if (nt < 0.99) {
        const g = ctx.createLinearGradient(0, 0, cw, ch);
        g.addColorStop(0, `rgba(255,236,190,${0.16 * (1 - nt)})`);
        g.addColorStop(1, `rgba(80,120,160,${0.08 * (1 - nt)})`);
        ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch);
      }
      // 夜
      if (nt > 0.01) {
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = `rgba(${Math.round(255 - 228 * nt)},${Math.round(255 - 210 * nt)},${Math.round(255 - 150 * nt)},1)`;
        ctx.fillRect(0, 0, cw, ch);
        ctx.globalCompositeOperation = 'lighter';
        for (const l of this.lights) {
          const flick = 0.9 + Math.sin(ts * 7 + l.x * 0.3) * 0.05 + Math.sin(ts * 13 + l.y) * 0.04;
          const rr = l.r * (l.door ? 1.4 : 2.2) * flick;
          const g = ctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, rr);
          g.addColorStop(0, `rgba(255,200,110,${0.95 * nt})`);
          g.addColorStop(0.12, `rgba(255,170,70,${0.55 * nt})`);
          g.addColorStop(0.45, `rgba(255,130,40,${0.16 * nt})`);
          g.addColorStop(1, 'rgba(255,120,40,0)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(l.x, l.y, rr, 0, 6.29); ctx.fill();
        }
        if (opt.ambient) {
          for (const f of this.fireflies) {
            const fx = f.x + Math.sin(ts * f.sp + f.ph) * 18, fy = f.y + Math.cos(ts * f.sp * 0.7 + f.ph) * 12;
            const a = (0.5 + 0.5 * Math.sin(ts * 3 * f.sp + f.ph)) * nt;
            const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, 7);
            g.addColorStop(0, `rgba(230,255,140,${0.9 * a})`); g.addColorStop(1, 'rgba(200,255,120,0)');
            ctx.fillStyle = g; ctx.beginPath(); ctx.arc(fx, fy, 7, 0, 6.29); ctx.fill();
          }
        }
        ctx.restore();
      }

      // 直近の選択をパルス表示
      if (highlight) {
        const age = (t - highlight.time) / 1000;
        if (age < 1.2) {
          const k = age / 1.2;
          const size = highlight.size;
          ctx.strokeStyle = highlight.bad ? `rgba(255,80,80,${1 - k})` : `rgba(255,220,120,${1 - k})`;
          ctx.lineWidth = highlight.bad ? 3 : 2;
          const pad = -k * size * 0.35;
          ctx.strokeRect(highlight.x - pad, highlight.y - pad, size + pad * 2, size + pad * 2);
          if (highlight.bad) {
            ctx.fillStyle = `rgba(255,40,40,${0.35 * (1 - k)})`;
            ctx.fillRect(highlight.x, highlight.y, size, size);
          }
        }
      }

      // ビネット
      const vg = ctx.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.45, cw / 2, ch / 2, Math.max(cw, ch) * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(0,0,${20 * nt},${0.32 + nt * 0.2})`);
      ctx.fillStyle = vg; ctx.fillRect(0, 0, cw, ch);
    }
  }

  // ---------------- 小さなモジュールアイコン ----------------
  function drawGlyph(ctx, m, x, y, s) {
    const mod = LAYOUT[m];
    const r = s * 0.22;
    ctx.fillStyle = mod.kind === 'road' ? '#5d9440' : '#6aa548';
    roundRect(ctx, x, y, s, s, r); ctx.fill();
    if (mod.kind === 'road') {
      ctx.strokeStyle = '#d8b27a'; ctx.lineWidth = s * 0.34; ctx.lineCap = 'round';
      ctx.beginPath();
      const c = s / 2;
      for (let d = 0; d < 4; d++) if ((mod.mask >> d) & 1) {
        ctx.moveTo(x + c, y + c);
        ctx.lineTo(x + c + [0, c, 0, -c][d], y + c + [-c, 0, c, 0][d]);
      }
      ctx.stroke(); ctx.lineCap = 'butt';
    } else if (mod.kind === 'house') {
      ctx.fillStyle = '#f3e6c8'; ctx.fillRect(x + s * 0.2, y + s * 0.45, s * 0.6, s * 0.4);
      ctx.fillStyle = '#c4553b';
      ctx.beginPath(); ctx.moveTo(x + s * 0.1, y + s * 0.5); ctx.lineTo(x + s * 0.5, y + s * 0.12); ctx.lineTo(x + s * 0.9, y + s * 0.5); ctx.fill();
      ctx.fillStyle = '#5a3a20'; ctx.fillRect(x + s * 0.43, y + s * 0.62, s * 0.14, s * 0.23);
    } else if (mod.kind === 'tree') {
      ctx.fillStyle = '#5a3a20'; ctx.fillRect(x + s * 0.44, y + s * 0.55, s * 0.12, s * 0.3);
      ctx.fillStyle = '#2f7a34'; ctx.beginPath(); ctx.arc(x + s * 0.5, y + s * 0.42, s * 0.3, 0, 6.29); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.arc(x + s * 0.42, y + s * 0.34, s * 0.1, 0, 6.29); ctx.fill();
    } else {
      ctx.strokeStyle = '#a9dc72'; ctx.lineWidth = Math.max(1, s * 0.07);
      ctx.beginPath();
      for (const [dx, dy] of [[0.3, 0.6], [0.55, 0.4], [0.7, 0.7]]) {
        ctx.moveTo(x + s * dx, y + s * (dy + 0.12)); ctx.lineTo(x + s * (dx + 0.04), y + s * (dy - 0.1));
      }
      ctx.stroke();
    }
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  root.WFC.Renderer = Renderer;
  root.WFC.drawGlyph = drawGlyph;
})(window);
