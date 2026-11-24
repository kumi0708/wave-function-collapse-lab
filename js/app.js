/* UI とアニメーションループ */
(function () {
  'use strict';
  const { Village, Renderer, drawGlyph, popcount } = window.WFC;
  const { LAYOUT, DETAIL, LayoutJob, DetailJob, SUB } = Village;
  const $ = id => document.getElementById(id);

  const SIZES = { '12x9': [12, 9, 56], '18x12': [18, 12, 48], '24x15': [24, 15, 40] };
  const SPEEDS = [1, 2, 4, 8, 15, 30, 60, 140, 400, Infinity]; // レイアウトの手数 / 秒
  const DETAIL_MULT = 14;
  const RESTART_HOLD = 750;

  const canvas = $('view');
  const renderer = new Renderer(canvas);
  const opt = { overlay: 'options', showDetails: true, night: false, spotGrid: false, cellGrid: false, ambient: true };

  const st = {
    seed: 2026, W: 18, H: 12, C: 48,
    phase: 'idle', playing: false, lj: null, dj: null,
    acc: 0, hold: 0, dirty: true, highlight: null, log: [], lastLayoutMods: null,
  };

  // ---------------- 凡例 ----------------
  function glyphCanvas(m, size) {
    const c = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = c.height = size * dpr; c.style.width = c.style.height = size + 'px';
    const x = c.getContext('2d'); x.scale(dpr, dpr);
    drawGlyph(x, m, 1, 1, size - 2);
    return c;
  }
  const countEls = [];
  LAYOUT.forEach((mod, m) => {
    const li = document.createElement('li');
    li.appendChild(glyphCanvas(m, 28));
    const name = document.createElement('span'); name.textContent = mod.name;
    const sock = document.createElement('span'); sock.className = 'sock'; sock.textContent = mod.sockets.join(' ');
    name.appendChild(document.createElement('br'));
    name.appendChild(sock);
    const w = document.createElement('span'); w.className = 'w'; w.textContent = mod.weight.toFixed(mod.weight < 0.1 ? 3 : 2);
    const cnt = document.createElement('span'); cnt.className = 'cnt'; cnt.textContent = '0';
    countEls.push(cnt);
    li.append(name, w, cnt);
    $('modules').appendChild(li);
  });

  // ---------------- 生成制御 ----------------
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const s = parseInt(p.get('seed'), 10);
    if (s > 0) $('seed').value = s;
    if (SIZES[p.get('size')]) $('size').value = p.get('size');
    if (p.get('night') === '1') { $('optNight').checked = true; opt.night = true; }
  }
  function writeHash() {
    history.replaceState(null, '', `#seed=${st.seed}&size=${$('size').value}${opt.night ? '&night=1' : ''}`);
  }

  function start(animate) {
    st.seed = Math.max(1, parseInt($('seed').value, 10) || 1);
    $('seed').value = st.seed;
    const [W, H, C] = SIZES[$('size').value];
    if (W !== renderer.W || H !== renderer.H) {
      st.W = W; st.H = H; st.C = C;
      renderer.setup(W, H, C, st.seed); // ノイズテクスチャはサイズが変わった時だけ再計算
    } else {
      renderer.seed = st.seed;
      renderer.prevMods.fill(-2);
      renderer.particles.length = 0;
    }
    st.lj = new LayoutJob(st.seed, W, H);
    st.dj = null;
    st.log = [];
    st.highlight = null;
    st.phase = 'layout';
    st.acc = 0; st.hold = 0;
    addLog('info', `seed ${st.seed} · ${W}×${H} — 中央に最初の家を配置`);
    onPicked(st.lj.solver, true);
    writeHash();
    if (!animate) {
      finishInstant();
    } else {
      setPlaying(true);
    }
    st.dirty = true;
  }

  function finishInstant() {
    if (st.phase === 'layout') {
      const r = st.lj.runToEnd();
      if (st.lj.attempt > 0) addLog('bad', `矛盾 ${st.lj.contradictions} 回 → 再試行`);
      if (r === 'failed') { fail(); return; }
      beginDetail();
    }
    if (st.phase === 'detail') {
      const r = st.dj.runToEnd();
      if (r === 'failed') { fail(); return; }
      complete();
    }
    setPlaying(false);
    st.dirty = true;
  }

  function beginDetail() {
    const lj = st.lj;
    st.lastLayoutMods = lj.modules();
    addLog('info', `レイアウト完了 (${lj.solver.steps} 手) → ディテールパスへ`);
    st.dj = new DetailJob(st.lastLayoutMods, st.W, st.H, lj.solver.firstHouse, st.seed * 31 + 7);
    st.phase = 'detail';
    onPicked(st.dj.solver, false);
    toast('レイアウト完了 → 8px ディテールパス');
  }
  function complete() {
    st.phase = 'done';
    addLog('info', `完成！ ディテール ${st.dj.solver.steps} 手`);
    toast('村が収束しました ✨');
    setPlaying(false);
  }
  function fail() {
    st.phase = 'failed';
    addLog('bad', '再試行の上限に達しました');
    toast('生成に失敗しました', true);
    setPlaying(false);
  }

  /** 1 手進める。戻り値 false = 止めるべき */
  function stepOnce(now) {
    if (st.phase === 'layout') {
      const lj = st.lj;
      const r = lj.step();
      if (r === 'picked') onPicked(lj.solver, true);
      else if (r === 'contradiction') {
        const i = lj.solver.contradiction;
        st.highlight = { x: (i % st.W) * st.C, y: ((i / st.W) | 0) * st.C, size: st.C, time: now, bad: true };
        addLog('bad', `矛盾 @(${i % st.W},${(i / st.W) | 0}) → シード ${st.seed + lj.attempt + 1} で再試行`);
        toast(`矛盾！ 候補が 0 のセルが発生 → 再試行 #${lj.attempt + 2}`, true);
        st.hold = now + RESTART_HOLD;
        return false;
      } else if (r === 'restart') { renderer.prevMods.fill(-2); onPicked(lj.solver, true); }
      else if (r === 'failed') { fail(); return false; }
      else if (r === 'done') { beginDetail(); }
      return true;
    }
    if (st.phase === 'detail') {
      const dj = st.dj;
      const r = dj.step();
      if (r === 'picked') onPicked(dj.solver, false);
      else if (r === 'contradiction') { addLog('bad', 'ディテールで矛盾 → 再試行'); st.hold = now + RESTART_HOLD / 2; return false; }
      else if (r === 'failed') { fail(); return false; }
      else if (r === 'done') { complete(); return false; }
      return true;
    }
    return false;
  }

  function onPicked(s, isLayout) {
    const L = s.last;
    if (!L) return;
    const now = performance.now();
    if (isLayout) {
      const x = L.cell % st.W, y = (L.cell / st.W) | 0;
      st.highlight = { x: x * st.C, y: y * st.C, size: st.C, time: now };
      addLog('', `#${String(L.step).padStart(3, '0')} (${x},${y}) ← <b>${LAYOUT[L.module].name}</b> H=${L.entropy.toFixed(2)} ${L.options}択`);
      showLastPick(L, true);
    } else {
      const SW = st.W * SUB, S = st.C / SUB;
      st.highlight = { x: (L.cell % SW) * S, y: ((L.cell / SW) | 0) * S, size: S, time: now };
      if (L.step % 25 === 1 || L.module > 0) showLastPick(L, false);
    }
    st.dirty = true;
  }

  function showLastPick(L, isLayout) {
    const el = $('lastPick');
    el.innerHTML = '';
    if (isLayout) el.appendChild(glyphCanvas(L.module, 32));
    const div = document.createElement('div');
    const name = isLayout ? LAYOUT[L.module].name : DETAIL[L.module].name;
    div.innerHTML = `<b>${name}</b>${L.forced ? '（最初の一手・固定）' : ''}<br><span class="mono">エントロピー ${L.entropy.toFixed(3)} · 候補 ${L.options} → 1</span>`;
    el.appendChild(div);
  }

  function addLog(cls, html) {
    st.log.unshift({ cls, html });
    if (st.log.length > 40) st.log.length = 40;
    st.logDirty = true;
  }

  // ---------------- UI 反映 ----------------
  let toastTimer = 0;
  function toast(msg, bad) {
    const t = $('toast');
    t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast' + (bad ? ' bad' : ''); }, 1800);
  }

  function setPlaying(p) {
    st.playing = p && (st.phase === 'layout' || st.phase === 'detail');
    $('btnPlay').textContent = st.playing ? '⏸ 一時停止' : '▶ 再開';
  }

  const PHASE = { idle: '待機中', layout: 'レイアウトパス', detail: 'ディテールパス', done: '完成', failed: '失敗' };
  function updatePanel() {
    const pill = $('phasePill');
    pill.className = 'phase-pill ' + ({ layout: 'run', detail: 'run', done: 'done', failed: 'fail' }[st.phase] || '');
    $('phaseText').textContent = PHASE[st.phase] + (st.playing ? '' : (st.phase === 'layout' || st.phase === 'detail') ? '（停止中）' : '');
    const ls = st.lj && st.lj.solver;
    const ds = st.dj && st.dj.solver;
    const cur = st.phase === 'detail' || (st.phase === 'done' && ds) ? ds : ls;
    $('stPass').textContent = cur === ds && ds ? 'ディテール 4×4' : 'レイアウト';
    $('stSteps').textContent = cur ? cur.steps : 0;
    $('stDecided').textContent = cur ? `${cur.decidedCount} / ${cur.N}` : '0 / 0';
    const job = cur === ds ? st.dj : st.lj;
    $('stAttempts').textContent = job ? `${job.attempt + 1} / ${job.contradictions}` : '1 / 0';
    $('barLayout').style.setProperty('--p', ls ? (100 * ls.decidedCount / ls.N) + '%' : '0%');
    $('barDetail').style.setProperty('--p', ds ? (100 * ds.decidedCount / ds.N) + '%' : '0%');
    if (ls) {
      const c = new Array(LAYOUT.length).fill(0);
      for (let i = 0; i < ls.N; i++) { const m = ls.moduleAt(i); if (m >= 0) c[m]++; }
      c.forEach((v, i) => { countEls[i].textContent = v; });
    }
    if (st.logDirty) {
      $('log').innerHTML = st.log.map(e => `<li class="${e.cls}">${e.html}</li>`).join('');
      st.logDirty = false;
    }
  }

  function buildScene() {
    const ls = st.lj.solver;
    const layoutMods = st.phase === 'layout' ? st.lj.modules() : st.lastLayoutMods;
    const scene = { layout: ls, layoutMods, layoutDone: st.phase !== 'layout' };
    if (st.dj) {
      scene.detail = st.dj.solver;
      scene.detailMods = st.dj.modules();
      scene.detailDone = st.phase === 'done';
    }
    return scene;
  }

  // ---------------- ループ ----------------
  let lastT = performance.now(), panelT = 0;
  function loop(now) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    if (st.playing && now >= st.hold) {
      const sp = SPEEDS[+$('speed').value - 1];
      const rate = st.phase === 'detail' ? sp * DETAIL_MULT : sp;
      st.acc += rate * dt;
      let n = rate === Infinity ? 1e9 : Math.floor(st.acc);
      st.acc -= n === 1e9 ? 0 : n;
      const t0 = performance.now();
      while (n-- > 0) {
        if (!stepOnce(now)) break;
        if (performance.now() - t0 > 12) { st.acc = 0; break; }
      }
    }
    if (st.dirty && st.lj) {
      renderer.renderStatic(buildScene(), opt);
      st.dirty = false;
    }
    if (renderer.W) renderer.frame(now, opt, st.highlight);
    if (now - panelT > 90) { updatePanel(); panelT = now; }
    requestAnimationFrame(loop);
  }

  // ---------------- イベント ----------------
  function speedLabel() {
    const v = SPEEDS[+$('speed').value - 1];
    $('speedOut').textContent = v === Infinity ? '最大' : `${v} 手/秒`;
  }
  $('speed').addEventListener('input', speedLabel);
  $('btnAnimate').onclick = () => start(true);
  $('btnInstant').onclick = () => start(false);
  $('dice').onclick = () => { $('seed').value = 1 + Math.floor(Math.random() * 999999); start(true); };
  $('btnPlay').onclick = () => {
    if (st.phase === 'done' || st.phase === 'failed' || st.phase === 'idle') { start(true); return; }
    setPlaying(!st.playing);
  };
  $('btnStep').onclick = () => {
    if (st.phase === 'done' || st.phase === 'failed' || st.phase === 'idle') start(true);
    setPlaying(false);
    st.hold = 0;
    stepOnce(performance.now());
  };
  $('btnPng').onclick = () => {
    canvas.toBlob(b => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `wfc-village-${st.seed}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  };
  $('size').onchange = () => start(true);
  $('seed').addEventListener('keydown', e => { if (e.key === 'Enter') start(true); });
  document.querySelectorAll('#overlaySeg button').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#overlaySeg button').forEach(x => x.classList.toggle('on', x === b));
      opt.overlay = b.dataset.v; st.dirty = true;
    };
  });
  const bindToggle = (id, key) => $(id).addEventListener('change', e => { opt[key] = e.target.checked; st.dirty = true; if (key === 'night') writeHash(); });
  bindToggle('optDetails', 'showDetails');
  bindToggle('optNight', 'night');
  bindToggle('optSpot', 'spotGrid');
  bindToggle('optGrid', 'cellGrid');
  bindToggle('optAmbient', 'ambient');
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); $('btnPlay').click(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); $('btnStep').click(); }
    else if (e.key === 'r' || e.key === 'R') $('dice').click();
    else if (e.key === 'n' || e.key === 'N') { $('optNight').checked = !$('optNight').checked; $('optNight').dispatchEvent(new Event('change')); }
  });
  let resizeT = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (renderer.W && dpr !== renderer.dpr) { renderer.setup(st.W, st.H, st.C, st.seed); st.dirty = true; }
    }, 200);
  });

  readHash();
  opt.night = $('optNight').checked;
  speedLabel();
  start(true);
  requestAnimationFrame(loop);
})();
