const assert = require('assert');
const { loadCore, run } = require('./harness');
const core = loadCore();
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok -', name); };

test('RoundTimer: 준비→라운드→휴식→라운드→끝, 10초 경고, 카운트다운', () => {
  const tm = new core.RoundTimer({ roundSec: 30, restSec: 10, rounds: 2, readySec: 5 });
  const ev = [...tm.start(100)];
  for (let t = 100; t <= 190; t += 0.1) ev.push(...tm.update(t));
  const seq = ev.map((e) => e.type === 'phase' ? `${e.phase}${e.round}` : e.type === 'count' ? `c${e.n}` : e.type === 'warn10' ? 'w' : e.type === 'roundEnd' ? `end${e.round}` : e.type).join(' ');
  assert.strictEqual(seq, 'ready0 c3 c2 c1 round1 w end1 rest1 c3 c2 c1 round2 w end2 done');
  assert.strictEqual(tm.phase, 'done');
});
test('RoundTimer: 일시정지 동안 시간이 안 감, 큰 시간 점프도 순서대로 처리', () => {
  const tm = new core.RoundTimer({ roundSec: 10, restSec: 5, rounds: 3, readySec: 0 });
  tm.start(0);
  tm.update(4);
  tm.pause(4);
  tm.update(50);
  assert.strictEqual(tm.phase, 'round');
  assert.ok(Math.abs(tm.remaining(50) - 6) < 1e-9);
  tm.resume(50);
  const ev = tm.update(50 + 6 + 5 + 10 + 5 + 10 + 1);
  assert.strictEqual(tm.phase, 'done');
  assert.strictEqual(ev.filter((e) => e.type === 'roundEnd').length, 3);
});
test('buildPoseFrame: 잘못된 입력은 null', () => {
  assert.strictEqual(core.buildPoseFrame(0, null, null, 10, 10), null);
  assert.strictEqual(core.buildPoseFrame(0, new Array(10).fill({ x: 0, y: 0 }), null, 10, 10), null);
  const bad = new Array(33).fill(0).map(() => ({ x: NaN, y: 0.5 }));
  assert.strictEqual(core.buildPoseFrame(0, bad, null, 100, 100), null);
  const ok = new Array(33).fill(0).map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
  assert.ok(core.buildPoseFrame(0, ok, null, 100, 0) === null);
});
test('분석기: 사람이 없거나 어깨가 안 보여도 죽지 않음', () => {
  const a = new core.BoxingAnalyzer();
  assert.strictEqual(a.update(null).length, 0);
  const lms = new Array(33).fill(0).map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.1 }));
  const fr = core.buildPoseFrame(1, lms, null, 640, 480);
  assert.strictEqual(a.update(fr).length, 0);
  const s = a.summary();
  assert.strictEqual(s.total, 0);
  assert.strictEqual(s.perMinute, null);
  assert.ok(typeof s.issues.length === 'number');
});
test('분석기: 시간이 거꾸로 가면(영상 되감기) 진행 중 펀치만 버리고 계속', () => {
  const res = run(core, { fps: 30, duration: 20, seed: 3 });
  const a = res.analyzer;
  const before = a.punches.length;
  const sim = core.createShadowboxSimulation({ seed: 3 });
  for (let i = 0; i < 30; i++) sim.step(1 / 30);
  const fr = sim.frame();
  a.update(core.buildPoseFrame(1.0, fr.landmarks, fr.world, 720, 960));
  assert.strictEqual(a.punches.length, before);
  assert.ok(['idle', 'out', 'back', 'settle'].includes(a.hands.L.state));
});
test('스탠스를 바꾸면 잽/스트레이트 이름이 바뀜(기록은 그대로)', () => {
  const res = run(core, { fps: 30, duration: 40, seed: 3 });
  const a = res.analyzer;
  const s1 = a.summary();
  a.setStance('southpaw');
  const s2 = a.summary();
  assert.strictEqual(s1.counts.jab, s2.counts.cross);
  assert.strictEqual(s1.counts.cross, s2.counts.jab);
  assert.strictEqual(s1.total, s2.total);
});
test('라운드별 집계와 콤비네이션', () => {
  const sim = core.createShadowboxSimulation({ seed: 2, combos: [[1, 2]] });
  const a = new core.BoxingAnalyzer();
  let next = 0;
  a.beginRound(1, 0);
  while (sim.t < 30) {
    sim.step(1 / 240);
    if (sim.t < next) continue;
    next += 1 / 30;
    if (sim.t > 15 && a.round && a.round.index === 1) a.beginRound(2, sim.t);
    const fr = sim.frame();
    a.update(core.buildPoseFrame(sim.t, fr.landmarks, fr.world, 720, 960));
  }
  a.endRound(sim.t);
  assert.strictEqual(a.rounds.length, 2);
  assert.ok(a.rounds[0].punches > 5 && a.rounds[1].punches > 5);
  const s = a.summary();
  assert.strictEqual(s.combos.top[0].key, '1-2');
  assert.ok(s.combos.comboShare > 0.8, `comboShare ${s.combos.comboShare}`);
});
test('카운트 안 하는 동안(준비·휴식)은 기록 안 함', () => {
  const sim = core.createShadowboxSimulation({ seed: 6 });
  const a = new core.BoxingAnalyzer();
  let next = 0, seen = 0;
  while (sim.t < 20) {
    sim.step(1 / 240);
    if (sim.t < next) continue;
    next += 1 / 30;
    const fr = sim.frame();
    for (const ev of a.update(core.buildPoseFrame(sim.t, fr.landmarks, fr.world, 720, 960), { counting: false })) if (ev.type === 'punch') seen++;
  }
  assert.ok(seen > 5);
  assert.strictEqual(a.punches.length, 0);
  assert.strictEqual(a.session.time, 0);
});
test('3D 없이도(worldLandmarks 없음) 펀치 감지', () => {
  const res = run(core, { fps: 30, duration: 30, seed: 3, noWorld: true });
  assert.ok(res.detected.length >= res.truth.punches.length * 0.9);
});
test('성능: 프레임당 처리 시간', () => {
  const sim = core.createShadowboxSimulation({ seed: 1 });
  const frames = [];
  for (let i = 0; i < 600; i++) { sim.step(1 / 30); const fr = sim.frame(); frames.push(core.buildPoseFrame(sim.t, fr.landmarks, fr.world, 720, 960)); }
  const a = new core.BoxingAnalyzer();
  const t0 = process.hrtime.bigint();
  for (const f of frames) a.update(f);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / frames.length;
  console.log(`   ${ms.toFixed(3)} ms/frame`);
  assert.ok(ms < 1);
});
console.log(`${passed} passed`);
