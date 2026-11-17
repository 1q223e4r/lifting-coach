// ==CORE START==
// 복싱 코치 분석 엔진: 브라우저 API 없이 순수 계산만 있어서 Node에서도 테스트할 수 있음
(function (root) {
  'use strict';

  const DEG = Math.PI / 180;

  // 기준값은 일반적인 복싱 코칭 원칙 + 합성 데이터로 정한 1차 값. 실제 영상으로 다시 맞춰야 함
  const CONFIG = Object.freeze({
    minVis: 0.5,
    excursion: Object.freeze({
      start: 0.8,           // 가드 위치에서 이만큼 벗어나면 '손이 나감'
      end: 0.45,            // 이 아래로 돌아오면 '회수 끝'
      endRatio: 0.45,       // 또는 최고점의 45% 아래 + 화면상 거의 돌아옴
      end2d: 0.5,
      splitDropRatio: 0.62, // 최고점 대비 이만큼 내려오면 회수 시작
      splitRise: 0.35,      // 회수 중 다시 이만큼 오르면 같은 손 연타(잽-잽)
      returnRatio: 0.4,     // 최고점의 40%까지 내려온 시각 = 회수 시간 기준
      minPeak: 1.0,
      maxDurSec: 1.2,
      settleSec: 0.5,
      settleSpeed: 0.7,     // 몸통 길이/초
      stillSec: 0.35,       // 나간 손이 이만큼 멈춰 있고 펀치 모양이 아니면 그 자리를 새 기준으로(가드 내림 등)
      stillRange: 0.3,
      homeTauSec: 1.2,      // 가드 기준 위치가 따라가는 속도
      homeInitFrames: 8,
    }),
    // 가드에서 벗어난 정도를 합칠 때 쓰는 눈금(몸통 길이 단위, 각도는 도)
    norm: Object.freeze({ lift: 0.3, angle: 60, fwd: 0.3, pos: 0.32, fore: 0.3, shrink: 0.3 }),
    classify: Object.freeze({
      straightAngle: 128, straightFwd: 0.25, liftMin: 0.2,
      hookForearm: 0.2, hookMaxAngle: 140,
      upperDip: 0.1, upperRise: 0.22, upperVel: 1.3, upperMaxLift: 0.24, upperForearmUp: 0.12, upperFwd: 0.12,
      shrinkMin: 0.25, hookMaxShrink: 0.2,
    }),
    guard: Object.freeze({ lowV: 0.06, dropMargin: 0.15 }),
    returnSlowSec: 0.25,   // 최고점에서 60% 돌아오기까지(전체 회수로 치면 약 0.45초)
    elbowFlareOut: 0.16,
    chinUpMax: 0.02,
    stance: Object.freeze({ narrow: 0.3, wide: 1.25 }),
    kneeStraightDeg: 165,
    rotationMin: 0.28,
    comboGapSec: 0.7,
    sustain: Object.freeze({ guardLow: 1.2, elbowFlare: 1.6, chinUp: 2.0, stiffKnees: 4.0, narrowStance: 3.0, wideStance: 3.0 }),
    cue: Object.freeze({ globalGapSec: 3.5, sameGapSec: 12 }),
    frontRatioMin: 0.32,
  });

  const LM = Object.freeze({
    NOSE: 0, L_EAR: 7, R_EAR: 8,
    L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14, L_WRIST: 15, R_WRIST: 16,
    L_PINKY: 17, R_PINKY: 18, L_INDEX: 19, R_INDEX: 20, L_THUMB: 21, R_THUMB: 22,
    L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26, L_ANKLE: 27, R_ANKLE: 28,
    L_HEEL: 29, R_HEEL: 30, L_TOE: 31, R_TOE: 32,
  });
  const SIDES = Object.freeze({
    L: Object.freeze({ shoulder: 11, elbow: 13, wrist: 15, pinky: 17, index: 19, thumb: 21, hip: 23, knee: 25, ankle: 27, other: 'R' }),
    R: Object.freeze({ shoulder: 12, elbow: 14, wrist: 16, pinky: 18, index: 20, thumb: 22, hip: 24, knee: 26, ankle: 28, other: 'L' }),
  });
  const MIN_VIS = CONFIG.minVis;

  // 번호는 체육관에서 흔히 쓰는 체계(1 잽, 2 스트레이트, 3 앞손 훅, 4 뒷손 훅, 5 앞손 어퍼, 6 뒷손 어퍼)
  const PUNCH_TYPES = Object.freeze({
    jab: Object.freeze({ label: '잽', short: '잽', num: 1, kind: 'straight', role: 'lead' }),
    cross: Object.freeze({ label: '스트레이트', short: '스트', num: 2, kind: 'straight', role: 'rear' }),
    leadHook: Object.freeze({ label: '앞손 훅', short: '훅', num: 3, kind: 'hook', role: 'lead' }),
    rearHook: Object.freeze({ label: '뒷손 훅', short: '훅', num: 4, kind: 'hook', role: 'rear' }),
    leadUpper: Object.freeze({ label: '앞손 어퍼', short: '어퍼', num: 5, kind: 'uppercut', role: 'lead' }),
    rearUpper: Object.freeze({ label: '뒷손 어퍼', short: '어퍼', num: 6, kind: 'uppercut', role: 'rear' }),
  });
  const PUNCH_ORDER = Object.freeze(['jab', 'cross', 'leadHook', 'rearHook', 'leadUpper', 'rearUpper']);
  function typeFor(kind, role) {
    if (kind === 'straight') return role === 'lead' ? 'jab' : 'cross';
    if (kind === 'hook') return role === 'lead' ? 'leadHook' : 'rearHook';
    return role === 'lead' ? 'leadUpper' : 'rearUpper';
  }

  // confidence: high = 화면에서 바로 재는 값, medium = 기준이 사람·촬영마다 조금 다름, low = AI 깊이 추정에 기댐
  const ISSUES = Object.freeze({
    otherHandDrop: Object.freeze({
      label: '칠 때 반대손이 내려가요', cue: '반대손 턱에', tip: '치는 동안 안 치는 손은 턱에 붙여 두세요.', unit: 'punch', weight: 1.25, confidence: 'high',
      detail: '펀치를 뻗는 동안 안 치는 손이 얼굴에서 떨어졌어요. 잽을 칠 땐 뒷손을 턱에, 스트레이트를 칠 땐 앞손을 얼굴 앞에 그대로 두세요.',
    }),
    guardLow: Object.freeze({
      label: '가드가 내려가요', cue: '가드 올려요', tip: '쉴 때도 두 주먹은 광대뼈 높이에 두세요.', unit: 'time', weight: 1.2, confidence: 'high',
      detail: '펀치를 안 칠 때 주먹이 턱보다 아래로 내려가 있었어요. 쉬는 순간에 맞기 쉬워요. 두 주먹을 광대뼈 높이에, 팔꿈치는 옆구리에 두세요.',
    }),
    slowReturn: Object.freeze({
      label: '회수가 느려요', cue: '빨리 회수', tip: '뻗은 속도 그대로 가드까지 당겨 오세요.', unit: 'punch', weight: 1.0, confidence: 'medium',
      detail: '펀치를 뻗은 뒤 가드로 돌아오는 데 0.45초보다 오래 걸렸어요. 뻗을 때와 같은 길로, 같은 속도로 턱 앞까지 당겨 오세요.',
    }),
    chinUp: Object.freeze({
      label: '턱이 들려 있어요', cue: '턱 당겨요', tip: '턱을 살짝 당기고 눈썹 아래로 앞을 보세요.', unit: 'time', weight: 1.0, confidence: 'medium',
      detail: '코가 귀 높이보다 올라가 있는 시간이 있었어요. 턱이 들리면 맞았을 때 충격이 커요. 턱을 당기고 눈만 치켜떠서 앞을 보세요.',
    }),
    elbowFlare: Object.freeze({
      label: '팔꿈치가 벌어져요', cue: '팔꿈치 붙여요', tip: '가드할 때 팔꿈치를 갈비뼈 쪽으로 붙이세요.', unit: 'time', weight: 0.9, confidence: 'medium',
      detail: '가드 자세에서 팔꿈치가 어깨 바깥으로 벌어져 있었어요. 옆구리가 비고, 펀치도 크게 돌아서 나가요.',
    }),
    noRotation: Object.freeze({
      label: '스트레이트가 팔로만 나가요', cue: '허리 같이 돌려요', tip: '뒷발 뒤꿈치를 들며 허리와 어깨를 같이 돌리세요.', unit: 'punch', weight: 0.8, confidence: 'low',
      detail: '스트레이트를 칠 때 뒷어깨가 앞으로 충분히 나오지 않았어요. 뒷발을 축으로 허리를 돌리면 어깨가 따라 나와요.',
    }),
    narrowStance: Object.freeze({
      label: '발이 일직선이에요', cue: '발 좌우로 벌려요', tip: '양발을 좌우로 어깨너비쯤 벌리세요.', unit: 'time', weight: 0.8, confidence: 'medium',
      detail: '정면에서 봤을 때 두 발이 거의 한 줄에 있었어요. 옆에서 밀리면 균형이 무너져요. 기찻길 두 줄 위에 선다고 생각하세요.',
    }),
    wideStance: Object.freeze({
      label: '스탠스가 너무 넓어요', cue: '발 간격 좁혀요', tip: '발 간격을 어깨너비 정도로 줄이세요.', unit: 'time', weight: 0.7, confidence: 'medium',
      detail: '발을 좌우로 너무 넓게 벌리고 있었어요. 빨리 움직이기 어렵고 펀치에 체중이 덜 실려요.',
    }),
    stiffKnees: Object.freeze({
      label: '무릎이 펴져 있어요', cue: '무릎 살짝 굽혀요', tip: '무릎을 살짝 굽혀서 탄력 있게 서세요.', unit: 'time', weight: 0.6, confidence: 'low',
      detail: '무릎이 거의 펴진 채로 서 있었어요. 살짝 굽혀야 체중 이동이 되고 펀치에 힘이 실려요.',
    }),
  });
  const ISSUE_ORDER = Object.freeze(Object.keys(ISSUES));

  // ===== 수학 유틸 =====
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, k) => a + (b - a) * k;
  function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function distance3(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
  function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  // b에서의 내각(도). z가 있으면 3D로 계산
  function angleAtDeg(a, b, c) {
    const ux = a.x - b.x, uy = a.y - b.y, uz = (a.z || 0) - (b.z || 0);
    const vx = c.x - b.x, vy = c.y - b.y, vz = (c.z || 0) - (b.z || 0);
    const nu = Math.hypot(ux, uy, uz), nv = Math.hypot(vx, vy, vz);
    if (nu < 1e-9 || nv < 1e-9) return NaN;
    const cos = clamp((ux * vx + uy * vy + uz * vz) / (nu * nv), -1, 1);
    return Math.acos(cos) / DEG;
  }

  function median(values) {
    if (!values.length) return NaN;
    const s = values.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function meanOf(values) { return values.length ? values.reduce((s, v) => s + v, 0) / values.length : NaN; }

  // 고정 크기 링버퍼: 오래된 데이터가 자동으로 밀려나서 메모리가 늘지 않음
  class RingBuffer {
    constructor(capacity) { this.capacity = capacity; this.items = new Array(capacity); this.start = 0; this.length = 0; }
    push(item) {
      const index = (this.start + this.length) % this.capacity;
      this.items[index] = item;
      if (this.length < this.capacity) this.length++;
      else this.start = (this.start + 1) % this.capacity;
    }
    get(i) { return this.items[(this.start + i) % this.capacity]; }        // 0 = 가장 오래된 것
    last(k = 0) { return this.length > k ? this.get(this.length - 1 - k) : undefined; }
    clear() { this.start = 0; this.length = 0; }
  }

  // ===== 포즈 프레임: 정규화 좌표 → 픽셀 좌표 + 자주 쓰는 값 미리 계산 =====
  const FOOT_POINTS = [LM.L_ANKLE, LM.R_ANKLE, LM.L_HEEL, LM.R_HEEL, LM.L_TOE, LM.R_TOE];
  function buildPoseFrame(t, landmarks, worldLandmarks, width, height) {
    if (!Array.isArray(landmarks) || landmarks.length < 33 || !(width > 0) || !(height > 0)) return null;
    const px = new Array(33);
    for (let i = 0; i < 33; i++) {
      const lm = landmarks[i];
      if (!lm || !Number.isFinite(lm.x) || !Number.isFinite(lm.y)) return null;
      px[i] = { x: lm.x * width, y: lm.y * height, z: (Number.isFinite(lm.z) ? lm.z : 0) * width, v: typeof lm.visibility === 'number' ? lm.visibility : 1 };
    }
    const shoulderMid = midpoint(px[LM.L_SHOULDER], px[LM.R_SHOULDER]);
    const hipMid = midpoint(px[LM.L_HIP], px[LM.R_HIP]);
    const torsoLen = distance(shoulderMid, hipMid);
    const hipsVisible = px[LM.L_HIP].v >= MIN_VIS && px[LM.R_HIP].v >= MIN_VIS;
    // 결과 객체가 해제돼도 안전하도록 3D 좌표는 복사. 3D가 없으면 화면 좌표 + 상대 깊이로 대신(몸통 0.5m 가정)
    let world = null, worldSynthetic = false;
    if (Array.isArray(worldLandmarks) && worldLandmarks.length >= 33) {
      world = new Array(33);
      for (let i = 0; i < 33; i++) {
        const w = worldLandmarks[i];
        world[i] = { x: w.x, y: w.y, z: w.z };
      }
    } else if (torsoLen > 1) {
      const s = 0.5 / torsoLen;
      world = px.map((p) => ({ x: p.x * s, y: p.y * s, z: p.z * s }));
      worldSynthetic = true;
    }
    let groundY = -Infinity;
    for (const i of FOOT_POINTS) if (px[i].v >= MIN_VIS && px[i].y > groundY) groundY = px[i].y;
    const la = px[LM.L_ANKLE], ra = px[LM.R_ANKLE];
    const feetVisible = la.v >= MIN_VIS && ra.v >= MIN_VIS && Math.max(la.y, ra.y) < height * 0.985;
    const nose = px[LM.NOSE];
    return {
      t, px, world, worldSynthetic, width, height,
      shoulderMid, hipMid, torsoLen, hipsVisible, feetVisible,
      feetCut: !feetVisible,
      headCut: nose.v < MIN_VIS || nose.y < height * 0.02,
      groundY: Number.isFinite(groundY) ? groundY : null,
    };
  }

  // 몸 기준 좌표축: 위(엉덩이→어깨), 옆(자기 어깨→반대 어깨). 길이는 몸통 길이로 나눠서 거리·키와 무관하게
  function measureBody(frame) {
    const P = frame.px;
    const ls = P[LM.L_SHOULDER], rs = P[LM.R_SHOULDER];
    if (ls.v < MIN_VIS || rs.v < MIN_VIS) return null;
    const shoulderW = distance(ls, rs);
    let torso, up;
    if (frame.hipsVisible && frame.torsoLen > Math.max(4, shoulderW * 0.5)) {
      torso = frame.torsoLen;
      up = { x: (frame.shoulderMid.x - frame.hipMid.x) / torso, y: (frame.shoulderMid.y - frame.hipMid.y) / torso };
    } else {
      torso = shoulderW * 1.45;   // 엉덩이가 안 보이면 어깨너비로 추정
      up = { x: 0, y: -1 };
    }
    if (!(torso > 4)) return null;
    // 옆 방향은 '위'에 수직인 축을 쓰고 방향만 어깨로 정함(몸을 돌려 어깨가 겹쳐도 축이 안 튐)
    const perp = { x: -up.y, y: up.x };
    const sign = (rs.x - ls.x) * perp.x + (rs.y - ls.y) * perp.y >= 0 ? 1 : -1;
    const latL = { x: perp.x * sign, y: perp.y * sign };
    return { torso, up, shoulderW, lat: { L: latL, R: { x: -latL.x, y: -latL.y } }, frontRatio: shoulderW / torso };
  }

  // 주먹 중심: 손목과 검지·새끼 뿌리 평균(장갑을 끼면 손가락 점이 흔들려서 손목 비중을 높임)
  function fistPoint(P, side) {
    const S = SIDES[side];
    const w = P[S.wrist], i = P[S.index], p = P[S.pinky];
    if (i.v >= 0.3 && p.v >= 0.3) return { x: (2 * w.x + i.x + p.x) / 4, y: (2 * w.y + i.y + p.y) / 4 };
    return { x: w.x, y: w.y };
  }

  // 한 손의 상태값(몸통 길이 단위). 위치는 두 어깨 가운데 기준이라 몸통을 돌려도 가드 손은 제자리로 읽힘
  function handFeatures(frame, side, body, depthSign, armLen) {
    const S = SIDES[side];
    const P = frame.px;
    const mid = frame.shoulderMid, sh = P[S.shoulder], el = P[S.elbow], wr = P[S.wrist];
    const fist = fistPoint(P, side);
    const lat = body.lat[side], up = body.up, T = body.torso;
    const fx = fist.x - mid.x, fy = fist.y - mid.y, ex = el.x - mid.x, ey = el.y - mid.y;
    const ax = wr.x - el.x, ay = wr.y - el.y;
    const f = {
      fist,
      elbow: { x: el.x, y: el.y },
      fistIn: (fx * lat.x + fy * lat.y) / T,     // +: 반대쪽(몸 가운데를 넘어감)
      fistV: (fx * up.x + fy * up.y) / T,        // +: 어깨선보다 위
      elbowLift: (ex * up.x + ey * up.y) / T,    // 팔꿈치 높이(가드 땐 어깨 아래, 뻗으면 어깨 높이)
      elbowOut: -((el.x - sh.x) * lat.x + (el.y - sh.y) * lat.y) / T,  // +: 자기 어깨보다 바깥
      forearmIn: (ax * lat.x + ay * lat.y) / T,  // 아래팔이 화면에서 가로로 안쪽을 향하는 정도(훅)
      forearmUp: (ax * up.x + ay * up.y) / T,    // 아래팔이 세워진 정도(가드·어퍼컷)
      armSpan: (distance(sh, el) + distance(el, wr)) / T,  // 화면에 보이는 팔 길이(카메라 쪽으로 뻗으면 짧아 보임)
      angle: NaN,                                // 팔꿈치 각도(3D)
      fwd: NaN,                                  // 손목이 어깨선보다 카메라 쪽으로 나온 정도(팔 길이 단위)
      vis: Math.min(P[S.wrist].v, P[S.elbow].v),
    };
    const Wd = frame.world;
    if (Wd) {
      const s3 = Wd[S.shoulder], e3 = Wd[S.elbow], w3 = Wd[S.wrist];
      const midZ = (Wd[LM.L_SHOULDER].z + Wd[LM.R_SHOULDER].z) / 2;
      f.angle = angleAtDeg(s3, e3, w3);
      f.fwd = (depthSign * (midZ - w3.z)) / armLen;
    }
    return f;
  }

  const FEATURE_KEYS = ['fistIn', 'fistV', 'elbowLift', 'elbowOut', 'forearmIn', 'forearmUp', 'armSpan', 'angle', 'fwd'];
  function medianFeatures(list) {
    const out = {};
    for (const k of FEATURE_KEYS) out[k] = median(list.map((f) => f[k]).filter(Number.isFinite));
    return out;
  }
  function copyFeatures(f) {
    const out = {};
    for (const k of FEATURE_KEYS) out[k] = f[k];
    return out;
  }
  function blendHome(home, f, alpha) {
    for (const k of FEATURE_KEYS) {
      if (!Number.isFinite(f[k])) continue;
      home[k] = Number.isFinite(home[k]) ? home[k] + (f[k] - home[k]) * alpha : f[k];
    }
  }

  // 가드 위치에서 벗어난 정도. 팔꿈치 들림·팔 펴짐·앞으로 나감·아래팔 가로 눕힘은 '+ 방향만', 주먹 위치는 어느 쪽이든
  function excursionScore(f, H) {
    const n = CONFIG.norm;
    const dLift = Math.max(0, f.elbowLift - H.elbowLift) / n.lift;
    const dAngle = Number.isFinite(f.angle) && Number.isFinite(H.angle) ? Math.max(0, f.angle - H.angle) / n.angle : 0;
    const dFwd = Number.isFinite(f.fwd) && Number.isFinite(H.fwd) ? Math.max(0, f.fwd - H.fwd) / n.fwd : 0;
    const dPos = Math.hypot(f.fistIn - H.fistIn, f.fistV - H.fistV) / n.pos;
    const dFore = Math.max(0, f.forearmIn - H.forearmIn) / n.fore;
    const dShrink = Math.max(0, H.armSpan - f.armSpan) / n.shrink;
    return {
      e: Math.sqrt(dLift * dLift + dAngle * dAngle + dFwd * dFwd + dPos * dPos + dFore * dFore + dShrink * dShrink),
      e2d: Math.hypot(dLift, dPos, dFore, dShrink),
    };
  }

  // 회수 시간 재는 용도: 손목 위치에 거의 비례하는 값만(팔꿈치 각도는 다 펴진 근처에서 급변해서 제외)
  function displacement(f, H) {
    const n = CONFIG.norm;
    const dFwd = Number.isFinite(f.fwd) && Number.isFinite(H.fwd) ? Math.max(0, f.fwd - H.fwd) / n.fwd : 0;
    const dLift = Math.max(0, f.elbowLift - H.elbowLift) / n.lift;
    const dPos = Math.hypot(f.fistIn - H.fistIn, f.fistV - H.fistV) / n.pos;
    return Math.hypot(dFwd, dLift, dPos);
  }

  // 손이 나갔다 돌아온 한 번의 움직임 → 펀치 종류(아니면 none)
  //  스트레이트: 팔이 펴지고(3D) 앞으로 나감 + 팔꿈치가 어깨 높이로 들림
  //  훅: 팔꿈치가 어깨 높이로 들리고, 아래팔이 화면에서 가로로 눕혀져 안쪽을 향함(정면에서 아래팔이 다 보임)
  //  어퍼컷: 주먹이 살짝 내려갔다가 빠르게 올라옴, 팔꿈치는 낮게
  function classifyExcursion(exc) {
    const C = CONFIG.classify;
    const H = exc.home, S = exc.samples;
    const result = { kind: 'none', why: '' };
    if (!S.length || exc.peakE < CONFIG.excursion.minPeak) { result.why = 'weak'; return result; }
    let maxAngle = -Infinity, maxFwd = -Infinity, maxLift = -Infinity, maxFore = -Infinity, minV = Infinity, minVIdx = 0, minSpan = Infinity;
    for (let i = 0; i < S.length; i++) {
      const f = S[i].f;
      if (f.armSpan < minSpan) minSpan = f.armSpan;
      if (f.angle > maxAngle) maxAngle = f.angle;
      if (f.fwd > maxFwd) maxFwd = f.fwd;
      if (f.elbowLift > maxLift) maxLift = f.elbowLift;
      if (f.forearmIn > maxFore) maxFore = f.forearmIn;
      if (f.fistV < minV) { minV = f.fistV; minVIdx = i; }
    }
    // 가장 낮았던 지점 이후로 주먹이 얼마나 빨리, 얼마나 올라갔는지(어퍼컷)
    let upVel = 0, maxVAfter = minV, foreUpAtTop = NaN;
    for (let i = minVIdx + 1; i < S.length; i++) {
      const dt = S[i].t - S[i - 1].t;
      if (dt > 1e-4) upVel = Math.max(upVel, (S[i].f.fistV - S[i - 1].f.fistV) / dt);
      if (S[i].f.fistV > maxVAfter) { maxVAfter = S[i].f.fistV; foreUpAtTop = S[i].f.forearmUp; }
    }
    // 첫 샘플 전에 이미 내려가고 있었을 수 있어서, 가드 기준 높이에서 첫 샘플까지의 속도도 고려하지 않음(오탐 방지)
    const has3d = maxAngle > -Infinity && Number.isFinite(H.angle);
    const dLift = maxLift - H.elbowLift;
    const dFwd = maxFwd > -Infinity && Number.isFinite(H.fwd) ? maxFwd - H.fwd : NaN;
    const fore = maxFore - H.forearmIn;
    const dip = H.fistV - minV;
    const rise = maxVAfter - minV;
    const shrink = H.armSpan - minSpan;
    Object.assign(result, { maxAngle: has3d ? maxAngle : NaN, dLift, dFwd, fore, dip, rise, upVel, foreUpAtTop, shrink });

    const extended = has3d && maxAngle >= C.straightAngle && (!Number.isFinite(dFwd) || dFwd >= C.straightFwd);
    const lifted = dLift >= C.liftMin;
    const upright = !Number.isFinite(foreUpAtTop) || foreUpAtTop >= C.upperForearmUp;
    const forward = !Number.isFinite(dFwd) || dFwd >= C.upperFwd;   // 손만 내렸다 올린 건 어퍼컷이 아님
    if (dip >= C.upperDip && rise >= C.upperRise && upVel >= C.upperVel && dLift < C.upperMaxLift && upright && forward && !extended && minVIdx < S.length - 1) {
      result.kind = 'uppercut';
    } else if (lifted && fore >= C.hookForearm && shrink < C.hookMaxShrink && !(has3d && maxAngle >= C.hookMaxAngle)) {
      result.kind = 'hook';
    } else if (extended && (lifted || !Number.isFinite(dFwd) || dFwd >= C.straightFwd * 1.6)) {
      result.kind = 'straight';
    } else if (shrink >= C.shrinkMin && (!Number.isFinite(dFwd) || dFwd >= C.upperFwd)) {
      result.kind = 'straight';   // 정면 카메라: 팔이 카메라 쪽으로 펴지면 화면에서 팔이 짧아 보임
    } else if (lifted && !has3d) {
      result.kind = 'straight';   // 3D가 없으면 팔꿈치 들림만으로
    } else if (lifted && has3d && maxAngle >= C.straightAngle - 18 && Number.isFinite(dFwd) && dFwd >= C.straightFwd) {
      result.kind = 'straight';   // 깊이를 작게 잡는 경우 대비
    } else {
      result.why = 'shape';
    }
    return result;
  }

  function newStats() {
    return {
      time: 0,
      idleTime: 0, guardLowTime: 0,
      flareBase: 0, flareTime: 0,
      chinBase: 0, chinUpTime: 0,
      kneeBase: 0, kneeStiffTime: 0,
      stanceBase: 0, narrowTime: 0, wideTime: 0, stanceRatioSum: 0, stanceRatioN: 0,
    };
  }
  function newHand(side) {
    return { side, state: 'idle', home: null, init: [], exc: null, settleFor: 0, last: null, e: 0, trail: [], lastTrail: null };
  }
  function pushRecent(list, value, max = 4) { list.push(value); if (list.length > max) list.shift(); }
  function countTrue(list) { let n = 0; for (const v of list) if (v === true) n++; return n; }

  // ===== 분석기 =====
  class BoxingAnalyzer {
    constructor(options = {}) {
      this.stanceEvidence = new RingBuffer(360);
      this.setStance(options.stance);
      this.reset();
    }

    setStance(stance) {
      this.stance = stance === 'southpaw' ? 'southpaw' : 'orthodox';
      this.leadSide = this.stance === 'orthodox' ? 'L' : 'R';
      this.stanceHinted = false;
      this.stanceEvidence.clear();
    }
    roleOf(side) { return side === this.leadSide ? 'lead' : 'rear'; }
    sideOf(role) { return role === 'lead' ? this.leadSide : SIDES[this.leadSide].other; }
    typeOf(punch) { return typeFor(punch.kind, this.roleOf(punch.side)); }

    reset() {
      this.hands = { L: newHand('L'), R: newHand('R') };
      this.punches = [];
      this.rounds = [];
      this.round = null;
      this.session = newStats();
      this.depthVotes = 3;
      this.depthSign = 1;
      this.armLen = 0.55;
      this.bladeHome = NaN;
      this.currentBlade = NaN;
      this.lastT = null;
      this.timers = Object.create(null);
      this.cueLast = Object.create(null);
      this.lastCueAt = -Infinity;
      this.combo = null;
      this.sideTimer = 0;
      this.view = 'unknown';
      this.stanceEvidence.clear();
      this.stanceHinted = false;
      this.recent = { otherDrop: [], slow: [], noRotation: [] };
      this.live = { frame: null, body: null, hands: { L: null, R: null }, guardLow: { L: false, R: false }, chinUp: false };
    }

    // 일시정지·영상 이동처럼 시간이 끊기면 진행 중이던 펀치만 버림(기록은 유지)
    softReset() {
      for (const side of ['L', 'R']) {
        const h = this.hands[side];
        h.state = 'idle';
        h.exc = null;
        h.trail = [];
        h.settleFor = 0;
      }
      this.combo = null;
    }

    beginRound(index, t) {
      if (this.round) this.endRound(t);
      this.round = { index, tStart: t, stats: newStats(), firstPunch: this.punches.length };
      this.combo = null;
    }

    endRound(t) {
      const r = this.round;
      if (!r) return null;
      this.round = null;
      const punches = this.punches.slice(r.firstPunch);
      const counts = this.countTypes(punches);
      const issues = this.computeIssues(r.stats, punches);
      const summary = {
        index: r.index, tStart: r.tStart, tEnd: t, duration: Math.max(0, t - r.tStart),
        punches: punches.length, counts,
        guardUp: r.stats.idleTime > 2 ? 1 - r.stats.guardLowTime / r.stats.idleTime : null,
        topIssue: issues.find((i) => i.rate >= 0.2)?.key || null,
      };
      this.rounds.push(summary);
      return summary;
    }

    countTypes(punches) {
      const counts = {};
      for (const k of PUNCH_ORDER) counts[k] = 0;
      for (const p of punches) counts[this.typeOf(p)]++;
      return counts;
    }

    addTime(key, dt) {
      this.session[key] += dt;
      if (this.round) this.round.stats[key] += dt;
    }

    // 조건이 계속되면 쌓이고, 아니면 두 배 속도로 빠지는 타이머(잠깐 끊겨도 이어서 판단)
    sustain(key, active, dt, limitSec) {
      let v = this.timers[key] || 0;
      v = active ? v + dt : Math.max(0, v - 2 * dt);
      if (v >= limitSec) { this.timers[key] = 0; return true; }
      this.timers[key] = v;
      return false;
    }

    maybeCue(issue, t, events, extra = {}) {
      const C = CONFIG.cue;
      if (t - this.lastCueAt < C.globalGapSec) return false;
      if (t - (this.cueLast[issue] ?? -Infinity) < C.sameGapSec) return false;
      this.lastCueAt = t;
      this.cueLast[issue] = t;
      events.push({ type: 'cue', issue, t, ...extra });
      return true;
    }

    // 코가 귀보다 카메라에 가까운 게 정상 → 깊이 축 방향을 스스로 확인(라이브러리 버전마다 부호가 달라도 안전)
    updateDepthSign(frame) {
      const Wd = frame.world, P = frame.px;
      if (!Wd || frame.worldSynthetic) return;
      if (P[LM.NOSE].v < MIN_VIS || P[LM.L_EAR].v < 0.3 || P[LM.R_EAR].v < 0.3) return;
      const earZ = (Wd[LM.L_EAR].z + Wd[LM.R_EAR].z) / 2;
      const diff = earZ - Wd[LM.NOSE].z;
      if (Math.abs(diff) < 0.02) return;
      this.depthVotes = clamp(this.depthVotes + (diff > 0 ? 1 : -1), -40, 40);
      this.depthSign = this.depthVotes >= 0 ? 1 : -1;
    }

    updateArmLen(frame, dt) {
      const Wd = frame.world, P = frame.px;
      if (!Wd) return;
      let sum = 0, n = 0;
      for (const side of ['L', 'R']) {
        const S = SIDES[side];
        if (P[S.elbow].v < MIN_VIS || P[S.wrist].v < MIN_VIS) continue;
        sum += distance3(Wd[S.shoulder], Wd[S.elbow]) + distance3(Wd[S.elbow], Wd[S.wrist]);
        n++;
      }
      if (!n) return;
      const len = clamp(sum / n, 0.3, 0.9);
      const alpha = 1 - Math.exp(-dt / 3);
      this.armLen += (len - this.armLen) * alpha;
    }

    // 리드 어깨가 뒷어깨보다 카메라에 얼마나 가까운지(어깨너비 단위). 스트레이트 때 줄어들어야 몸통이 돈 것
    bladeOf(frame) {
      const Wd = frame.world;
      if (!Wd || frame.worldSynthetic) return NaN;
      const lead = SIDES[this.leadSide], rear = SIDES[lead.other];
      const a = Wd[lead.shoulder], b = Wd[rear.shoulder];
      const w = distance3(a, b);
      if (!(w > 0.1)) return NaN;
      return (this.depthSign * (b.z - a.z)) / w;
    }

    update(frame, options = {}) {
      const counting = options.counting !== false;
      const events = [];
      if (!frame) {
        this.live.frame = null;
        this.live.body = null;
        return events;
      }
      const t = frame.t;
      let dt = this.lastT === null ? 0 : t - this.lastT;
      if (dt < 0 || dt > 0.5) { this.softReset(); dt = 0; }
      this.lastT = t;

      const body = measureBody(frame);
      this.live.frame = frame;
      this.live.body = body;
      if (!body) return events;

      // 정면인지(어깨너비가 몸통에 비해 너무 좁으면 옆으로 선 것)
      this.sideTimer = body.frontRatio < CONFIG.frontRatioMin ? this.sideTimer + dt : Math.max(0, this.sideTimer - dt);
      this.view = this.sideTimer > 1.5 ? 'side' : 'front';

      this.updateDepthSign(frame);
      this.updateArmLen(frame, dt);
      const feats = {
        L: handFeatures(frame, 'L', body, this.depthSign, this.armLen),
        R: handFeatures(frame, 'R', body, this.depthSign, this.armLen),
      };
      const blade = this.bladeOf(frame);
      this.currentBlade = blade;
      const bothIdle = this.hands.L.state === 'idle' && this.hands.R.state === 'idle';
      if (bothIdle && Number.isFinite(blade)) {
        this.bladeHome = Number.isFinite(this.bladeHome) ? this.bladeHome + (blade - this.bladeHome) * (1 - Math.exp(-dt / 1.5)) : blade;
      }

      for (const side of ['L', 'R']) this.stepHand(this.hands[side], feats[side], t, dt, events, counting);

      // 치는 손이 나가 있는 동안: 반대손 높이·몸통 회전 기록
      for (const side of ['L', 'R']) {
        const hand = this.hands[side];
        const exc = hand.exc;
        if (!exc || hand.state !== 'out') continue;
        const other = this.hands[SIDES[side].other];
        const of = feats[SIDES[side].other];
        const otherFree = other.state === 'idle' || (other.exc && other.exc.tStart >= exc.tStart);
        if (otherFree && of.vis >= 0.3) {
          exc.otherN++;
          if (of.fistV < exc.otherMinV) exc.otherMinV = of.fistV;
        }
      }

      this.checkPosture(frame, body, feats, t, dt, events, counting);
      this.updateStanceHint(frame, t, events);

      if (this.combo && t - this.combo.lastT > CONFIG.comboGapSec) this.closeCombo(events);

      this.live.hands.L = { f: feats.L, state: this.hands.L.state, trail: this.hands.L.trail };
      this.live.hands.R = { f: feats.R, state: this.hands.R.state, trail: this.hands.R.trail };
      return events;
    }

    stepHand(hand, f, t, dt, events, counting) {
      const X = CONFIG.excursion;
      const prev = hand.last;
      hand.last = f;
      if (!hand.home) {
        hand.init.push(f);
        if (hand.init.length >= X.homeInitFrames) { hand.home = medianFeatures(hand.init); hand.init = []; }
        return;
      }
      const { e, e2d } = excursionScore(f, hand.home);
      hand.e = e;
      switch (hand.state) {
        case 'idle':
          if (e >= X.start) {
            hand.exc = this.openExcursion(hand, f, t, e);
            hand.state = 'out';
          } else if (e < X.start * 0.6 && dt > 0) {
            blendHome(hand.home, f, 1 - Math.exp(-dt / X.homeTauSec));
          }
          break;
        case 'out': {
          const exc = hand.exc;
          this.addSample(hand, f, t, e);
          if (this.rehomeIfStill(hand, t)) break;
          if (e > exc.peakE) { exc.peakE = e; exc.peakT = t; exc.peakFist = f.fist; }
          const curD = exc.samples[exc.samples.length - 1].d;
          if (curD > exc.peakD) { exc.peakD = curD; exc.peakDT = t; }
          else if (e < exc.peakE * X.splitDropRatio) { hand.state = 'back'; exc.troughE = e; exc.troughT = t; }
          if (t - exc.tStart > X.maxDurSec) this.closeExcursion(hand, t, 'timeout', events, counting);
          break;
        }
        case 'back': {
          const exc = hand.exc;
          this.addSample(hand, f, t, e);
          if (this.rehomeIfStill(hand, t)) break;
          if (e < exc.troughE) { exc.troughE = e; exc.troughT = t; }
          const cur = exc.samples[exc.samples.length - 1];
          if (exc.returnT === null && cur.d < exc.peakD * X.returnRatio) {
            const prevS = exc.samples[exc.samples.length - 2];
            const target = exc.peakD * X.returnRatio;
            exc.returnT = prevS && prevS.d > cur.d ? prevS.t + ((prevS.d - target) / (prevS.d - cur.d)) * (t - prevS.t) : t;
          }
          if (e < X.end || (e < exc.peakE * X.endRatio && e2d < X.end2d)) {
            if (exc.returnT === null) exc.returnT = t;
            this.closeExcursion(hand, t, 'end', events, counting);
          } else if (e > exc.troughE + X.splitRise && exc.troughE < exc.peakE * 0.75) {
            // 같은 손 연타(잽-잽): 다 돌아오기 전에 다시 나감 → 앞의 것을 닫고 새로 시작
            this.closeExcursion(hand, exc.troughT, 'split', events, counting);
            hand.exc = this.openExcursion(hand, f, t, e);
            hand.state = 'out';
          } else if (t - exc.tStart > X.maxDurSec) {
            this.closeExcursion(hand, t, 'timeout', events, counting);
          }
          break;
        }
        case 'settle': {
          // 오래 안 돌아온 손: 한 자리에 멈추면 그곳을 새 기준(예: 가드를 내린 채 쉼)으로
          const speed = prev && dt > 0 ? Math.hypot(f.fistIn - prev.fistIn, f.fistV - prev.fistV) / dt : Infinity;
          if (e < X.end) { hand.state = 'idle'; hand.settleFor = 0; }
          else if (speed < X.settleSpeed) {
            hand.settleFor += dt;
            if (hand.settleFor >= X.settleSec) { hand.home = copyFeatures(f); hand.state = 'idle'; hand.settleFor = 0; }
          } else hand.settleFor = 0;
          break;
        }
        default:
          hand.state = 'idle';
      }
    }

    // 손이 다른 자리에서 멈췄는데 펀치 모양이 아니면(가드를 내리거나 올림) 바로 그 자리를 새 기준으로
    rehomeIfStill(hand, t) {
      const X = CONFIG.excursion;
      const S = hand.exc.samples;
      if (S.length < 3 || t - hand.exc.tStart < X.stillSec) return false;
      let lo = Infinity, hi = -Infinity, n = 0, first = t;
      for (let i = S.length - 1; i >= 0 && t - S[i].t <= X.stillSec; i--) {
        lo = Math.min(lo, S[i].e); hi = Math.max(hi, S[i].e); n++; first = S[i].t;
      }
      if (n < 3 || t - first < X.stillSec * 0.8 || hi - lo > X.stillRange) return false;
      if (classifyExcursion(hand.exc).kind !== 'none') return false;   // 뻗은 채 멈춘 펀치는 기다림
      const recent = [];
      for (let i = S.length - 1; i >= 0 && t - S[i].t <= X.stillSec; i--) recent.push(S[i].f);
      hand.home = medianFeatures(recent);
      hand.exc = null;
      hand.state = 'idle';
      hand.lastTrail = null;
      hand.trail = [];
      return true;
    }

    openExcursion(hand, f, t, e) {
      const other = this.hands[SIDES[hand.side].other];
      hand.trail = [f.fist];
      return {
        tStart: t, samples: [{ t, f, e, d: displacement(f, hand.home), blade: this.currentBlade }], peakE: e, peakT: t, peakFist: f.fist, troughE: e, troughT: t, returnT: null,
        peakD: displacement(f, hand.home), peakDT: t,
        home: { ...hand.home },
        otherHomeV: other.home ? other.home.fistV : NaN, otherMinV: Infinity, otherN: 0,
        bladeHome: this.bladeHome,
      };
    }

    addSample(hand, f, t, e) {
      const exc = hand.exc;
      if (exc.samples.length < 120) exc.samples.push({ t, f, e, d: displacement(f, exc.home), blade: this.currentBlade });
      if (hand.trail.length < 40) hand.trail.push(f.fist);
    }

    closeExcursion(hand, tEnd, reason, events, counting) {
      const exc = hand.exc;
      hand.exc = null;
      hand.state = reason === 'timeout' ? 'settle' : 'idle';
      hand.settleFor = 0;
      const trail = hand.trail;
      hand.trail = [];
      if (!exc) return;
      const cls = classifyExcursion(exc);
      if (this.onExcursion) this.onExcursion({ side: hand.side, reason, cls, tStart: exc.tStart, tEnd, peakT: exc.peakT, peakE: exc.peakE, n: exc.samples.length });
      if (cls.kind === 'none') return;
      hand.lastTrail = { points: trail, at: tEnd };   // 펀치로 판정된 것만 궤적을 남김

      const G = CONFIG.guard;
      const otherLimit = Math.min(G.lowV, Number.isFinite(exc.otherHomeV) ? exc.otherHomeV - G.dropMargin : G.lowV);
      const guardDrop = exc.otherN > 0 ? exc.otherMinV < otherLimit : null;
      let returnSec = null, slow = null;
      // 어퍼컷은 아래로 내렸다 올리는 동작이 섞여서 회수 시간을 재지 않음
      if (cls.kind !== 'uppercut') {
        if (reason === 'end' && exc.returnT !== null) { returnSec = Math.max(0, exc.returnT - exc.peakDT); slow = returnSec > CONFIG.returnSlowSec; }
        else if (reason === 'timeout') { returnSec = tEnd - exc.peakT; slow = true; }
      }
      const role = this.roleOf(hand.side);
      let rotation = null, noRotation = null;
      if (cls.kind === 'straight' && role === 'rear' && Number.isFinite(exc.bladeHome)) {
        let sum = 0, n = 0;
        for (const smp of exc.samples) if (Number.isFinite(smp.blade) && Math.abs(smp.t - exc.peakT) <= 0.1) { sum += smp.blade; n++; }
        if (n) {
          rotation = exc.bladeHome - sum / n;
          noRotation = rotation < CONFIG.rotationMin;
        }
      }
      const punch = {
        side: hand.side, kind: cls.kind, t: exc.peakT, tStart: exc.tStart, tEnd,
        peakFist: exc.peakFist, guardDrop, returnSec, slow, rotation, noRotation,
        round: this.round ? this.round.index : null, counted: counting, cls,
      };
      events.push({ type: 'punch', punch });
      if (!counting) return;

      this.punches.push(punch);
      this.addToCombo(punch, events);
      // 한 번은 우연일 수 있어서, 최근 몇 번 중 두 번 이상일 때만 말로 알려 줌
      if (guardDrop !== null) {
        if (guardDrop && countTrue(this.recent.otherDrop.slice(-3)) >= 1) {
          this.maybeCue('otherHandDrop', tEnd, events, { role: role === 'lead' ? 'rear' : 'lead' });
        }
        pushRecent(this.recent.otherDrop, guardDrop);
      }
      if (slow !== null) {
        if (slow && countTrue(this.recent.slow.slice(-3)) >= 1) this.maybeCue('slowReturn', tEnd, events);
        pushRecent(this.recent.slow, slow);
      }
      if (noRotation !== null) {
        if (noRotation && countTrue(this.recent.noRotation.slice(-3)) >= 1) this.maybeCue('noRotation', tEnd, events);
        pushRecent(this.recent.noRotation, noRotation);
      }
    }

    addToCombo(punch, events) {
      const num = PUNCH_TYPES[this.typeOf(punch)].num;
      if (this.combo && punch.t - this.combo.lastT <= CONFIG.comboGapSec) {
        this.combo.nums.push(num);
        this.combo.lastT = punch.t;
      } else {
        if (this.combo) this.closeCombo(events);
        this.combo = { nums: [num], lastT: punch.t };
      }
    }

    closeCombo(events) {
      const c = this.combo;
      this.combo = null;
      if (c && c.nums.length >= 2) events.push({ type: 'combo', nums: c.nums.slice() });
    }

    checkPosture(frame, body, feats, t, dt, events, counting) {
      const P = frame.px, Wd = frame.world;
      const G = CONFIG.guard, SU = CONFIG.sustain;
      // 가드 높이: 쉬는 손 주먹이 턱 높이(어깨선 + 몸통의 6%) 아래면 '내려감'. 팔꿈치는 어깨 바깥으로 나가면 '벌어짐'
      const idle = {}, flare = {};
      for (const side of ['L', 'R']) {
        const h = this.hands[side];
        idle[side] = h.state === 'idle' && Boolean(h.home) && feats[side].vis >= MIN_VIS;
        this.live.guardLow[side] = idle[side] && feats[side].fistV < G.lowV;
        flare[side] = idle[side] && feats[side].elbowOut > CONFIG.elbowFlareOut;
      }
      if (!counting) return;
      this.addTime('time', dt);
      for (const side of ['L', 'R']) {
        if (!idle[side]) continue;
        this.addTime('idleTime', dt);
        if (this.live.guardLow[side]) this.addTime('guardLowTime', dt);
        this.addTime('flareBase', dt);
        if (flare[side]) this.addTime('flareTime', dt);
      }
      for (const side of ['L', 'R']) {
        if (this.sustain(`guardLow${side}`, this.live.guardLow[side], dt, SU.guardLow)) {
          const otherLow = this.live.guardLow[SIDES[side].other];
          this.maybeCue('guardLow', t, events, { role: otherLow ? 'both' : this.roleOf(side) });
        }
        if (this.sustain(`elbowFlare${side}`, flare[side], dt, SU.elbowFlare)) this.maybeCue('elbowFlare', t, events);
      }

      // 턱: 코가 귀 높이보다 위면 들린 것(3D가 있으면 원근 영향이 적은 3D로)
      const nose = P[LM.NOSE], le = P[LM.L_EAR], re = P[LM.R_EAR];
      let chinUp = null;
      if (nose.v >= MIN_VIS && le.v >= MIN_VIS && re.v >= MIN_VIS) {
        let ratio = NaN;
        if (Wd && !frame.worldSynthetic) {
          const earDist = distance3(Wd[LM.L_EAR], Wd[LM.R_EAR]);
          if (earDist > 0.05) ratio = (Wd[LM.NOSE].y - (Wd[LM.L_EAR].y + Wd[LM.R_EAR].y) / 2) / earDist;
        } else {
          const earDist = distance(le, re);
          if (earDist > body.shoulderW * 0.25) ratio = (nose.y - (le.y + re.y) / 2) / earDist;
        }
        if (Number.isFinite(ratio)) chinUp = ratio < CONFIG.chinUpMax;
      }
      this.live.chinUp = chinUp === true;
      if (chinUp !== null) {
        this.addTime('chinBase', dt);
        if (chinUp) this.addTime('chinUpTime', dt);
      }
      if (this.sustain('chinUp', chinUp === true, dt, SU.chinUp)) this.maybeCue('chinUp', t, events);

      // 무릎(3D 각도, 참고용)
      const legOk = Wd && !frame.worldSynthetic && [LM.L_HIP, LM.R_HIP, LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE].every((i) => P[i].v >= MIN_VIS);
      if (legOk) {
        const kl = angleAtDeg(Wd[LM.L_HIP], Wd[LM.L_KNEE], Wd[LM.L_ANKLE]);
        const kr = angleAtDeg(Wd[LM.R_HIP], Wd[LM.R_KNEE], Wd[LM.R_ANKLE]);
        const stiff = kl > CONFIG.kneeStraightDeg && kr > CONFIG.kneeStraightDeg;
        this.addTime('kneeBase', dt);
        if (stiff) this.addTime('kneeStiffTime', dt);
        if (this.sustain('stiffKnees', stiff, dt, SU.stiffKnees)) this.maybeCue('stiffKnees', t, events);
      }

      // 스탠스 폭: 정면에서 본 두 발목의 좌우 간격 / 몸통 길이
      if (frame.feetVisible) {
        const ratio = Math.abs(P[LM.L_ANKLE].x - P[LM.R_ANKLE].x) / body.torso;
        const narrow = ratio < CONFIG.stance.narrow, wide = ratio > CONFIG.stance.wide;
        this.addTime('stanceBase', dt);
        if (narrow) this.addTime('narrowTime', dt);
        if (wide) this.addTime('wideTime', dt);
        this.session.stanceRatioSum += ratio;
        this.session.stanceRatioN++;
        if (this.sustain('narrowStance', narrow, dt, SU.narrowStance)) this.maybeCue('narrowStance', t, events);
        if (this.sustain('wideStance', wide, dt, SU.wideStance)) this.maybeCue('wideStance', t, events);
      }
    }

    // 설정한 스탠스와 몸이 반대로 서 있는 것 같으면 한 번만 알려 줌(어깨·발 중 카메라에 가까운 쪽 = 앞손 쪽)
    updateStanceHint(frame, t, events) {
      if (this.stanceHinted) return;
      const Wd = frame.world, P = frame.px;
      if (!Wd || frame.worldSynthetic) return;
      if (this.hands.L.state !== 'idle' || this.hands.R.state !== 'idle') return;
      const sh = this.depthSign * (Wd[LM.R_SHOULDER].z - Wd[LM.L_SHOULDER].z);
      let score = clamp(sh / 0.08, -1, 1), weight = 1;
      if (frame.feetVisible) {
        const ft = this.depthSign * (Wd[LM.R_ANKLE].z - Wd[LM.L_ANKLE].z);
        score += 1.5 * clamp(ft / 0.15, -1, 1);
        weight += 1.5;
      }
      this.stanceEvidence.push({ t, s: score / weight });
      const buf = this.stanceEvidence;
      if (buf.length < 45) return;
      const first = buf.get(0);
      if (t - first.t < 4) return;
      let sum = 0, n = 0;
      for (let i = 0; i < buf.length; i++) {
        const item = buf.get(i);
        if (t - item.t <= 8) { sum += item.s; n++; }
      }
      const m = n ? sum / n : 0;   // +: 왼쪽이 앞(오소독스)
      const looksLeftLead = m > 0.45, looksRightLead = m < -0.45;
      if ((this.leadSide === 'L' && looksRightLead) || (this.leadSide === 'R' && looksLeftLead)) {
        this.stanceHinted = true;
        events.push({ type: 'stanceHint', suggested: looksRightLead ? 'southpaw' : 'orthodox' });
      }
    }

    computeIssues(stats, punches) {
      const rate = (n, base) => (base > 0 ? n / base : 0);
      const evalOf = (key) => punches.filter((p) => p[key] !== null && p[key] !== undefined);
      const drops = evalOf('guardDrop'), slows = evalOf('slow'), rots = evalOf('noRotation');
      const list = [
        { key: 'otherHandDrop', count: drops.filter((p) => p.guardDrop).length, base: drops.length, minBase: 4 },
        { key: 'slowReturn', count: slows.filter((p) => p.slow).length, base: slows.length, minBase: 4 },
        { key: 'noRotation', count: rots.filter((p) => p.noRotation).length, base: rots.length, minBase: 3 },
        { key: 'guardLow', time: stats.guardLowTime, baseTime: stats.idleTime, minBase: 3 },
        { key: 'elbowFlare', time: stats.flareTime, baseTime: stats.flareBase, minBase: 3 },
        { key: 'chinUp', time: stats.chinUpTime, baseTime: stats.chinBase, minBase: 3 },
        { key: 'stiffKnees', time: stats.kneeStiffTime, baseTime: stats.kneeBase, minBase: 5 },
        { key: 'narrowStance', time: stats.narrowTime, baseTime: stats.stanceBase, minBase: 4 },
        { key: 'wideStance', time: stats.wideTime, baseTime: stats.stanceBase, minBase: 4 },
      ];
      const out = [];
      for (const item of list) {
        const isTime = 'time' in item;
        const base = isTime ? item.baseTime : item.base;
        if (base < item.minBase) continue;   // 판단할 만큼 데이터가 없으면 빼기
        const r = isTime ? rate(item.time, item.baseTime) : rate(item.count, item.base);
        out.push({
          key: item.key, rate: r, score: r * ISSUES[item.key].weight,
          count: isTime ? null : item.count, base: isTime ? null : item.base,
          seconds: isTime ? item.time : null, baseSeconds: isTime ? item.baseTime : null,
        });
      }
      return out.sort((a, b) => b.score - a.score);
    }

    // 끝난 기록에서 콤비네이션을 다시 계산(스탠스를 나중에 바꿔도 번호가 맞게)
    comboStats(punches) {
      const sorted = punches.slice().sort((a, b) => a.t - b.t);
      const counts = new Map();
      let seq = [], lastT = -Infinity, comboPunches = 0;
      const flush = () => {
        if (seq.length >= 2) {
          const key = seq.join('-');
          counts.set(key, (counts.get(key) || 0) + 1);
          comboPunches += seq.length;
        }
        seq = [];
      };
      for (const p of sorted) {
        if (p.t - lastT > CONFIG.comboGapSec || (p.round !== null && seq.length && p.round !== seq.round)) flush();
        seq.push(PUNCH_TYPES[this.typeOf(p)].num);
        seq.round = p.round;
        lastT = p.t;
      }
      flush();
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 3)
        .map(([key, count]) => ({ key, count }));
      return { top, comboShare: punches.length ? comboPunches / punches.length : 0 };
    }

    summary() {
      const punches = this.punches;
      const S = this.session;
      const counts = this.countTypes(punches);
      const issues = this.computeIssues(S, punches);
      const returns = punches.map((p) => p.returnSec).filter((v) => Number.isFinite(v) && v < CONFIG.excursion.maxDurSec);
      const drops = punches.filter((p) => p.guardDrop !== null);
      const stanceRatio = S.stanceRatioN ? S.stanceRatioSum / S.stanceRatioN : null;
      const minutes = S.time / 60;
      return {
        total: punches.length,
        counts,
        perMinute: minutes > 0.1 ? punches.length / minutes : null,
        activeSeconds: S.time,
        rounds: this.rounds.slice(),
        guardUp: S.idleTime > 2 ? 1 - S.guardLowTime / S.idleTime : null,
        otherHandUp: drops.length >= 3 ? drops.filter((p) => !p.guardDrop).length / drops.length : null,
        avgReturn: returns.length >= 3 ? meanOf(returns) : null,
        chinUpRate: S.chinBase > 3 ? S.chinUpTime / S.chinBase : null,
        stanceRatio,
        kneeStiffRate: S.kneeBase > 5 ? S.kneeStiffTime / S.kneeBase : null,
        combos: this.comboStats(punches),
        issues,
        view: this.view,
        stance: this.stance,
      };
    }
  }

  // ===== 라운드 타이머: 준비 → 라운드 → 휴식 → … → 끝 =====
  class RoundTimer {
    constructor(config) { this.configure(config); this.reset(); }
    configure({ roundSec = 180, restSec = 60, rounds = 3, readySec = 10 } = {}) {
      this.roundSec = Math.max(5, roundSec);
      this.restSec = Math.max(0, restSec);
      this.rounds = Math.max(1, Math.round(rounds));
      this.readySec = Math.max(0, readySec);
    }
    reset() { this.phase = 'idle'; this.round = 0; this.phaseStart = 0; this.pausedAt = null; this.warned = false; this.lastWhole = null; }
    duration(phase = this.phase) {
      if (phase === 'ready') return this.readySec;
      if (phase === 'round') return this.roundSec;
      if (phase === 'rest') return this.restSec;
      return Infinity;
    }
    enter(phase, t, events) {
      this.phase = phase;
      this.phaseStart = t;
      this.warned = false;
      this.lastWhole = null;
      events.push({ type: 'phase', phase, round: this.round });
    }
    start(t) {
      const events = [];
      this.reset();
      if (this.readySec > 0) this.enter('ready', t, events);
      else { this.round = 1; this.enter('round', t, events); }
      return events;
    }
    get paused() { return this.pausedAt !== null; }
    pause(t) { if (this.pausedAt === null && this.isActive()) this.pausedAt = t; }
    resume(t) { if (this.pausedAt !== null) { this.phaseStart += t - this.pausedAt; this.pausedAt = null; } }
    isActive() { return this.phase === 'ready' || this.phase === 'round' || this.phase === 'rest'; }
    elapsed(t) { return (this.pausedAt ?? t) - this.phaseStart; }
    remaining(t) { return Math.max(0, this.duration() - this.elapsed(t)); }
    progress(t) { const d = this.duration(); return Number.isFinite(d) && d > 0 ? clamp(this.elapsed(t) / d, 0, 1) : 0; }
    update(t) {
      const events = [];
      if (this.pausedAt !== null || !this.isActive()) return events;
      for (let guard = 0; guard < 6; guard++) {
        const rem = this.duration() - (t - this.phaseStart);
        if (this.phase === 'round' && !this.warned && this.roundSec > 20 && rem <= 10 && rem > 0) {
          this.warned = true;
          events.push({ type: 'warn10', round: this.round });
        }
        if ((this.phase === 'ready' || this.phase === 'rest') && rem > 0 && rem <= 3) {
          const whole = Math.ceil(rem);
          if (whole !== this.lastWhole) { this.lastWhole = whole; events.push({ type: 'count', n: whole }); }
        }
        if (rem > 0) break;
        const endAt = this.phaseStart + this.duration();
        if (this.phase === 'ready' || this.phase === 'rest') {
          this.round++;
          this.enter('round', endAt, events);
        } else {
          events.push({ type: 'roundEnd', round: this.round });
          if (this.round >= this.rounds) {
            this.phase = 'done';
            events.push({ type: 'done' });
            break;
          }
          if (this.restSec > 0) this.enter('rest', endAt, events);
          else { this.round++; this.enter('round', endAt, events); }
        }
      }
      return events;
    }
  }

  // ===== 합성 섀도복서(데모 화면 + 테스트용 정답 데이터) =====
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gaussian(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const v3 = (x, y, z) => ({ x, y, z });
  const add3 = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
  const sub3 = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
  const mul3 = (a, k) => v3(a.x * k, a.y * k, a.z * k);
  const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const len3 = (a) => Math.hypot(a.x, a.y, a.z);
  const lerp3 = (a, b, k) => v3(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
  const unit3 = (a) => { const n = len3(a); return n > 1e-9 ? mul3(a, 1 / n) : v3(0, 1, 0); };
  const cross3 = (a, b) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  function yawRot(p, phi) { const c = Math.cos(phi), s = Math.sin(phi); return v3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c); }
  function pitchRot(p, th) { const c = Math.cos(th), s = Math.sin(th); return v3(p.x, p.y * c - p.z * s, p.y * s + p.z * c); }
  const minJerk = (u) => { const k = clamp(u, 0, 1); return k * k * k * (10 - 15 * k + 6 * k * k); };
  function bezier3(a, c, b, k) { const m = 1 - k; return v3(m * m * a.x + 2 * m * k * c.x + k * k * b.x, m * m * a.y + 2 * m * k * c.y + k * k * b.y, m * m * a.z + 2 * m * k * c.z + k * k * b.z); }

  // 두 마디 팔·다리 역운동학: 어깨(엉덩이)·목표점·팔꿈치(무릎) 방향 힌트 → 팔꿈치 위치
  function solveTwoBone(S, target, pole, a, b) {
    let d = sub3(target, S);
    let L = len3(d);
    const maxL = (a + b) * 0.999, minL = Math.abs(a - b) + 0.01;
    if (L < 1e-6) { d = v3(0, 0, -1); L = minL; }
    const dir = mul3(d, 1 / L);
    L = clamp(L, minL, maxL);
    const along = (a * a - b * b + L * L) / (2 * L);
    const h = Math.sqrt(Math.max(0, a * a - along * along));
    let p = sub3(pole, mul3(dir, dot3(pole, dir)));
    if (len3(p) < 1e-6) p = cross3(dir, v3(1, 0, 0));
    p = unit3(p);
    return { E: add3(S, add3(mul3(dir, along), mul3(p, h))), W: add3(S, mul3(dir, L)) };
  }

  const COMBO_LIBRARY = [[1], [1], [1, 1], [1, 2], [1, 2], [1, 2, 3], [1, 1, 2], [2, 3, 2], [1, 2, 5, 2], [3, 2], [1, 6, 3, 2], [1, 2, 3, 4], [5, 2], [1, 4], [6, 3]];
  const NUM_SPEC = { 1: ['lead', 'straight'], 2: ['rear', 'straight'], 3: ['lead', 'hook'], 4: ['rear', 'hook'], 5: ['lead', 'uppercut'], 6: ['rear', 'uppercut'] };
  const TIMING = {
    straight: { dip: 0, ext: 0.13, hold: 0.03, ret: 0.15 },
    hook: { dip: 0, ext: 0.18, hold: 0.03, ret: 0.19 },
    uppercut: { dip: 0.1, ext: 0.15, hold: 0.03, ret: 0.19 },
  };
  const YAW_DELTA = { 1: 6, 2: -46, 3: 16, 4: -38, 5: 8, 6: -28 };   // 도, 오소독스 기준(+ = 왼어깨가 카메라 쪽)

  function createShadowboxSimulation(options = {}) {
    const rng = mulberry32(options.seed || 11);
    const stance = options.stance === 'southpaw' ? 'southpaw' : 'orthodox';
    const lead = stance === 'orthodox' ? 'L' : 'R';
    const rear = lead === 'L' ? 'R' : 'L';
    const sx = (side) => (side === 'L' ? 1 : -1);   // 카메라를 마주 보면 사람의 왼쪽 = 화면 오른쪽(+x)
    const flip = sx(lead);
    const W = options.width || 720, H = options.height || 960;
    const dim = { upper: 0.29, fore: 0.26, shoulderHalf: 0.18, hipHalf: 0.105, torso: 0.5, thigh: 0.43, shin: 0.42, ankleH: 0.08 };
    const cam = { height: 1.05, z: -2.8, f: (options.focalRatio || 1.22) * H, cx: W / 2, cy: H * (options.cyRatio || 0.47) };
    const noise = options.noise || null;
    const rates = { otherDrop: 0.22, slow: 0.16, noRotation: 0.35, ...(options.mistakes || {}) };
    const periods = (options.periods || []).map((p) => ({ ...p }));
    const combos = options.combos || COMBO_LIBRARY;
    const yaw0 = flip * 28 * DEG;
    const depthScale = options.depthScale ?? 1;
    const zSign = options.flipZ ? -1 : 1;

    const st = {
      t: 0, mode: options.mode || 'fight', restW: options.mode === 'rest' ? 1 : 0,
      nextComboAt: options.firstComboAt ?? 1.2,
      queue: [], active: { L: null, R: null }, drops: [], lastTarget: { L: null, R: null },
      swayPhase: rng() * 10, walkPhase: rng() * 10,
    };
    const truth = { punches: [], periods };

    function ramp(t, t0, t1, edge) {
      if (t <= t0 || t >= t1) return 0;
      return Math.min(1, (t - t0) / edge, (t1 - t) / edge);
    }
    function periodWeight(issue, t) {
      let w = 0;
      for (const p of periods) if (p.issue === issue) w = Math.max(w, ramp(t, p.t0, p.t1, 0.25));
      return w;
    }
    function dropWeight(side, t) {
      let w = 0;
      for (const d of st.drops) if (d.side === side) w = Math.max(w, Math.min(ramp(t, d.t0, d.t1 + 0.1, 0.06), 1));
      return w;
    }

    function schedule(t) {
      const combo = combos[Math.floor(rng() * combos.length)];
      let prev = null;
      for (const num of combo) {
        const [role, kind] = NUM_SPEC[num];
        const T = { ...TIMING[kind] };
        T.ext *= 0.9 + rng() * 0.2;
        const slow = rng() < rates.slow;
        if (slow) T.ret = 0.5 + rng() * 0.12;
        let start = t;
        if (prev) {
          start = prev.role === role
            ? prev.start + prev.T.dip + prev.T.ext + prev.T.hold + prev.T.ret * 0.7
            : prev.start + prev.T.dip + prev.T.ext + prev.T.hold * 0.5 + 0.02 + rng() * 0.05;
        }
        const item = { num, role, kind, T, start, slow, otherDrop: rng() < rates.otherDrop, noRotation: num === 2 && rng() < rates.noRotation };
        st.queue.push(item);
        prev = item;
      }
      const end = prev.start + prev.T.dip + prev.T.ext + prev.T.hold + prev.T.ret;
      st.nextComboAt = end + 0.6 + rng() * 1.3;
    }

    function shoulderCenter(t) {
      const sway = 0.04 * Math.sin(t * 0.9 + st.swayPhase) + 0.015 * Math.sin(t * 2.3);
      return v3(sway, -dim.torso, -0.07);
    }
    function currentYaw(t) {
      let yaw = yaw0;
      for (const side of ['L', 'R']) {
        const a = st.active[side];
        if (a) yaw += a.yawDelta * punchProfile(a, t);
      }
      return yaw;
    }
    function punchProfile(a, t) {
      const u = t - a.tStart, T = a.T;
      if (u < T.dip) return 0;
      if (u < T.dip + T.ext) return minJerk((u - T.dip) / T.ext);
      if (u < T.dip + T.ext + T.hold) return 1;
      return 1 - minJerk((u - T.dip - T.ext - T.hold) / T.ret);
    }

    // 가드: 몸통을 돌려도 주먹은 얼굴 앞(앞손은 앞쪽 볼, 뒷손은 턱 옆)
    function headCenter(SC) { return add3(SC, v3(SC.x * 0.6, -0.255, -0.035)); }
    function guardWorld(side, t, SC) {
      const isLead = side === lead;
      const HC = headCenter(SC);
      let p = isLead ? v3(sx(side) * 0.07, 0.13, -0.2) : v3(sx(side) * 0.06, 0.16, -0.11);
      const low = Math.max(periodWeight('guardLow', t), st.restW * 1.4);
      if (low > 0) p = add3(p, v3(sx(side) * 0.03 * low, 0.17 * low, 0.03 * low));
      const drop = dropWeight(side, t);
      if (drop > 0) p = add3(p, v3(sx(side) * 0.03 * drop, 0.19 * drop, 0.05 * drop));
      const ph = isLead ? 0 : 2;
      p = add3(p, v3(0.006 * Math.sin(t * 3.1 + ph), 0.008 * Math.sin(t * 2.3 + ph), 0.006 * Math.sin(t * 1.7 + ph)));
      return add3(HC, p);
    }
    function guardPole(side, yaw, t) {
      const flare = periodWeight('elbowFlare', t);
      return yawRot(v3(sx(side) * lerp(0.35, 1.8, flare), lerp(1, 0.5, flare), 0.15), yaw * 0.5);
    }

    function startPunch(item, t) {
      const side = item.role === 'lead' ? lead : rear;
      if (st.active[side]) return;   // 이미 그 손이 나가 있으면 건너뜀
      const yawDelta = (item.noRotation ? -10 : YAW_DELTA[item.num]) * flip * DEG;
      const SC = shoulderCenter(t);
      const yawPk = yaw0 + yawDelta;
      const Spk = add3(SC, yawRot(v3(sx(side) * dim.shoulderHalf, 0, 0), yawPk));
      const from = st.lastTarget[side] || guardWorld(side, t, SC);
      const reachMax = dim.upper + dim.fore;
      const a = { side, kind: item.kind, num: item.num, tStart: t, T: item.T, from, yawDelta, peak: null, ctrl: null, dipPt: null, pole: null };
      if (item.kind === 'straight') {
        const target = v3(SC.x * 0.5, SC.y - 0.06, -1.6);
        a.peak = add3(Spk, mul3(unit3(sub3(target, Spk)), reachMax * (item.role === 'lead' ? 0.975 : 0.985)));
        a.pole = yawRot(v3(sx(side) * 0.7, 1, 0.1), yawPk);
      } else if (item.kind === 'hook') {
        a.peak = v3(SC.x - sx(side) * 0.05, Spk.y - 0.03, Spk.z - 0.33);
        a.ctrl = add3(from, v3(sx(side) * 0.13, -0.05, -0.1));
        a.pole = yawRot(v3(sx(side) * 1.0, -0.3, 0.25), yawPk);
      } else {
        a.dipPt = add3(from, v3(-sx(side) * 0.02, 0.17, -0.02));
        a.peak = v3(SC.x + sx(side) * 0.03, Spk.y - 0.07, Spk.z - 0.3);
        a.pole = yawRot(v3(sx(side) * 0.25, 1, 0.45), yawPk);
      }
      a.total = a.T.dip + a.T.ext + a.T.hold + a.T.ret;
      st.active[side] = a;
      const other = side === 'L' ? 'R' : 'L';
      if (item.otherDrop) st.drops.push({ side: other, t0: t + 0.01, t1: t + a.T.dip + a.T.ext + a.T.hold + a.T.ret * 0.6 });
      truth.punches.push({
        side, role: item.role, kind: item.kind, num: item.num,
        tStart: t, tPeak: t + a.T.dip + a.T.ext + a.T.hold * 0.5, tEnd: t + a.total,
        otherDrop: item.otherDrop, slow: item.slow, noRotation: item.num === 2 ? item.noRotation : null,
      });
    }

    function advance(t, dt) {
      st.restW = clamp(st.restW + (st.mode === 'rest' ? 1 : -1) * dt * 2.5, 0, 1);
      if (st.mode === 'fight' && !st.queue.length && t >= st.nextComboAt && !st.active.L && !st.active.R) schedule(t);
      while (st.queue.length && st.queue[0].start <= t) startPunch(st.queue.shift(), t);
      for (const side of ['L', 'R']) {
        const a = st.active[side];
        if (a && t - a.tStart >= a.total) st.active[side] = null;
      }
      st.drops = st.drops.filter((d) => d.t1 + 0.2 > t);
    }

    function armTarget(side, t, yaw, SC) {
      const guardW = guardWorld(side, t, SC);
      const poleG = guardPole(side, yaw, t);
      const a = st.active[side];
      if (!a) return { target: guardW, pole: poleG };
      const u = t - a.tStart, T = a.T;
      if (a.kind === 'uppercut' && u < T.dip) {
        const k = minJerk(u / T.dip);
        return { target: lerp3(a.from, a.dipPt, k), pole: unit3(lerp3(poleG, a.pole, k)) };
      }
      const u2 = u - T.dip;
      const startPt = a.kind === 'uppercut' ? a.dipPt : a.from;
      if (u2 < T.ext) {
        const k = minJerk(u2 / T.ext);
        const p = a.kind === 'hook' ? bezier3(startPt, a.ctrl, a.peak, k) : lerp3(startPt, a.peak, k);
        return { target: p, pole: unit3(lerp3(poleG, a.pole, Math.min(1, k * 1.5))) };
      }
      if (u2 < T.ext + T.hold) return { target: a.peak, pole: a.pole };
      const k = minJerk((u2 - T.ext - T.hold) / T.ret);
      return { target: lerp3(a.peak, guardW, k), pole: unit3(lerp3(a.pole, poleG, k)) };
    }

    // 33개 관절의 3D 좌표(엉덩이 중심, x 화면 오른쪽, y 아래, z 카메라 반대쪽)
    function skeleton(t) {
      const pts = new Array(33);
      const yaw = currentYaw(t);
      const SC = shoulderCenter(t);
      const bob = 0.012 * Math.sin(t * 2 * Math.PI * 1.8);
      const stiff = periodWeight('stiffKnees', t);
      const hipHeight = lerp(0.865, 0.897, stiff) + bob;
      const S = { L: add3(SC, yawRot(v3(dim.shoulderHalf, 0, 0), yaw)), R: add3(SC, yawRot(v3(-dim.shoulderHalf, 0, 0), yaw)) };
      pts[LM.L_SHOULDER] = S.L;
      pts[LM.R_SHOULDER] = S.R;
      for (const side of ['L', 'R']) {
        const Sd = SIDES[side];
        const { target, pole } = armTarget(side, t, yaw, SC);
        st.lastTarget[side] = target;
        const { E, W: Wr } = solveTwoBone(S[side], target, pole, dim.upper, dim.fore);
        const u = unit3(sub3(Wr, E));
        const q = unit3(cross3(u, v3(0, -1, 0)));
        pts[Sd.elbow] = E;
        pts[Sd.wrist] = Wr;
        pts[Sd.index] = add3(Wr, add3(mul3(u, 0.085), mul3(q, 0.02)));
        pts[Sd.pinky] = add3(Wr, add3(mul3(u, 0.075), mul3(q, -0.03)));
        pts[Sd.thumb] = add3(Wr, add3(mul3(u, 0.045), mul3(q, 0.035)));
      }
      // 머리: 몸을 돌려도 얼굴은 상대(카메라)를 봄. 턱 당김 +12°, 들림 −14°
      const HC = headCenter(SC);
      const headYaw = yaw * 0.25;
      const pitch = lerp(12, -14, periodWeight('chinUp', t)) * DEG;
      const head = (x, y, z) => add3(HC, yawRot(pitchRot(v3(x, y, z), pitch), headYaw));
      pts[0] = head(0, 0.02, -0.1);
      pts[1] = head(0.016, -0.012, -0.088); pts[2] = head(0.032, -0.012, -0.083); pts[3] = head(0.047, -0.011, -0.074);
      pts[4] = head(-0.016, -0.012, -0.088); pts[5] = head(-0.032, -0.012, -0.083); pts[6] = head(-0.047, -0.011, -0.074);
      pts[7] = head(0.075, 0.005, 0); pts[8] = head(-0.075, 0.005, 0);
      pts[9] = head(0.025, 0.05, -0.088); pts[10] = head(-0.025, 0.05, -0.088);
      // 다리: 앞발은 카메라 쪽, 뒷발은 뒤. 좌우 간격 0.30m(일직선·넓은 스탠스 실수 포함)
      const hipYaw = yaw * 0.6;
      const hips = { L: yawRot(v3(dim.hipHalf, 0, 0), hipYaw), R: yawRot(v3(-dim.hipHalf, 0, 0), hipYaw) };
      pts[LM.L_HIP] = hips.L;
      pts[LM.R_HIP] = hips.R;
      const halfWidth = lerp(lerp(0.15, 0.03, periodWeight('narrowStance', t)), 0.36, periodWeight('wideStance', t));
      for (const side of ['L', 'R']) {
        const Sd = SIDES[side];
        const isLead = side === lead;
        const ankle = v3(sx(side) * halfWidth, hipHeight - dim.ankleH, isLead ? -0.24 : 0.24);
        const { E: knee } = solveTwoBone(hips[side], ankle, v3(sx(side) * 0.15, 0, -1), dim.thigh, dim.shin);
        pts[Sd.knee] = knee;
        pts[Sd.ankle] = ankle;
        pts[side === 'L' ? LM.L_HEEL : LM.R_HEEL] = add3(ankle, v3(0, 0.05, 0.06));
        pts[side === 'L' ? LM.L_TOE : LM.R_TOE] = add3(ankle, v3(sx(side) * (isLead ? 0.02 : 0.06), 0.07, -0.15));
      }
      return { pts, hipHeight };
    }

    function frame() {
      const t = st.t;
      const { pts, hipHeight } = skeleton(t);
      const bx = 0.12 * Math.sin(t * 0.31 + st.walkPhase), bz = 0.08 * Math.sin(t * 0.23 + st.walkPhase * 1.7);
      const camY = hipHeight - cam.height;   // 엉덩이 기준 카메라 높이(y 아래가 +)
      const zHip = bz - cam.z;
      const landmarks = new Array(33), world = new Array(33);
      for (let i = 0; i < 33; i++) {
        const p = pts[i];
        const zc = p.z + bz - cam.z;
        let u = cam.cx + (cam.f * (p.x + bx)) / zc;
        let v = cam.cy + (cam.f * (p.y - camY)) / zc;
        let vis = 0.97;
        let wx = p.x, wy = p.y, wz = p.z * depthScale;
        if (noise) {
          u += gaussian(rng) * (noise.px || 0) * H;
          v += gaussian(rng) * (noise.px || 0) * H;
          wx += gaussian(rng) * (noise.world || 0);
          wy += gaussian(rng) * (noise.world || 0);
          wz += gaussian(rng) * (noise.worldZ || noise.world || 0);
          if (noise.blur && (i >= 13 && i <= 22) && rng() < noise.blur) vis = 0.25 + rng() * 0.3;
        }
        if (v > H || v < 0 || u < 0 || u > W) vis = Math.min(vis, 0.15);
        landmarks[i] = { x: u / W, y: v / H, z: (p.z * cam.f) / zHip / W, visibility: vis };
        world[i] = { x: wx, y: wy, z: wz * zSign };
      }
      return { landmarks, world, t };
    }

    return {
      stance, width: W, height: H, truth,
      get t() { return st.t; },
      get mode() { return st.mode; },
      setMode(mode) {
        st.mode = mode;
        if (mode === 'fight') { st.nextComboAt = Math.max(st.nextComboAt, st.t + 0.8); }
        else st.queue = [];
      },
      addPeriod(issue, t0, t1) { periods.push({ issue, t0, t1 }); },
      step(dt) {
        st.t += dt;
        advance(st.t, dt);
      },
      frame,
    };
  }

  root.BoxingCore = Object.freeze({
    CONFIG, LM, SIDES, PUNCH_TYPES, PUNCH_ORDER, ISSUES, ISSUE_ORDER,
    RingBuffer, buildPoseFrame, measureBody, handFeatures, excursionScore, classifyExcursion,
    BoxingAnalyzer, RoundTimer, createShadowboxSimulation, typeFor, angleAtDeg, median,
  });
})(typeof window !== 'undefined' ? window : globalThis);
// ==CORE END==
