const { CONFIG, LM, PUNCH_TYPES, PUNCH_ORDER, ISSUES, BoxingAnalyzer, RoundTimer, createShadowboxSimulation, buildPoseFrame } = window.BoxingCore;

// ===== MediaPipe (버전 고정: 갑자기 바뀌어 깨지는 것 방지) =====
const TASKS_VERSION = '0.10.14';
const TASKS_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}`;
const MODEL_URLS = [
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
];
const STORAGE_KEYS = Object.freeze({ settings: 'boxingCoach.settings.v1' });
const READY_SEC = 10;
const DEMO_STEP = 1 / 30;
const DEMO_SIZE = Object.freeze({ w: 720, h: 960 });
const DEMO_TIMER = Object.freeze({ readySec: 3, roundSec: 20, restSec: 6, rounds: 2 });
// 데모에서 일부러 넣는 실수(타임라인: 준비 0~3초, 1라운드 3~23초, 휴식 23~29초, 2라운드 29~49초)
const DEMO_PERIODS = Object.freeze([
  { issue: 'guardLow', t0: 9, t1: 11.8 },
  { issue: 'chinUp', t0: 15, t1: 18.5 },
  { issue: 'elbowFlare', t0: 33, t1: 36.5 },
  { issue: 'narrowStance', t0: 40, t1: 44.5 },
]);
const SKELETON = [
  [11, 12], [11, 23], [12, 24], [23, 24], [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31], [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
];
const POP_MS = 720;
const CUE_MS = 2200;
const RING_CIRCUMFERENCE = 2 * Math.PI * 29;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'), stageMedia: $('stageMedia'), video: $('video'), overlay: $('overlay'), stageEmpty: $('stageEmpty'),
  hud: $('hud'), ring: $('ring'), ringFill: $('ringFill'), timeText: $('timeText'), phaseLabel: $('phaseLabel'),
  punchNum: $('punchNum'), hudMix: $('hudMix'), comboBox: $('comboBox'), comboText: $('comboText'),
  countdown: $('countdown'), cueBanner: $('cueBanner'), loading: $('loading'), loadingText: $('loadingText'),
  tipBar: $('tipBar'), tipText: $('tipText'), idleControls: $('idleControls'), runControls: $('runControls'),
  btnCamera: $('btnCamera'), btnUpload: $('btnUpload'), btnDemo: $('btnDemo'), fileInput: $('fileInput'),
  btnPlay: $('btnPlay'), btnPause: $('btnPause'), btnFlip: $('btnFlip'), btnStop: $('btnStop'),
  settings: $('settings'), settingsSummary: $('settingsSummary'), optSound: $('optSound'), optVoice: $('optVoice'),
  alertBox: $('alertBox'), alertText: $('alertText'), alertAction: $('alertAction'),
  chipPose: $('chipPose'), chipView: $('chipView'), chipStance: $('chipStance'), chipFps: $('chipFps'),
  setsList: $('setsList'), setsMeta: $('setsMeta'), setsBadge: $('setsBadge'), summaryCard: $('summaryCard'), summaryBody: $('summaryBody'),
  btnNewSession: $('btnNewSession'),
};

// localStorage는 막혀 있을 수 있으니 실패해도 앱은 그대로 동작
const storage = {
  read(key) { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; } },
  write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장 불가 환경 무시 */ } },
};

function loadSettings() {
  const saved = storage.read(STORAGE_KEYS.settings) || {};
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  return {
    stance: pick(saved.stance, ['orthodox', 'southpaw'], 'orthodox'),
    roundSec: pick(Number(saved.roundSec), [60, 120, 180], 180),
    restSec: pick(Number(saved.restSec), [30, 60], 60),
    rounds: pick(Number(saved.rounds), [1, 3, 6], 3),
    sound: saved.sound !== false,
    voice: saved.voice !== false,
  };
}

class UserFacingError extends Error {}

const settings = loadSettings();
const app = {
  mode: 'idle',                // idle | camera | file | demo
  uiState: 'idle',             // idle | ready | running | finished
  facing: 'user',              // 섀도복싱은 화면을 보면서 하니까 셀카 카메라가 기본
  mirrored: false,
  stream: null, fileUrl: null,
  visionApi: null, fileset: null, pose: null, poseLoading: null, poseDelegate: null,
  running: false, loopHandle: null, loopKind: null,
  videoW: 0, videoH: 0,
  demo: null, demoT: 0, demoAccum: 0, demoLastNow: 0,
  lastMediaTime: -1, lastDetectTs: 0,
  analyzer: new BoxingAnalyzer({ stance: settings.stance }),
  timer: new RoundTimer({ roundSec: settings.roundSec, restSec: settings.restSec, rounds: settings.rounds, readySec: READY_SEC }),
  overlayCtx: els.overlay.getContext('2d'), dpr: 1, colors: null,
  lastFrame: null, pops: [], cue: null, comboUntil: 0, comboKey: '',
  audio: null, noiseBuffer: null, speechPriority: 0, wakeLock: null,
  fps: { frames: 0, since: 0, value: 0, startedAt: 0, warned: false },
  lastPoseSeenAt: 0, lastTipAt: 0, consecutiveErrors: 0, autoPaused: false,
  shown: {}, countdownShown: null, lastContainerW: 0, fileRoundStarted: false,
};

// ===== 알림·로딩·화면 상태 =====
function showAlert(message, action) {
  els.alertText.textContent = message;
  els.alertBox.hidden = false;
  if (action && action.label) {
    els.alertAction.textContent = action.label;
    els.alertAction.hidden = false;
    els.alertAction.onclick = () => { hideAlert(); action.run(); };
  } else {
    els.alertAction.hidden = true;
    els.alertAction.onclick = null;
  }
}
function hideAlert() { els.alertBox.hidden = true; els.alertAction.onclick = null; }
function setLoading(text) {
  els.loading.hidden = !text;
  if (text) els.loadingText.textContent = text;
  for (const b of [els.btnCamera, els.btnUpload, els.btnDemo, els.btnPlay]) b.disabled = Boolean(text);
}

// idle: 시작 전 | ready: 카메라·영상 열림(시작 대기) | running: 분석 중 | finished: 결과 보기
function setUiState(state) {
  app.uiState = state;
  const isSource = state === 'ready' || state === 'running';
  els.idleControls.hidden = isSource;
  els.runControls.hidden = !isSource;
  els.btnPlay.hidden = state !== 'ready';
  els.btnPlay.textContent = app.mode === 'file' ? '분석 시작' : '라운드 시작';
  els.btnPause.hidden = state !== 'running';
  els.btnFlip.hidden = !(isSource && app.mode === 'camera');
  els.btnStop.textContent = state === 'ready' ? (app.mode === 'camera' ? '카메라 끄기' : '닫기') : '끝내고 결과 보기';
  els.settings.hidden = state === 'running';
  // 영상 분석은 라운드 타이머를 안 쓰므로 스탠스만 고를 수 있게
  for (const input of els.settings.querySelectorAll('input[type="radio"]')) {
    input.disabled = state === 'ready' && app.mode === 'file' && input.name !== 'stance';
  }
  els.stageEmpty.hidden = state !== 'idle';
  els.stageMedia.hidden = state === 'idle';
  els.hud.hidden = state === 'idle';
  els.tipBar.hidden = !isSource;
  if (!isSource) {
    hideCountdown();
    hideCue();
    setStageAlert(false);
    els.comboBox.hidden = true;
  }
  updatePauseButton();
  if (isSource) revealStage();
}

// 결과를 보느라 아래로 내려가 있어도 새 세션이 시작되면 촬영 화면이 보이게
function revealStage() {
  const rect = els.stage.getBoundingClientRect();
  if (rect.top >= 0 && rect.top < window.innerHeight * 0.5) return;
  els.stage.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
}

// ===== 설정 =====
function saveSettings() { storage.write(STORAGE_KEYS.settings, settings); }
const STANCE_LABEL = { orthodox: '오소독스', southpaw: '사우스포' };

function applySettingsToUi() {
  for (const input of els.settings.querySelectorAll('input[type="radio"]')) {
    input.checked = String(settings[input.name]) === input.value;
  }
  els.optSound.checked = settings.sound;
  els.optVoice.checked = settings.voice;
  updateSettingsSummary();
  setChip(els.chipStance, '', STANCE_LABEL[settings.stance]);
}

function updateSettingsSummary() {
  const round = `${settings.roundSec / 60}분`;
  const rest = settings.restSec >= 60 ? `${settings.restSec / 60}분` : `${settings.restSec}초`;
  els.settingsSummary.textContent = `${round} × ${settings.rounds}라운드 · 휴식 ${rest}`;
}

// 스탠스를 바꾸면 이미 센 펀치도 잽/스트레이트 이름이 다시 붙음(기록은 왼손·오른손 기준으로 저장)
function setStance(stance) {
  settings.stance = stance === 'southpaw' ? 'southpaw' : 'orthodox';
  app.analyzer.setStance(settings.stance);
  saveSettings();
  applySettingsToUi();
  app.shown = {};
  updateHud();
  renderSets();
  if (!els.summaryCard.hidden) renderSummary();
}

els.settings.addEventListener('change', (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.type !== 'radio') return;
  if (input.name === 'stance') { setStance(input.value); return; }
  settings[input.name] = Number(input.value);
  saveSettings();
  updateSettingsSummary();
  if (!app.timer.isActive()) {
    app.timer.configure({ roundSec: settings.roundSec, restSec: settings.restSec, rounds: settings.rounds, readySec: READY_SEC });
    app.shown = {};
    updateHud();
  }
});
for (const [el, key] of [[els.optSound, 'sound'], [els.optVoice, 'voice']]) {
  el.addEventListener('change', () => {
    settings[key] = el.checked;
    saveSettings();
    if (key === 'voice' && !el.checked) { try { window.speechSynthesis?.cancel(); } catch { /* 미지원 */ } }
  });
}

// ===== 캔버스 색 =====
function readColors() {
  const css = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const red = pick('--red', '#EE3F45');
  app.colors = {
    red, good: '#7BF0B5', bone: 'rgba(255, 255, 255, 0.82)', joint: '#FFFFFF', muted: 'rgba(160, 170, 195, 0.9)',
    figure: '#DCE3F2', figureDark: '#AFBAD6', skin: '#E9EDF6',
  };
}
readColors();

// ===== 화면 크기 맞추기 =====
function layoutStage() {
  const containerW = els.stage.clientWidth;
  if (!containerW) return;
  const maxH = Math.max(260, Math.round(window.innerHeight * 0.7));
  const aspect = app.videoW && app.videoH ? app.videoW / app.videoH : 3 / 4;
  let w = containerW;
  let h = w / aspect;
  if (h > maxH) { h = maxH; w = h * aspect; }
  els.stageMedia.style.aspectRatio = 'auto';
  els.stageMedia.style.width = `${Math.round(w)}px`;
  els.stageMedia.style.height = `${Math.round(h)}px`;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.max(1, Math.round(w * dpr)), ch = Math.max(1, Math.round(h * dpr));
  if (els.overlay.width !== cw || els.overlay.height !== ch) { els.overlay.width = cw; els.overlay.height = ch; }
  app.dpr = dpr;
  if (!app.running) render(app.lastFrame);
}
const stageObserver = new ResizeObserver(() => {
  const w = els.stage.clientWidth;
  if (w !== app.lastContainerW) { app.lastContainerW = w; layoutStage(); }
});
stageObserver.observe(els.stage);
window.addEventListener('resize', layoutStage);

// 분석 좌표(영상 픽셀) ↔ 캔버스 좌표
function contentTransform() {
  const cw = els.overlay.width, ch = els.overlay.height;
  const vw = app.videoW || 3, vh = app.videoH || 4;
  const scale = Math.min(cw / vw, ch / vh);
  const drawW = vw * scale, drawH = vh * scale;
  return { offX: (cw - drawW) / 2, offY: (ch - drawH) / 2, k: scale, drawW, drawH };
}

function configureSource(width, height) {
  app.videoW = width;
  app.videoH = height;
  els.stageMedia.classList.toggle('mirrored', app.mirrored);
  els.video.hidden = app.mode === 'demo';
  layoutStage();
}

// ===== MediaPipe 불러오기 =====
async function importTasksVision() {
  // CDN이 모듈을 내주는 방식이 버전마다 달라서 여러 경로를 차례로 시도
  const candidates = [TASKS_BASE, `${TASKS_BASE}/+esm`, `${TASKS_BASE}/vision_bundle.mjs`];
  let lastError = null;
  for (const url of candidates) {
    try {
      const mod = await import(url);
      const api = mod.PoseLandmarker ? mod : mod.default;
      if (api && api.PoseLandmarker && api.FilesetResolver) return api;
    } catch (err) { lastError = err; }
  }
  throw lastError || new Error('tasks-vision 모듈 없음');
}

async function createPoseLandmarker(api, fileset, delegate) {
  let lastError = null;
  for (const modelAssetPath of MODEL_URLS) {
    try {
      return await api.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputSegmentationMasks: false,
      });
    } catch (err) { lastError = err; }
  }
  throw lastError;
}

async function loadPoseModel() {
  if (app.pose) return app.pose;
  if (!app.poseLoading) {
    app.poseLoading = (async () => {
      const api = await importTasksVision();
      const fileset = await api.FilesetResolver.forVisionTasks(`${TASKS_BASE}/wasm`);
      app.visionApi = api;
      app.fileset = fileset;
      try {
        const landmarker = await createPoseLandmarker(api, fileset, 'GPU');
        app.poseDelegate = 'GPU';
        return landmarker;
      } catch (gpuError) {
        console.warn('GPU 초기화 실패, CPU로 다시 시도', gpuError);
        const landmarker = await createPoseLandmarker(api, fileset, 'CPU');
        app.poseDelegate = 'CPU';
        return landmarker;
      }
    })();
  }
  try {
    app.pose = await app.poseLoading;
    return app.pose;
  } catch (err) {
    app.poseLoading = null;
    console.error(err);
    throw new UserFacingError(poseFailMessage(err));
  }
}

function poseFailMessage(err) {
  const detail = String(err?.message || err || '').slice(0, 80);
  return `AI 자세 모델을 불러오지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.${detail ? ` (${detail})` : ''}`;
}

function warnPoseUnavailable(message) {
  showAlert(message || poseFailMessage(null), { label: '다시 시도', run: retryPoseModel });
}

async function retryPoseModel() {
  setLoading('AI 모델 불러오는 중…');
  try {
    await loadPoseModel();
    hideAlert();
  } catch (err) {
    warnPoseUnavailable(err instanceof UserFacingError ? err.message : undefined);
  } finally {
    setLoading(null);
  }
}

// GPU에서 오류가 반복되면 CPU로 갈아타기(일부 기기 대응)
async function switchToCpu() {
  if (!app.visionApi || !app.fileset || app.poseDelegate === 'CPU') return;
  const old = app.pose;
  app.pose = null;
  try { old?.close?.(); } catch { /* 이미 닫힘 */ }
  try {
    app.pose = await createPoseLandmarker(app.visionApi, app.fileset, 'CPU');
    app.poseDelegate = 'CPU';
    app.consecutiveErrors = 0;
  } catch (err) {
    console.error(err);
    showAlert('AI 자세 분석을 켜지 못했어요. 라운드 타이머만 동작해요.');
  }
}

function detectPose(source, t) {
  if (!app.pose) return null;
  // detectForVideo는 타임스탬프가 엄격히 증가해야 함
  const ts = Math.max(app.lastDetectTs + 1, Math.floor(performance.now()));
  app.lastDetectTs = ts;
  const result = app.pose.detectForVideo(source, ts);
  try {
    const landmarks = result?.landmarks?.[0];
    if (!landmarks) return null;
    return buildPoseFrame(t, landmarks, result.worldLandmarks?.[0], app.videoW, app.videoH);
  } finally {
    result?.close?.();
  }
}

// ===== 카메라 =====
function describeCameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '카메라 권한이 막혀 있어요. 주소창 옆 사이트 설정에서 카메라를 허용한 뒤 다시 눌러 주세요.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '쓸 수 있는 카메라를 찾지 못했어요.';
    case 'NotReadableError':
    case 'AbortError':
      return '다른 앱이 카메라를 쓰고 있어요. 그 앱을 닫고 다시 시도해 주세요.';
    default:
      return `카메라를 켜지 못했어요. (${err?.message || '알 수 없는 오류'})`;
  }
}

function waitForVideoSize(video, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const check = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) resolve();
      else if (performance.now() - started > timeoutMs) reject(new UserFacingError('영상 크기를 읽지 못했어요. 다시 시도해 주세요.'));
      else requestAnimationFrame(check);
    };
    check();
  });
}

async function openCamera() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: app.facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 60 } },
    });
  } catch (err) {
    throw new UserFacingError(describeCameraError(err));
  }
  app.stream = stream;
  const v = els.video;
  v.srcObject = stream;
  v.muted = true;
  v.playsInline = true;
  await v.play();
  await waitForVideoSize(v);
  app.mirrored = app.facing === 'user';   // 셀카 화면만 거울처럼(분석은 원본 기준)
  configureSource(v.videoWidth, v.videoHeight);
}

function stopStream() {
  if (app.stream) {
    for (const track of app.stream.getTracks()) track.stop();
    app.stream = null;
  }
  els.video.srcObject = null;
}

// 카메라·영상 정리: 리소스(카메라, object URL, 루프, 화면 꺼짐 방지) 누수 방지
function stopSource() {
  app.running = false;
  cancelLoop();
  stopStream();
  els.video.pause();
  if (app.fileUrl) {
    els.video.removeAttribute('src');
    els.video.load();
    URL.revokeObjectURL(app.fileUrl);
    app.fileUrl = null;
  }
  releaseWakeLock();
  try { window.speechSynthesis?.cancel(); } catch { /* 미지원 */ }
}

async function startCameraSession() {
  hideAlert();
  ensureAudio();
  if (!window.isSecureContext) {
    showAlert('카메라는 https 주소나 내 컴퓨터(localhost)에서만 켜져요. 배포한 https 주소로 열어 주세요.');
    return;
  }
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    showAlert('이 브라우저는 카메라를 지원하지 않아요. 최신 크롬이나 사파리로 열어 주세요.');
    return;
  }
  setLoading('카메라 켜는 중…');
  try {
    stopSource();
    app.mode = 'camera';
    let modelError = null;
    const modelPromise = loadPoseModel().then(() => true, (err) => { modelError = err; return false; });   // 카메라와 모델을 동시에 준비
    await openCamera();
    setLoading('AI 모델 불러오는 중… 처음엔 10초쯤 걸려요');
    const modelReady = await modelPromise;
    resetSession();
    setLoading(null);
    setUiState('ready');
    if (!modelReady) warnPoseUnavailable(modelError instanceof UserFacingError ? modelError.message : undefined);
    requestWakeLock();
    startLoop();
  } catch (err) {
    setLoading(null);
    stopSource();
    app.mode = 'idle';
    setUiState('idle');
    showAlert(err instanceof UserFacingError ? err.message : describeCameraError(err), { label: '다시 시도', run: startCameraSession });
  }
}

async function flipCamera() {
  if (app.mode !== 'camera') return;
  app.facing = app.facing === 'user' ? 'environment' : 'user';
  app.running = false;
  cancelLoop();
  app.analyzer.softReset();
  try {
    stopStream();
    await openCamera();
    startLoop();
  } catch (err) {
    showAlert(err instanceof UserFacingError ? err.message : '카메라를 바꾸지 못했어요.');
    finishSession();
  }
}

// ===== 라운드 시작·일시정지 =====
function timerNow() { return app.mode === 'demo' ? app.demoT : performance.now() / 1000; }

function startRounds() {
  if (app.mode === 'file') { playFile(); return; }
  if (app.mode !== 'camera') return;
  ensureAudio();
  hideAlert();
  app.timer.configure({ roundSec: settings.roundSec, restSec: settings.restSec, rounds: settings.rounds, readySec: READY_SEC });
  setUiState('running');
  handleTimerEvents(app.timer.start(timerNow()));
  if (!app.pose) showAlert('AI 모델 없이 라운드 타이머만 동작해요. 펀치를 세려면 모델을 다시 불러와 주세요.', { label: '다시 시도', run: retryPoseModel });
}

function updatePauseButton() {
  const paused = app.mode === 'file' ? els.video.paused : app.timer.paused;
  els.btnPause.textContent = paused ? '계속' : '일시정지';
  els.btnPause.setAttribute('aria-pressed', paused ? 'true' : 'false');
}

async function togglePause() {
  if (app.mode === 'file') {
    if (els.video.paused) {
      try { await els.video.play(); } catch { showAlert('영상을 재생하지 못했어요. 다시 눌러 주세요.'); }
    } else els.video.pause();
    updatePauseButton();
    return;
  }
  if (!app.timer.isActive()) return;
  if (app.timer.paused) {
    app.timer.resume(timerNow());
    app.autoPaused = false;
    hideAlert();
  } else {
    app.timer.pause(timerNow());
  }
  app.analyzer.softReset();
  updatePauseButton();
  updateHud();
}

// ===== 영상 파일 =====
function waitForEvent(target, eventName, timeoutMs, failMessage) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(eventName, onOk);
      target.removeEventListener('error', onError);
    };
    const onOk = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new UserFacingError(failMessage)); };
    const timer = setTimeout(() => { cleanup(); reject(new UserFacingError(failMessage)); }, timeoutMs);
    target.addEventListener(eventName, onOk, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

async function startFileSession(file) {
  hideAlert();
  ensureAudio();
  const looksLikeVideo = (file.type && file.type.startsWith('video/')) || /\.(mp4|mov|m4v|webm)$/i.test(file.name || '');
  if (!looksLikeVideo) { showAlert('영상 파일만 올릴 수 있어요.'); return; }
  setLoading('영상 여는 중…');
  try {
    stopSource();
    app.mode = 'file';
    let modelError = null;
    const modelPromise = loadPoseModel().then(() => true, (err) => { modelError = err; return false; });
    app.fileUrl = URL.createObjectURL(file);
    const v = els.video;
    v.srcObject = null;
    v.muted = true;
    v.playsInline = true;
    v.loop = false;
    v.src = app.fileUrl;
    await waitForEvent(v, 'loadedmetadata', 15000,
      '영상을 열지 못했어요. 이 브라우저에서 재생되지 않는 형식일 수 있어요. 아이폰이면 설정 > 카메라 > 포맷에서 "높은 호환성"으로 찍어 주세요.');
    app.mirrored = false;
    configureSource(v.videoWidth, v.videoHeight);
    try { v.currentTime = 0.05; await waitForEvent(v, 'seeked', 3000, ''); } catch { /* 일부 브라우저는 seek 이벤트가 늦음: 무시 */ }
    setLoading('AI 모델 불러오는 중… 처음엔 10초쯤 걸려요');
    const modelReady = await modelPromise;
    resetSession();
    setLoading(null);
    if (!modelReady) {
      stopSource();
      app.mode = 'idle';
      setUiState('idle');
      warnPoseUnavailable(modelError instanceof UserFacingError ? modelError.message : undefined);
      return;
    }
    setUiState('ready');
  } catch (err) {
    setLoading(null);
    stopSource();
    app.mode = 'idle';
    setUiState('idle');
    showAlert(err instanceof UserFacingError ? err.message : `영상을 열지 못했어요. (${err?.message || '알 수 없는 오류'})`);
  }
}

async function playFile() {
  if (app.mode !== 'file') return;
  hideAlert();
  ensureAudio();
  try {
    els.video.playbackRate = 0.5;   // 느리게 재생해서 빠른 펀치도 프레임을 더 많이 분석
    await els.video.play();
  } catch {
    showAlert('영상을 재생하지 못했어요. 다시 눌러 주세요.');
    return;
  }
  if (!app.fileRoundStarted) {
    app.analyzer.beginRound(1, els.video.currentTime);
    app.fileRoundStarted = true;
  }
  setUiState('running');
  startLoop();
}

els.video.addEventListener('ended', () => { if (app.mode === 'file' && app.uiState === 'running') finishSession(); });
els.video.addEventListener('play', updatePauseButton);
els.video.addEventListener('pause', updatePauseButton);

// ===== 데모(카메라 없이 화면 흐름 보기) =====
function startDemoSession() {
  hideAlert();
  ensureAudio();
  stopSource();
  app.mode = 'demo';
  app.mirrored = false;
  app.demo = createShadowboxSimulation({
    seed: (Date.now() % 9973) + 1, stance: settings.stance, width: DEMO_SIZE.w, height: DEMO_SIZE.h, mode: 'guard', focalRatio: 1.1, cyRatio: 0.51,
    periods: DEMO_PERIODS, mistakes: { otherDrop: 0.3, slow: 0.2, noRotation: 0.4 },
  });
  configureSource(DEMO_SIZE.w, DEMO_SIZE.h);
  resetSession();
  app.demoT = 0;
  app.demoAccum = 0;
  app.timer.configure(DEMO_TIMER);
  setUiState('running');
  handleTimerEvents(app.timer.start(0));
  startLoop();
}

function demoTick(now) {
  app.loopHandle = null;
  if (!app.running || app.mode !== 'demo') return;
  const elapsed = Math.min(0.1, Math.max(0, (now - app.demoLastNow) / 1000));
  app.demoLastNow = now;
  if (!app.timer.paused) app.demoAccum += elapsed;
  try {
    // 30fps 고정 간격으로 진행(기기 속도와 무관하게 같은 결과)
    let steps = 0;
    while (app.demoAccum >= DEMO_STEP && steps < 6) {
      app.demoAccum -= DEMO_STEP;
      steps++;
      app.demoT += DEMO_STEP;
      app.demo.step(DEMO_STEP);
      const fr = app.demo.frame();
      if (analyzeFrame(app.demoT, buildPoseFrame(app.demoT, fr.landmarks, fr.world, DEMO_SIZE.w, DEMO_SIZE.h)) === 'finished') return;
    }
    if (!steps) { render(app.lastFrame); updateHud(); }
  } catch (err) {
    handleFrameError(err);
  }
  if (app.running) app.loopHandle = requestAnimationFrame(demoTick);
}

// ===== 프레임 루프 =====
function startLoop() {
  cancelLoop();
  app.running = true;
  app.fps = { frames: 0, since: performance.now(), value: 0, startedAt: performance.now(), warned: app.fps.warned };
  app.lastPoseSeenAt = performance.now();
  if (app.mode === 'demo') {
    app.demoLastNow = performance.now();
    app.loopKind = 'raf';
    app.loopHandle = requestAnimationFrame(demoTick);
    return;
  }
  scheduleVideoFrame();
}

function scheduleVideoFrame() {
  if (!app.running) return;
  const v = els.video;
  // 새 프레임이 나올 때만 처리(처리 중 밀린 프레임은 건너뜀 → 지연이 쌓이지 않음)
  if (typeof v.requestVideoFrameCallback === 'function') {
    app.loopKind = 'rvfc';
    app.loopHandle = v.requestVideoFrameCallback(onVideoFrame);
  } else {
    app.loopKind = 'raf';
    app.loopHandle = requestAnimationFrame((now) => onVideoFrame(now, null));
  }
}

function cancelLoop() {
  if (app.loopHandle === null) return;
  if (app.loopKind === 'rvfc' && typeof els.video.cancelVideoFrameCallback === 'function') els.video.cancelVideoFrameCallback(app.loopHandle);
  else cancelAnimationFrame(app.loopHandle);
  app.loopHandle = null;
}

function onVideoFrame(now, meta) {
  app.loopHandle = null;
  if (!app.running) return;
  try {
    processVideoFrame(now, meta);
    app.consecutiveErrors = 0;
  } catch (err) {
    handleFrameError(err);
  }
  scheduleVideoFrame();
}

function processVideoFrame(now, meta) {
  const v = els.video;
  if (v.readyState < 2 || !app.videoW) return;
  const mediaTime = meta && typeof meta.mediaTime === 'number' ? meta.mediaTime : v.currentTime;
  if (app.mode === 'file') {
    if (mediaTime === app.lastMediaTime) return;
    app.lastMediaTime = mediaTime;
  }
  // 영상 파일은 영상 속 시간 기준(0.5배속으로 재생해도 펀치 속도가 맞게)
  const t = app.mode === 'file' ? mediaTime : now / 1000;
  analyzeFrame(t, detectPose(v, t));
}

function handleFrameError(err) {
  app.consecutiveErrors++;
  console.error(err);
  if (app.consecutiveErrors === 5 && app.poseDelegate === 'GPU') { switchToCpu(); return; }
  if (app.consecutiveErrors >= 20) {
    showAlert('분석 중 오류가 계속 나서 멈췄어요. 페이지를 새로고침해 주세요.');
    finishSession();
  }
}

function isCounting() {
  if (app.mode === 'file') return app.uiState === 'running' && !els.video.paused;
  return app.timer.phase === 'round' && !app.timer.paused;
}

// 카메라·영상·데모가 공유하는 한 프레임 분석
function analyzeFrame(t, frame) {
  if (app.mode !== 'file' && app.timer.isActive()) {
    if (handleTimerEvents(app.timer.update(timerNow())) === 'finished') return 'finished';
  }
  const events = app.analyzer.update(frame, { counting: isCounting() });
  app.lastFrame = frame;
  if (frame) app.lastPoseSeenAt = performance.now();
  handleAnalyzerEvents(events);
  render(frame);
  updateChips(frame);
  updateHud();
  updateTip(false);
  countFps();
  return null;
}

// ===== 타이머 이벤트 → 공 소리·음성·라운드 기록 =====
function handleTimerEvents(events) {
  for (const ev of events) {
    const t = timerNow();
    if (ev.type === 'phase') {
      if (ev.phase === 'ready') {
        speak(app.mode === 'camera' ? `${READY_SEC}초 뒤 시작해요. 가드 올리세요.` : '곧 시작해요. 가드 올리세요.', 2);
        if (app.demo) app.demo.setMode('guard');
      } else if (ev.phase === 'round') {
        app.analyzer.beginRound(ev.round, t);
        playBell(1);
        speak(`${ev.round}라운드`, 2);
        hideCountdown();
        if (app.demo) app.demo.setMode('fight');
      } else if (ev.phase === 'rest') {
        if (app.demo) app.demo.setMode('rest');
      }
    } else if (ev.type === 'count') {
      showCountdown(ev.n);
      playTone('count');
    } else if (ev.type === 'warn10') {
      playClapper();
    } else if (ev.type === 'roundEnd') {
      const r = app.analyzer.endRound(t);
      playBell(3);
      renderSets();
      if (r) {
        const issue = r.topIssue ? ISSUES[r.topIssue].tip : '반복해서 나온 자세 문제는 없었어요.';
        speak(`${r.index}라운드 끝. 펀치 ${r.punches}개. ${issue}`, 3);
      }
    } else if (ev.type === 'done') {
      finishSession();
      return 'finished';
    }
  }
  return null;
}

// ===== 분석 이벤트 → 소리·음성·표시 =====
function handleAnalyzerEvents(events) {
  for (const ev of events) {
    if (ev.type === 'punch') {
      const p = ev.punch;
      const type = PUNCH_TYPES[app.analyzer.typeOf(p)];
      if (!reduceMotion.matches) {
        // 이름표는 몸 바깥쪽에 띄워서 얼굴·장갑을 가리지 않게
        const mid = app.lastFrame ? app.lastFrame.shoulderMid.x : p.peakFist.x;
        const dir = p.peakFist.x >= mid ? 1 : -1;
        app.pops.push({ x: p.peakFist.x, y: p.peakFist.y, dir, text: type.label, counted: p.counted, at: performance.now(), seed: Math.random() * Math.PI });
        if (app.pops.length > 10) app.pops.shift();
      }
      if (p.counted) {
        playTone('punch');
        bumpCounter();
      }
    } else if (ev.type === 'combo') {
      app.comboKey = ev.nums.join('-');
      app.comboUntil = performance.now() + 1800;
    } else if (ev.type === 'cue') {
      showCue(ev);
    } else if (ev.type === 'stanceHint') {
      const label = STANCE_LABEL[ev.suggested];
      showAlert(`${label} 자세로 서 있는 것 같아요. 설정을 ${label}로 바꿀까요? 지금까지 센 펀치 이름도 같이 바뀌어요.`, {
        label: `${label}로 바꾸기`, run: () => setStance(ev.suggested),
      });
    }
  }
}

function cueText(ev) {
  if (ev.issue === 'guardLow') return ev.role === 'lead' ? '앞손 가드 올려요' : ev.role === 'rear' ? '뒷손 가드 올려요' : '가드 올려요';
  if (ev.issue === 'otherHandDrop') return ev.role === 'rear' ? '뒷손은 턱에' : '앞손은 얼굴 앞에';
  return ISSUES[ev.issue].cue;
}

function showCue(ev) {
  const text = cueText(ev);
  app.cue = { text, issue: ev.issue, until: performance.now() + CUE_MS };
  els.cueBanner.textContent = text;
  els.cueBanner.hidden = false;
  els.cueBanner.classList.remove('show');
  void els.cueBanner.offsetWidth;   // 애니메이션 다시 시작
  els.cueBanner.classList.add('show');
  speak(text, 1);
  playTone('cue');
  updateTip(true);
}
function hideCue() { app.cue = null; els.cueBanner.hidden = true; }

function showCountdown(n) {
  if (app.countdownShown === n) return;
  app.countdownShown = n;
  els.countdown.textContent = String(n);
  els.countdown.hidden = false;
  els.countdown.classList.remove('tick');
  void els.countdown.offsetWidth;
  els.countdown.classList.add('tick');
}
function hideCountdown() {
  app.countdownShown = null;
  els.countdown.hidden = true;
}

function setStageAlert(on) {
  const value = on ? 'on' : 'off';
  if (els.stage.dataset.alert !== value) els.stage.dataset.alert = value;
}

// ===== 소리(브라우저에서 합성: 파일 없이 공·딱딱이·삑) =====
function ensureAudio() {
  // 브라우저는 사용자가 누른 뒤에만 소리를 허용하므로 버튼 클릭 때 준비
  try {
    if (!app.audio) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) app.audio = new Ctx();
    }
    if (app.audio && app.audio.state === 'suspended') app.audio.resume().catch(() => {});
  } catch { app.audio = null; }
}

function soundOn() { return els.optSound.checked && app.audio && app.audio.state !== 'closed'; }

// 한 번 울리고 사라지는 사인파(끝나면 노드 연결 해제 → 누수 방지)
function ping(freq, start, dur, gainValue, type = 'sine') {
  const ctx = app.audio;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  osc.start(start);
  osc.stop(start + dur + 0.05);
}

// 링 공: 비정수배 배음을 겹친 금속성 소리
function playBell(strikes) {
  if (!soundOn()) return;
  const t0 = app.audio.currentTime + 0.02;
  const partials = [[1, 0.22], [2.0, 0.1], [2.76, 0.08], [4.07, 0.05], [5.4, 0.03]];
  for (let i = 0; i < strikes; i++) {
    const start = t0 + i * 0.38;
    for (const [ratio, gain] of partials) ping(640 * ratio, start, 1.6 / Math.sqrt(ratio), gain);
  }
}

// 10초 전 딱딱이
function playClapper() {
  if (!soundOn()) return;
  const ctx = app.audio;
  if (!app.noiseBuffer) {
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.06), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    app.noiseBuffer = buffer;
  }
  const t0 = ctx.currentTime + 0.02;
  for (const offset of [0, 0.17]) {
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = app.noiseBuffer;
    filter.type = 'bandpass';
    filter.frequency.value = 2300;
    filter.Q.value = 1.4;
    gain.gain.value = 0.9;
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.onended = () => { src.disconnect(); filter.disconnect(); gain.disconnect(); };
    src.start(t0 + offset);
  }
}

const TONES = {
  punch: { freq: 170, dur: 0.07, gain: 0.16, type: 'sine' },
  count: { freq: 880, dur: 0.12, gain: 0.14, type: 'sine' },
  cue: { freq: 330, dur: 0.16, gain: 0.1, type: 'triangle' },
};
function playTone(kind) {
  if (!soundOn()) return;
  const spec = TONES[kind];
  ping(spec.freq, app.audio.currentTime + 0.005, spec.dur, spec.gain, spec.type);
}

// 중요한 안내(라운드 결과) 중에는 짧은 큐로 끊지 않음
function speak(text, priority = 1) {
  if (!els.optVoice.checked || !('speechSynthesis' in window)) return;
  try {
    const synth = window.speechSynthesis;
    if (synth.speaking && priority < app.speechPriority) return;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    utterance.rate = 1.1;
    app.speechPriority = priority;
    utterance.onend = () => { app.speechPriority = 0; };
    utterance.onerror = () => { app.speechPriority = 0; };
    synth.speak(utterance);
  } catch { /* 음성 미지원 기기 */ }
}

// ===== 화면 꺼짐 방지·백그라운드 =====
async function requestWakeLock() {
  try { app.wakeLock = await navigator.wakeLock?.request('screen'); } catch { app.wakeLock = null; }
}
function releaseWakeLock() {
  try { app.wakeLock?.release(); } catch { /* 이미 해제 */ }
  app.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // 화면이 꺼지거나 다른 앱으로 가면 라운드 시계를 멈춤(카메라도 멈추므로)
    if ((app.mode === 'camera' || app.mode === 'demo') && app.timer.isActive() && !app.timer.paused) {
      app.timer.pause(timerNow());
      app.autoPaused = true;
      updatePauseButton();
    }
    return;
  }
  if (app.running && app.mode === 'camera') requestWakeLock();
  if (app.autoPaused) showAlert('화면을 벗어나서 라운드를 멈췄어요. 준비되면 "계속"을 누르세요.');
});
window.addEventListener('pagehide', () => stopSource());

// ===== 세션 =====
function resetSession() {
  app.analyzer.setStance(settings.stance);
  app.analyzer.reset();
  app.timer.reset();
  app.timer.configure({ roundSec: settings.roundSec, restSec: settings.restSec, rounds: settings.rounds, readySec: READY_SEC });
  app.pops = [];
  app.lastFrame = null;
  app.lastMediaTime = -1;
  app.consecutiveErrors = 0;
  app.autoPaused = false;
  app.fileRoundStarted = false;
  app.comboUntil = 0;
  app.shown = {};
  hideCue();
  hideCountdown();
  setStageAlert(false);
  els.summaryCard.hidden = true;
  renderSets();
  updateHud();
}

function finishSession() {
  if (app.mode === 'idle' || app.uiState === 'finished') return;
  const t = app.mode === 'file' ? els.video.currentTime : timerNow();
  if (app.analyzer.round) app.analyzer.endRound(t);
  if (app.timer.isActive()) app.timer.phase = 'done';
  const speakDone = app.analyzer.punches.length > 0;
  stopSource();
  setUiState('finished');
  renderSets();
  renderSummary();
  updateHud();
  if (speakDone) speak('끝. 결과를 확인하세요.', 3);
  if (window.matchMedia('(max-width: 919px)').matches) els.summaryCard.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
}

function newSession() {
  stopSource();
  app.mode = 'idle';
  resetSession();
  hideAlert();
  setUiState('idle');
  updateChips(null);
  render(null);
  window.scrollTo({ top: 0, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
}

// ===== 그리기 =====
// 셀카 화면은 CSS로 좌우를 뒤집으므로 글자는 다시 뒤집어서 그림
function drawLabel(ctx, x, y, text, fontPx, fill, unit) {
  ctx.save();
  ctx.translate(x, y);
  if (app.mirrored) ctx.scale(-1, 1);
  ctx.font = `800 ${fontPx}px "Noto Sans KR", "Apple SD Gothic Neo", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + fontPx * 1.1;
  const h = fontPx * 1.75;
  ctx.fillStyle = fill;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 8 * unit;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(-w / 2, -h / 2, w, h, h / 2);
  else ctx.rect(-w / 2, -h / 2, w, h);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(text, 0, fontPx * 0.04);
  ctx.restore();
}

function drawDemoScene(ctx, T, frame, unit) {
  const C = app.colors;
  const g = ctx.createLinearGradient(0, T.offY, 0, T.offY + T.drawH);
  g.addColorStop(0, '#2B3962');
  g.addColorStop(1, '#141B33');
  ctx.fillStyle = g;
  ctx.fillRect(T.offX, T.offY, T.drawW, T.drawH);
  // 링 로프
  ctx.lineCap = 'round';
  for (const [k, color] of [[0.36, 'rgba(238, 63, 69, 0.3)'], [0.46, 'rgba(255, 255, 255, 0.12)'], [0.56, 'rgba(255, 255, 255, 0.09)']]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 5 * unit;
    ctx.beginPath();
    ctx.moveTo(T.offX, T.offY + T.drawH * k);
    ctx.lineTo(T.offX + T.drawW, T.offY + T.drawH * k);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.fillRect(T.offX, T.offY + T.drawH * 0.84, T.drawW, T.drawH * 0.16);
  if (!frame) return;
  const P = frame.px;
  const X = (id) => T.offX + P[id].x * T.k, Y = (id) => T.offY + P[id].y * T.k;
  const pt = (id) => ({ x: X(id), y: Y(id) });
  const lerpPt = (p, q, k) => ({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k });
  const torsoPx = frame.torsoLen * T.k;
  const ground = frame.groundY !== null ? T.offY + frame.groundY * T.k : T.offY + T.drawH * 0.9;
  const hipMid = { x: T.offX + frame.hipMid.x * T.k, y: T.offY + frame.hipMid.y * T.k };
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.beginPath();
  ctx.ellipse(hipMid.x, ground + 3 * unit, torsoPx * 0.8, torsoPx * 0.1, 0, 0, Math.PI * 2);
  ctx.fill();
  const segment = (p, q, width, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
  };
  // 다리(허벅지는 굵게, 정강이는 가늘게) + 신발
  for (const [hip, knee, ankle, toe] of [[LM.L_HIP, LM.L_KNEE, LM.L_ANKLE, LM.L_TOE], [LM.R_HIP, LM.R_KNEE, LM.R_ANKLE, LM.R_TOE]]) {
    segment(pt(hip), pt(knee), torsoPx * 0.26, C.figureDark);
    segment(pt(knee), pt(ankle), torsoPx * 0.18, C.figureDark);
    segment(pt(ankle), lerpPt(pt(ankle), pt(toe), 0.55), torsoPx * 0.2, '#0F1529');
  }
  // 트렁크(엉덩이~허벅지 위쪽)
  const lh = pt(LM.L_HIP), rh = pt(LM.R_HIP);
  const lk = lerpPt(lh, pt(LM.L_KNEE), 0.42), rk = lerpPt(rh, pt(LM.R_KNEE), 0.42);
  const out = (p, q, k) => ({ x: p.x + (p.x - q.x) * k, y: p.y + (p.y - q.y) * k });
  ctx.fillStyle = C.red;
  ctx.beginPath();
  const corners = [out(lh, rh, 0.42), out(rh, lh, 0.42), out(rk, lk, 0.28), out(lk, rk, 0.28)];
  corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
  ctx.closePath();
  ctx.fill();
  // 몸통: 어깨는 넓고 허리는 좁게
  const ls = pt(LM.L_SHOULDER), rs = pt(LM.R_SHOULDER);
  const waistL = lerpPt(ls, lh, 0.72), waistR = lerpPt(rs, rh, 0.72);
  const body = [out(ls, rs, 0.12), out(rs, ls, 0.12), out(waistR, waistL, 0.05), out(rh, lh, 0.4), out(lh, rh, 0.4), out(waistL, waistR, 0.05)];
  const tg = ctx.createLinearGradient(0, Math.min(ls.y, rs.y), 0, Math.max(lh.y, rh.y));
  tg.addColorStop(0, '#E8EDF7');
  tg.addColorStop(1, '#C6D0E6');
  ctx.fillStyle = tg;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  body.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = tg;
  ctx.lineWidth = torsoPx * 0.08;
  ctx.stroke();
  // 목 + 머리
  const ear = lerpPt(pt(LM.L_EAR), pt(LM.R_EAR), 0.5);
  const neckBase = lerpPt(ls, rs, 0.5);
  segment(neckBase, lerpPt(neckBase, ear, 0.7), torsoPx * 0.16, C.skin);
  ctx.fillStyle = C.skin;
  ctx.beginPath();
  ctx.arc(ear.x, ear.y + torsoPx * 0.01, torsoPx * 0.21, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1F2A48';
  ctx.beginPath();
  ctx.arc(X(LM.NOSE), Y(LM.NOSE), torsoPx * 0.022, 0, Math.PI * 2);
  ctx.fill();
  // 팔 + 장갑(가드 손이 몸 앞에 오므로 마지막에, 배경색 테두리로 몸통과 구분)
  for (const side of ['R', 'L']) {
    const ids = side === 'L' ? [LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST] : [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST];
    const sh = pt(ids[0]), el = pt(ids[1]), wr = pt(ids[2]);
    for (const [width, color] of [[torsoPx * 0.2, 'rgba(20, 27, 51, 0.55)'], [torsoPx * 0.14, '#F3D9C8']]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(sh.x, sh.y);
      ctx.lineTo(el.x, el.y);
      ctx.lineTo(wr.x, wr.y);
      ctx.stroke();
    }
    const f = app.analyzer.live.hands[side]?.f;
    const gx = f ? T.offX + f.fist.x * T.k : wr.x, gy = f ? T.offY + f.fist.y * T.k : wr.y;
    const r = torsoPx * 0.135;
    const grad = ctx.createRadialGradient(gx - r * 0.35, gy - r * 0.4, r * 0.1, gx, gy, r);
    grad.addColorStop(0, '#FF8A8E');
    grad.addColorStop(1, '#D9343B');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(gx, gy, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function render(frame) {
  const ctx = app.overlayCtx;
  const cv = els.overlay;
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!app.videoW) return;
  const T = contentTransform();
  const sx = (x) => T.offX + x * T.k;
  const sy = (y) => T.offY + y * T.k;
  const unit = app.dpr;
  const C = app.colors;
  ctx.lineCap = 'round';

  if (app.mode === 'demo') drawDemoScene(ctx, T, frame, unit);

  const live = app.analyzer.live;
  if (frame && live.body) {
    const P = frame.px;
    const torsoPx = live.body.torso * T.k;
    // 가드 선: 주먹이 이 선 아래로 내려가면 '가드 내려감'
    const off = CONFIG.guard.lowV * live.body.torso;
    const up = live.body.up;
    const a = { x: P[LM.L_SHOULDER].x + up.x * off, y: P[LM.L_SHOULDER].y + up.y * off };
    const b = { x: P[LM.R_SHOULDER].x + up.x * off, y: P[LM.R_SHOULDER].y + up.y * off };
    const dx = b.x - a.x, dy = b.y - a.y;
    const low = live.guardLow.L || live.guardLow.R;
    ctx.save();
    ctx.setLineDash([7 * unit, 7 * unit]);
    ctx.lineWidth = 2.5 * unit;
    ctx.strokeStyle = low ? C.red : 'rgba(123, 240, 181, 0.75)';
    ctx.beginPath();
    ctx.moveTo(sx(a.x - dx * 0.45), sy(a.y - dy * 0.45));
    ctx.lineTo(sx(b.x + dx * 0.45), sy(b.y + dy * 0.45));
    ctx.stroke();
    ctx.restore();

    if (app.mode !== 'demo') {
      ctx.lineWidth = 3 * unit;
      ctx.strokeStyle = C.bone;
      for (const [i, j] of SKELETON) {
        const A = P[i], B = P[j];
        if (A.v < 0.4 || B.v < 0.4) continue;
        ctx.beginPath();
        ctx.moveTo(sx(A.x), sy(A.y));
        ctx.lineTo(sx(B.x), sy(B.y));
        ctx.stroke();
      }
    }

    // 뻗은 주먹 궤적(빨간 꼬리)
    const tNow = frame.t;
    for (const side of ['L', 'R']) {
      const hand = app.analyzer.hands[side];
      const paths = [];
      if (hand.trail.length > 1) paths.push({ pts: hand.trail, alpha: 0.45, color: '#FFFFFF' });
      if (hand.lastTrail && hand.lastTrail.points.length > 1) {
        const age = tNow - hand.lastTrail.at;
        if (age >= 0 && age < 0.4) paths.push({ pts: hand.lastTrail.points, alpha: 0.8 * (1 - age / 0.4), color: C.red });
      }
      for (const path of paths) {
        ctx.save();
        ctx.globalAlpha = path.alpha;
        ctx.strokeStyle = path.color;
        ctx.lineWidth = Math.max(4 * unit, torsoPx * 0.06);
        ctx.lineJoin = 'round';
        ctx.beginPath();
        path.pts.forEach((p, i) => (i ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y))));
        ctx.stroke();
        ctx.restore();
      }
    }

    // 주먹 표시: 가드 OK = 흰 고리, 내려감 = 굵은 빨간 고리, 펀치 중 = 빨간 원
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 160);
    for (const side of ['L', 'R']) {
      const h = live.hands[side];
      if (!h) continue;
      const r = Math.max(8 * unit, torsoPx * 0.1);
      const x = sx(h.f.fist.x), y = sy(h.f.fist.y);
      const punching = h.state === 'out' || h.state === 'back';
      ctx.save();
      if (punching && app.mode !== 'demo') {
        ctx.fillStyle = C.red;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(x, y, r * 0.8, 0, Math.PI * 2);
        ctx.fill();
      } else if (live.guardLow[side]) {
        ctx.strokeStyle = C.red;
        ctx.lineWidth = (4 + 2 * pulse) * unit;
        ctx.beginPath();
        ctx.arc(x, y, r * (1.15 + 0.15 * pulse), 0, Math.PI * 2);
        ctx.stroke();
      } else if (app.mode !== 'demo') {
        ctx.strokeStyle = C.joint;
        ctx.lineWidth = 3 * unit;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // 펀치 임팩트: 퍼지는 고리 + 이름표(셀 때는 빨강, 준비·휴식 중엔 회색)
  const now = performance.now();
  app.pops = app.pops.filter((p) => now - p.at < POP_MS);
  for (const p of app.pops) {
    const k = (now - p.at) / POP_MS;
    const ease = 1 - (1 - k) * (1 - k);
    const x = sx(p.x), y = sy(p.y);
    const base = Math.max(14 * unit, (live.body ? live.body.torso * T.k : 120 * unit) * 0.14);
    ctx.save();
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = p.counted ? C.red : C.muted;
    ctx.lineWidth = 4 * unit * (1 - k * 0.5);
    ctx.beginPath();
    ctx.arc(x, y, base * (1 + ease * 1.6), 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2.5 * unit;
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2 + p.seed;
      const r0 = base * (1.3 + ease * 1.0), r1 = base * (1.6 + ease * 1.7);
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(angle) * r0, y + Math.sin(angle) * r0);
      ctx.lineTo(x + Math.cos(angle) * r1, y + Math.sin(angle) * r1);
      ctx.stroke();
    }
    ctx.globalAlpha = k < 0.7 ? 1 : (1 - k) / 0.3;
    const fontPx = Math.round(Math.max(14 * unit, Math.min(24 * unit, base * 0.95)));
    ctx.font = `800 ${fontPx}px "Noto Sans KR", "Apple SD Gothic Neo", sans-serif`;
    const halfW = (ctx.measureText(p.text).width + fontPx * 1.1) / 2;
    const lx = Math.min(T.offX + T.drawW - halfW - 4 * unit, Math.max(T.offX + halfW + 4 * unit, x + p.dir * (base * 1.9 + halfW)));
    drawLabel(ctx, lx, y - base * (0.5 + ease * 0.4), p.text, fontPx, p.counted ? C.red : 'rgba(31, 42, 72, 0.85)', unit);
    ctx.restore();
  }
}

// ===== 상태 표시 =====
function setChip(el, state, text) {
  if (el.dataset.state !== state) el.dataset.state = state;
  if (el.textContent !== text) el.textContent = text;
}

function updateChips(frame) {
  if (app.mode === 'idle') {
    setChip(els.chipPose, '', '사람 –');
    setChip(els.chipView, '', '시점 –');
    setChip(els.chipFps, '', '– fps');
    return;
  }
  if (!app.pose && app.mode !== 'demo') setChip(els.chipPose, 'warn', '자세 분석 꺼짐');
  else if (!frame) setChip(els.chipPose, 'bad', '사람 안 보임');
  else if (frame.feetCut) setChip(els.chipPose, 'warn', '발이 잘림');
  else setChip(els.chipPose, 'good', '사람 인식');
  const view = app.analyzer.view;
  if (view === 'front') setChip(els.chipView, 'good', '정면');
  else if (view === 'side') setChip(els.chipView, 'warn', '옆모습');
  else setChip(els.chipView, '', '시점 –');
}

function countFps() {
  const f = app.fps;
  f.frames++;
  const now = performance.now();
  if (now - f.since < 1000) return;
  f.value = (f.frames * 1000) / (now - f.since);
  f.frames = 0;
  f.since = now;
  setChip(els.chipFps, f.value >= 20 ? 'good' : f.value >= 12 ? 'warn' : 'bad', `${Math.round(f.value)} fps`);
  if (app.mode === 'camera' && !f.warned && now - f.startedAt > 5000 && f.value < 12) {
    f.warned = true;
    showAlert(`처리 속도가 낮아요(약 ${Math.round(f.value)}fps). 빠른 잽은 놓칠 수 있어요. 다른 앱을 닫거나 밝은 곳에서 해 보세요.`);
  }
}

function bumpCounter() {
  const el = els.punchNum;
  el.classList.remove('bump');
  void el.offsetWidth;   // 애니메이션 다시 시작
  el.classList.add('bump');
}

function formatClock(sec) {
  const s = Math.max(0, Math.ceil(sec - 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function hudState() {
  const tm = app.timer;
  if (app.mode === 'file') {
    const v = els.video;
    const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    const playing = app.uiState === 'running' && !v.paused;
    return { phase: playing ? 'round' : 'paused', label: playing ? '영상 분석' : '멈춤', time: formatClock(v.currentTime), progress: d ? 1 - v.currentTime / d : 1 };
  }
  if (app.mode === 'idle' || tm.phase === 'idle') {
    return { phase: 'idle', label: '시작 전', time: formatClock(tm.roundSec), progress: 1 };
  }
  const now = timerNow();
  const remaining = tm.remaining(now);
  const progress = tm.isActive() ? 1 - tm.progress(now) : 0;
  let phase = tm.phase, label;
  if (tm.phase === 'ready') label = '준비';
  else if (tm.phase === 'round') label = `${tm.round}/${tm.rounds}라운드`;
  else if (tm.phase === 'rest') label = '휴식';
  else { phase = 'idle'; label = '끝'; }
  if (tm.paused) { phase = 'paused'; label = '일시정지'; }
  return { phase, label, time: tm.phase === 'done' ? '0:00' : formatClock(remaining), progress };
}

function updateHud() {
  const h = hudState();
  const a = app.analyzer;
  const counts = a.countTypes(a.punches);
  const hooks = counts.leadHook + counts.rearHook, uppers = counts.leadUpper + counts.rearUpper;
  const mix = `잽 ${counts.jab} · 스트 ${counts.cross} · 훅 ${hooks} · 어퍼 ${uppers}`;
  const values = { phase: h.phase, label: h.label, time: h.time, offset: (RING_CIRCUMFERENCE * (1 - h.progress)).toFixed(1), total: a.punches.length, mix };
  const s = app.shown;
  if (values.phase !== s.phase) { els.ring.dataset.phase = values.phase; els.phaseLabel.dataset.phase = values.phase; }
  if (values.label !== s.label) els.phaseLabel.textContent = values.label;
  if (values.time !== s.time) els.timeText.textContent = values.time;
  if (values.offset !== s.offset) els.ringFill.style.strokeDashoffset = values.offset;
  if (values.total !== s.total) els.punchNum.textContent = String(values.total);
  if (values.mix !== s.mix) els.hudMix.textContent = values.mix;
  app.shown = values;

  // 큰 숫자 카운트다운: 시작 전 준비 시간 내내, 휴식은 마지막 3초
  const tm = app.timer;
  if (app.mode !== 'file' && !tm.paused && (tm.phase === 'ready' || (tm.phase === 'rest' && tm.remaining(timerNow()) <= 3))) {
    const n = Math.ceil(tm.remaining(timerNow()) - 1e-6);
    if (n > 0) showCountdown(n); else hideCountdown();
  } else if (app.countdownShown !== null) hideCountdown();

  // 콤비: 이어지는 중이거나 방금 끝난 것
  const nowMs = performance.now();
  const liveCombo = a.combo && a.combo.nums.length >= 2 ? a.combo.nums.join('-') : '';
  const comboText = app.uiState === 'running' ? liveCombo || (nowMs < app.comboUntil ? app.comboKey : '') : '';
  if (comboText) {
    if (els.comboText.textContent !== comboText) {
      els.comboText.textContent = comboText;
      els.comboBox.classList.remove('show');
      void els.comboBox.offsetWidth;
      els.comboBox.classList.add('show');
    }
    els.comboBox.hidden = false;
  } else if (!els.comboBox.hidden) els.comboBox.hidden = true;

  if (app.cue && nowMs > app.cue.until) hideCue();
  setStageAlert(isCounting() && (a.live.guardLow.L || a.live.guardLow.R) && Boolean(app.cue && app.cue.issue === 'guardLow'));
}

function computeTip() {
  const a = app.analyzer;
  const frame = app.lastFrame;
  const poseAvailable = app.mode === 'demo' || Boolean(app.pose);
  if (!poseAvailable) return { tone: 'warn', text: 'AI 모델이 없어서 펀치는 못 세고 라운드 시계만 돌아가요.' };
  if (app.mode === 'file' && app.uiState === 'ready') return { tone: 'info', text: '"분석 시작"을 누르면 0.5배속으로 보면서 펀치를 세요.' };
  if (app.mode !== 'demo' && app.running && performance.now() - app.lastPoseSeenAt > 1500) {
    return { tone: 'warn', text: '사람이 안 보여요. 머리부터 발끝까지 나오게 2~3m 뒤로 가 주세요.' };
  }
  if (a.view === 'side') return { tone: 'warn', text: '몸이 옆으로 돌아 있어요. 카메라를 정면으로 보고 서세요.' };
  if (frame && frame.headCut) return { tone: 'warn', text: '머리가 화면 밖으로 나가요. 폰을 조금 더 멀리 두세요.' };
  if (app.timer.paused) return { tone: 'info', text: '일시정지했어요. 준비되면 "계속"을 누르세요.' };
  if (app.timer.phase === 'rest') {
    const last = a.rounds[a.rounds.length - 1];
    if (last) return { tone: 'info', text: `휴식. 지난 라운드 펀치 ${last.punches}개${last.topIssue ? ` · ${ISSUES[last.topIssue].label}` : ''}` };
    return { tone: 'info', text: '휴식 중이에요.' };
  }
  if (app.cue && performance.now() < app.cue.until + 2500) return { tone: 'warn', text: ISSUES[app.cue.issue].tip };
  if (app.mode === 'camera' && app.uiState === 'ready') {
    if (frame && frame.feetCut) return { tone: 'info', text: '발까지 나오면 스탠스도 봐요. 준비되면 "라운드 시작"(10초 뒤 시작).' };
    return { tone: 'info', text: '자세가 잡히면 "라운드 시작"을 누르고 뒤로 가세요. 10초 뒤 공이 울려요.' };
  }
  if (app.timer.phase === 'ready') return { tone: 'info', text: '가드 올리고 준비하세요. 공이 울리면 시작이에요.' };
  if (frame && frame.feetCut) return { tone: 'info', text: '발이 잘려서 스탠스는 안 봐요. 폰을 조금 더 멀리 두면 같이 봐요.' };
  if (isCounting()) {
    const roundPunches = a.round ? a.punches.length - a.round.firstPunch : a.punches.length;
    const guardUp = !(a.live.guardLow.L || a.live.guardLow.R);
    return { tone: guardUp ? 'good' : 'warn', text: `${guardUp ? '가드 OK' : '가드가 낮아요'} · 이번 라운드 ${roundPunches}펀치` };
  }
  return { tone: 'info', text: '펀치를 치면 종류와 개수를 세요. 문제가 반복되면 말로 알려 줘요.' };
}

// 깜빡임을 막으려고 0.4초에 한 번만 갱신(큐가 나오면 즉시)
function updateTip(force) {
  const now = performance.now();
  if (!force && now - app.lastTipAt < 400) return;
  app.lastTipAt = now;
  const tip = computeTip();
  if (els.tipBar.dataset.tone !== tip.tone) els.tipBar.dataset.tone = tip.tone;
  if (els.tipText.textContent !== tip.text) els.tipText.textContent = tip.text;
}

function appendEl(parent, tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  parent.append(el);
  return el;
}

function renderSets() {
  const rounds = app.analyzer.rounds;
  els.setsList.replaceChildren();
  if (!rounds.length) {
    appendEl(els.setsList, 'span', 'muted small-text', app.mode === 'file' ? '영상 분석이 끝나면 펀치 수가 여기 나와요.' : '라운드가 끝날 때마다 펀치 수가 여기 쌓여요.');
    els.setsMeta.hidden = true;
    els.setsBadge.hidden = true;
    return;
  }
  els.setsBadge.hidden = false;
  els.setsBadge.textContent = app.mode === 'file' ? '영상' : `${rounds.length}라운드`;
  const best = Math.max(...rounds.map((r) => r.punches));
  for (const r of rounds) {
    const pill = appendEl(els.setsList, 'span', rounds.length > 1 && r.punches === best ? 'set-pill best' : 'set-pill');
    appendEl(pill, 'small', '', app.mode === 'file' ? '영상' : `${r.index}R`);
    pill.append(document.createTextNode(String(r.punches)));
    pill.title = r.topIssue ? ISSUES[r.topIssue].label : '';
  }
  const avg = rounds.reduce((s, r) => s + r.punches, 0) / rounds.length;
  const guardRounds = rounds.filter((r) => r.guardUp !== null);
  const guard = guardRounds.length ? Math.round((guardRounds.reduce((s, r) => s + r.guardUp, 0) / guardRounds.length) * 100) : null;
  els.setsMeta.hidden = false;
  els.setsMeta.textContent = `라운드 평균 ${avg.toFixed(0)}펀치${guard !== null ? ` · 쉴 때 가드 유지 ${guard}%` : ''}`;
}

// 가드·팔꿈치는 펀치를 안 칠 때만 재므로 '쉬는 시간' 기준
const IDLE_BASED_ISSUES = new Set(['guardLow', 'elbowFlare']);

function describeReturn(sec) {
  const label = sec < 0.15 ? '빠른 편' : sec <= CONFIG.returnSlowSec ? '보통' : '느린 편';
  return `${sec.toFixed(2)}초 · ${label}`;
}

function describeStance(ratio) {
  if (ratio < CONFIG.stance.narrow) return '좁음(일직선에 가까움)';
  if (ratio > CONFIG.stance.wide) return '넓음';
  return '적당함';
}

function renderSummary() {
  const s = app.analyzer.summary();
  const body = els.summaryBody;
  body.replaceChildren();
  els.summaryCard.hidden = false;
  if (!s.total) {
    appendEl(body, 'p', 'muted', '기록된 펀치가 없어요. 위의 "사람 인식"이 초록색인지, 머리부터 발끝까지 화면에 나오는지 확인하고 다시 해 보세요.');
    return;
  }

  const grid = appendEl(body, 'div', 'stat-grid');
  const stat = (label, value, hero = false) => {
    const box = appendEl(grid, 'div', hero ? 'stat hero' : 'stat');
    appendEl(box, 'span', '', label);
    appendEl(box, 'b', '', value);
  };
  stat('총 펀치', String(s.total), true);
  stat('분당 펀치', s.perMinute !== null ? String(Math.round(s.perMinute)) : '–');
  stat(app.mode === 'file' ? '분석한 시간' : '라운드', app.mode === 'file' ? formatClock(s.activeSeconds) : String(s.rounds.length || 1));
  stat('쉴 때 가드', s.guardUp !== null ? `${Math.round(s.guardUp * 100)}%` : '–');

  const kinds = appendEl(body, 'div', 'summary-section');
  appendEl(kinds, 'h3', '', '펀치 종류');
  for (const key of PUNCH_ORDER) {
    const count = s.counts[key];
    if (!count) continue;
    const row = appendEl(kinds, 'div', 'part-row');
    appendEl(row, 'span', '', PUNCH_TYPES[key].label);
    const bar = appendEl(row, 'div', 'part-bar');
    const fill = appendEl(bar, 'i');
    fill.style.width = `${Math.round((count / s.total) * 100)}%`;
    appendEl(row, 'output', '', String(count));
  }

  if (s.combos.top.length) {
    const combos = appendEl(body, 'div', 'summary-section');
    appendEl(combos, 'h3', '', `자주 쓴 콤비네이션 · 펀치의 ${Math.round(s.combos.comboShare * 100)}%가 콤비`);
    const list = appendEl(combos, 'div', 'combo-list');
    for (const c of s.combos.top) {
      const pill = appendEl(list, 'span', 'combo-pill', c.key);
      appendEl(pill, 'small', '', `×${c.count}`);
    }
  }

  const facts = appendEl(body, 'div', 'summary-section');
  appendEl(facts, 'h3', '', '자세 수치');
  const list = appendEl(facts, 'ul', 'fact-list');
  const fact = (label, value) => {
    const li = appendEl(list, 'li');
    appendEl(li, 'span', 'fact-label', label);
    appendEl(li, 'span', 'fact-value', value);
  };
  if (s.otherHandUp !== null) fact('칠 때 반대손 가드', `${Math.round(s.otherHandUp * 100)}% 유지`);
  if (s.avgReturn !== null) fact('회수(60% 돌아올 때까지)', describeReturn(s.avgReturn));
  if (s.chinUpRate !== null) fact('턱 들린 시간', `${Math.round(s.chinUpRate * 100)}%`);
  if (s.stanceRatio !== null) fact('발 좌우 간격', describeStance(s.stanceRatio));
  if (s.kneeStiffRate !== null) fact('무릎 펴진 시간(참고용)', `${Math.round(s.kneeStiffRate * 100)}%`);

  const issues = appendEl(body, 'div', 'summary-section');
  appendEl(issues, 'h3', '', '고칠 점');
  const top = s.issues.filter((i) => i.rate >= 0.2).slice(0, 3);
  if (!top.length) {
    appendEl(issues, 'p', 'muted', '반복해서 나온 자세 문제는 없었어요.');
  } else {
    // 자주 나온 순서대로 번호(1이 가장 먼저 고칠 것)
    top.forEach((item, rank) => {
      const info = ISSUES[item.key];
      const box = appendEl(issues, 'div', 'issue');
      appendEl(box, 'span', 'issue-rank', String(rank + 1));
      const content = appendEl(box, 'div');
      const head = appendEl(content, 'div', 'issue-head');
      const title = appendEl(head, 'strong', '', info.label);
      if (info.confidence === 'low') appendEl(title, 'span', 'conf', '참고용');
      appendEl(head, 'span', 'issue-rate', `${Math.round(item.rate * 100)}%`);
      const pct = Math.round(item.rate * 100);
      const basis = item.count !== null ? `${item.base}번 중 ${item.count}번` : IDLE_BASED_ISSUES.has(item.key) ? `쉬는 시간의 ${pct}%` : `전체 시간의 ${pct}%`;
      appendEl(content, 'p', '', `${info.detail} (${basis})`);
    });
  }
  const notes = [];
  if (s.view === 'side') notes.push('옆으로 선 시간이 길어서 뒷손이 가려졌을 수 있어요.');
  notes.push('정면 카메라라 카메라 쪽으로 뻗는 움직임은 AI가 깊이를 추정해요. 빠른 잽은 놓칠 수 있어요.');
  appendEl(body, 'p', 'muted small-text', notes.join(' '));
}

// ===== 버튼 터치 임팩트: 누른 자리에서 물결 + 짧은 진동(지원 기기만) =====
function addPressFeedback(button) {
  button.addEventListener('pointerdown', (event) => {
    if (button.disabled || event.button > 0) return;
    if (typeof navigator.vibrate === 'function') {
      try { navigator.vibrate(8); } catch { /* 진동 미지원 */ }
    }
    if (reduceMotion.matches) return;
    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2.2;
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
    button.append(ripple);
    ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
  });
}
document.querySelectorAll('.btn').forEach(addPressFeedback);

// ===== 버튼 연결 =====
els.btnCamera.addEventListener('click', startCameraSession);
els.btnUpload.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files && els.fileInput.files[0];
  els.fileInput.value = '';   // 같은 파일을 다시 골라도 change가 나도록
  if (file) startFileSession(file);
});
els.btnDemo.addEventListener('click', startDemoSession);
els.btnPlay.addEventListener('click', startRounds);
els.btnPause.addEventListener('click', togglePause);
els.btnFlip.addEventListener('click', flipCamera);
els.btnStop.addEventListener('click', () => (app.uiState === 'ready' ? newSession() : finishSession()));
els.btnNewSession.addEventListener('click', newSession);

applySettingsToUi();
setUiState('idle');
updateHud();
layoutStage();
// 테스트용(브라우저 자동 테스트에서 상태 확인)
window.__boxingApp = app;
