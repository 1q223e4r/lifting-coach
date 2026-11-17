// 합성 섀도복서로 분석기를 돌려 정답과 비교하는 테스트 도구
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function loadCore(file = path.join(__dirname, '..', 'src', 'core.js')) {
  const code = fs.readFileSync(file, 'utf8');
  const ctx = { console, Math, Object, Array, Number, Map, Set, Infinity, NaN, JSON };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.BoxingCore;
}

// MediaPipe 내부 평활화 흉내(one-euro, 몸통 단위 근사)
function makeEuro(minCutoff, beta, dCutoff) {
  const state = new Map();
  const alpha = (cutoff, dt) => { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); };
  return (key, x, dt, scale) => {
    let s = state.get(key);
    if (!s || !(dt > 0)) { state.set(key, { x, dx: 0 }); return x; }
    const dx = (x - s.x) / dt;
    const ad = alpha(dCutoff, dt);
    const dxh = s.dx + ad * (dx - s.dx);
    const cutoff = minCutoff + beta * Math.abs(dxh) / scale;
    const a = alpha(cutoff, dt);
    const xh = s.x + a * (x - s.x);
    state.set(key, { x: xh, dx: dxh });
    return xh;
  };
}

function run(core, opt = {}) {
  const fps = opt.fps || 30, duration = opt.duration || 60;
  const sim = core.createShadowboxSimulation({ seed: opt.seed || 7, stance: opt.stance, noise: opt.noise, depthScale: opt.depthScale, flipZ: opt.flipZ, mistakes: opt.mistakes, periods: opt.periods, combos: opt.combos, mode: opt.mode, width: 720, height: 960 });
  const analyzer = new core.BoxingAnalyzer({ stance: opt.analyzerStance || opt.stance });
  const excursions = [];
  analyzer.onExcursion = (x) => excursions.push(x);
  const detected = [];
  const events = [];
  const euro = opt.euro ? makeEuro(opt.euro.minCutoff, opt.euro.beta, opt.euro.dCutoff || 1) : null;
  let nextFrameAt = 0.0, simT = 0, lastT = null;
  const rngJ = (() => { let a = 12345; return () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; }; })();
  analyzer.beginRound(1, 0);
  const STEP = 1 / 240;
  while (simT < duration) {
    sim.step(STEP);
    simT = sim.t;
    if (simT + 1e-9 < nextFrameAt) continue;
    const jitter = opt.jitter ? (rngJ() - 0.5) * opt.jitter / fps : 0;
    nextFrameAt += 1 / fps + jitter;
    if (opt.dropRate && rngJ() < opt.dropRate) continue;
    const fr = sim.frame();
    let lms = fr.landmarks, world = fr.world;
    if (euro) {
      const dt = lastT === null ? 0 : simT - lastT;
      lms = lms.map((l, i) => ({ ...l, x: euro('x' + i, l.x, dt, 0.25), y: euro('y' + i, l.y, dt, 0.25) }));
      world = world.map((w, i) => ({ x: euro('wx' + i, w.x, dt, 0.5), y: euro('wy' + i, w.y, dt, 0.5), z: euro('wz' + i, w.z, dt, 0.5) }));
    }
    lastT = simT;
    const frame = core.buildPoseFrame(simT, lms, opt.noWorld ? null : world, 720, 960);
    const evs = analyzer.update(frame, { counting: true });
    for (const ev of evs) {
      events.push(ev);
      if (ev.type === 'punch') detected.push(ev.punch);
    }
  }
  analyzer.endRound(simT);
  return { sim, analyzer, truth: sim.truth, detected, excursions, events };
}

function match(truth, detected) {
  const used = new Set();
  const pairs = [];
  const missed = [];
  for (const tp of truth.punches) {
    let best = -1, bestD = Infinity;
    detected.forEach((d, i) => {
      if (used.has(i) || d.side !== tp.side) return;
      if (d.t < tp.tStart - 0.06 || d.t > tp.tEnd + 0.12) return;
      const dd = Math.abs(d.t - tp.tPeak);
      if (dd < bestD) { bestD = dd; best = i; }
    });
    if (best >= 0) { used.add(best); pairs.push({ tp, d: detected[best] }); } else missed.push(tp);
  }
  const extra = detected.filter((_, i) => !used.has(i));
  return { pairs, missed, extra };
}

function report(core, res, label) {
  const { pairs, missed, extra } = match(res.truth, res.detected);
  const n = res.truth.punches.length;
  const kindOk = pairs.filter((p) => p.d.kind === p.tp.kind).length;
  const conf = {};
  for (const p of pairs) { const k = `${p.tp.kind}->${p.d.kind}`; conf[k] = (conf[k] || 0) + 1; }
  // 실수 감지(분석기가 평가한 것만)
  const evalStat = (truthKey, detKey) => {
    let tp = 0, fn = 0, fp = 0, tn = 0, na = 0;
    for (const p of pairs) {
      const t = p.tp[truthKey], d = p.d[detKey];
      if (t === null || t === undefined) continue;
      if (d === null || d === undefined) { na++; continue; }
      if (t && d) tp++; else if (t && !d) fn++; else if (!t && d) fp++; else tn++;
    }
    return { tp, fn, fp, tn, na };
  };
  const out = {
    label, truth: n, detected: res.detected.length,
    recall: +(pairs.length / n).toFixed(3), precision: +(pairs.length / Math.max(1, res.detected.length)).toFixed(3),
    kindAcc: +(kindOk / Math.max(1, pairs.length)).toFixed(3),
    confusion: conf,
    otherDrop: evalStat('otherDrop', 'guardDrop'),
    slow: evalStat('slow', 'slow'),
    noRotation: evalStat('noRotation', 'noRotation'),
    missedKinds: missed.reduce((m, p) => { m[p.kind] = (m[p.kind] || 0) + 1; return m; }, {}),
    extraKinds: extra.reduce((m, p) => { m[p.kind] = (m[p.kind] || 0) + 1; return m; }, {}),
  };
  return out;
}

module.exports = { loadCore, run, match, report, makeEuro };
