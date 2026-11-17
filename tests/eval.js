// 여러 조건(노이즈·fps·깊이 압축·부호 반전·평활화)에서 감지율·정확도 표
const { loadCore, run, report } = require('./harness');
const core = loadCore();
const NOISE = { px: 0.003, world: 0.012, worldZ: 0.03, blur: 0.15 };
const HEAVY = { px: 0.005, world: 0.02, worldZ: 0.05, blur: 0.3 };
const conds = [
  { label: 'clean 30fps', fps: 30 },
  { label: 'noise 30fps', fps: 30, noise: NOISE },
  { label: 'noise 20fps', fps: 20, noise: NOISE, jitter: 0.3 },
  { label: 'noise 15fps', fps: 15, noise: NOISE, jitter: 0.3 },
  { label: 'noise 12fps', fps: 12, noise: NOISE, jitter: 0.3 },
  { label: 'heavy 30fps', fps: 30, noise: HEAVY },
  { label: 'heavy 15fps', fps: 15, noise: HEAVY, jitter: 0.3 },
  { label: 'depth x0.6 20fps', fps: 20, noise: NOISE, depthScale: 0.6 },
  { label: 'depth x0.4 20fps', fps: 20, noise: NOISE, depthScale: 0.4 },
  { label: 'flipZ 20fps', fps: 20, noise: NOISE, flipZ: true },
  { label: 'euro 20fps', fps: 20, noise: NOISE, euro: { minCutoff: 1.0, beta: 1.5 } },
  { label: 'no world 20fps', fps: 20, noise: NOISE, noWorld: true },
  { label: 'southpaw 20fps', fps: 20, noise: NOISE, stance: 'southpaw' },
  { label: 'drop10% 20fps', fps: 20, noise: NOISE, dropRate: 0.1 },
];
const rows = [];
for (const c of conds) {
  const seeds = [3, 5, 9];
  const agg = { truth: 0, det: 0, rec: 0, prec: 0, kind: 0, conf: {}, od: { tp: 0, fn: 0, fp: 0, tn: 0, na: 0 }, sl: { tp: 0, fn: 0, fp: 0, tn: 0, na: 0 }, nr: { tp: 0, fn: 0, fp: 0, tn: 0, na: 0 } };
  for (const seed of seeds) {
    const r = report(core, run(core, { duration: 120, seed, ...c }), c.label);
    agg.truth += r.truth; agg.det += r.detected; agg.rec += r.recall / seeds.length; agg.prec += r.precision / seeds.length; agg.kind += r.kindAcc / seeds.length;
    for (const [k, v] of Object.entries(r.confusion)) agg.conf[k] = (agg.conf[k] || 0) + v;
    for (const [dst, src] of [[agg.od, r.otherDrop], [agg.sl, r.slow], [agg.nr, r.noRotation]]) for (const k of Object.keys(dst)) dst[k] += src[k];
  }
  const mis = Object.entries(agg.conf).filter(([k]) => { const [a, b] = k.split('->'); return a !== b; }).map(([k, v]) => `${k}:${v}`).join(' ');
  const f = (s) => `${s.tp}/${s.tp + s.fn} fp${s.fp}/${s.fp + s.tn} na${s.na}`;
  rows.push(`${c.label.padEnd(18)} rec ${agg.rec.toFixed(3)} prec ${agg.prec.toFixed(3)} kind ${agg.kind.toFixed(3)} | drop ${f(agg.od)} | slow ${f(agg.sl)} | rot ${f(agg.nr)} | ${mis}`);
}
console.log(rows.join('\n'));
