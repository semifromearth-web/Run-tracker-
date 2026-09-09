/* ---------- storage keys ---------- */
const STORE_KEY = 'runtracker_runs';
const UNIT_KEY = 'runtracker_unit';

function loadRuns() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch { return []; }
}
function saveRuns(runs) {
  localStorage.setItem(STORE_KEY, JSON.stringify(runs));
}

/* ---------- units ---------- */
let unit = localStorage.getItem(UNIT_KEY) === 'mi' ? 'mi' : 'km';
const KM_PER_MI = 1.60934;

function toDisplayDistance(km) { return unit === 'mi' ? km / KM_PER_MI : km; }
function toDisplayPaceSec(secPerKm) { return unit === 'mi' ? secPerKm * KM_PER_MI : secPerKm; }
function splitUnitKm() { return unit === 'mi' ? KM_PER_MI : 1; }

/* ---------- math / format helpers ---------- */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function formatTime(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatHoursMinutes(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.round((totalSec % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function formatPace(secPerUnit) {
  if (!isFinite(secPerUnit) || secPerUnit <= 0) return '–:––';
  const m = Math.floor(secPerUnit / 60);
  const s = Math.round(secPerUnit % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) +
         ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- route drawing (raw GPS points, no map tiles) ---------- */
/* Points carry a `seg` (segment) index — a new segment starts every time a run
   resumes from a pause, so the drawn route never draws a straight line across
   a pause gap. */
function drawRoute(canvas, points, strokeColor) {
  if (!points || !points.length) return;
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  if (points.length < 2) {
    ctx.fillStyle = '#6FE3B4';
    ctx.beginPath(); ctx.arc(rect.width / 2, rect.height / 2, 4, 0, Math.PI * 2); ctx.fill();
    return;
  }

  const lats = points.map(p => p.lat), lngs = points.map(p => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const pad = 18;
  const spanLat = (maxLat - minLat) || 0.0001;
  const spanLng = (maxLng - minLng) || 0.0001;
  const scale = Math.min((rect.width - pad * 2) / spanLng, (rect.height - pad * 2) / spanLat);
  const offX = (rect.width - spanLng * scale) / 2;
  const offY = (rect.height - spanLat * scale) / 2;
  const toXY = p => [offX + (p.lng - minLng) * scale, rect.height - (offY + (p.lat - minLat) * scale)];

  ctx.strokeStyle = strokeColor || '#378ADD';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  let curSeg = null;
  ctx.beginPath();
  points.forEach(p => {
    const [x, y] = toXY(p);
    if (p.seg !== curSeg) { ctx.moveTo(x, y); curSeg = p.seg; }
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  const [sx, sy] = toXY(points[0]);
  const [ex, ey] = toXY(points[points.length - 1]);
  ctx.fillStyle = '#6FE3B4';
  ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#E2574B';
  ctx.beginPath(); ctx.arc(ex, ey, 4, 0, Math.PI * 2); ctx.fill();
}

function drawManualPlaceholder(canvas) {
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.strokeStyle = '#3A3E46';
  ctx.lineWidth = 2;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.arc(rect.width / 2, rect.height / 2, rect.width / 2 - 4, 0, Math.PI * 2);
  ctx.stroke();
}

function simplifyPoints(pts, maxPoints) {
  if (pts.length <= maxPoints) return pts;
  const step = pts.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(pts[Math.floor(i * step)]);
  out.push(pts[pts.length - 1]);
  return out;
}

/* ---------- GPX export ---------- */
function buildGPX(run) {
  const trkpts = (run.points || []).map(p => {
    const timeIso = new Date(p.t).toISOString();
    const eleTag = (p.alt != null) ? `<ele>${p.alt.toFixed(1)}</ele>` : '';
    return `<trkpt lat="${p.lat}" lon="${p.lng}">${eleTag}<time>${timeIso}</time></trkpt>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Runtracker" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>Run ${new Date(run.date).toISOString()}</name><trkseg>${trkpts}</trkseg></trk>\n</gpx>`;
}

/* ---------- audio cues ---------- */
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.15;
    o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 180);
  } catch { /* no audio available, silently skip */ }
}
function speak(text) {
  if (!('speechSynthesis' in window)) { beep(); return; }
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1; u.pitch = 1;
    speechSynthesis.speak(u);
  } catch { beep(); }
}

/* ---------- element refs ---------- */
const els = {};
['idle-panel','active-panel','gps-badge','gps-badge-text','error-slot','btn-start',
 'btn-pause','btn-finish','run-date','live-indicator','live-text','stat-time',
 'route-box','route-canvas','route-empty','stat-distance','stat-pace','stat-elev','live-splits',
 'view-track','view-history','view-squad','view-settings',
 'tab-track','tab-history','tab-squad','tab-settings','history-list',
 'unit-toggle','btn-manual-open','btn-manual-open-2','manual-backdrop','manual-date',
 'manual-distance','manual-unit-label','manual-h','manual-m','manual-s','manual-error',
 'btn-manual-cancel','btn-manual-save','toast','totals-row','totals-week-dist',
 'totals-week-time','totals-month-dist','totals-month-time',
 'records-row','record-pace','record-distance','streak-wrap','streak-grid',
 'treadmill-panel','btn-treadmill-open','btn-treadmill-cancel','btn-treadmill-start',
 'treadmill-pace','treadmill-error','treadmill-unit-label',
 'toggle-theme','toggle-autopause','toggle-audio','toggle-notify',
 'btn-export-data','import-file','data-status',
 'supabase-url','supabase-key','btn-supabase-save','supabase-status',
 'squad-unconfigured','squad-join','squad-name','squad-code','btn-squad-join',
 'squad-board','squad-code-label','btn-squad-leave','squad-list','btn-squad-refresh']
 .forEach(id => els[id] = document.getElementById(id));

/* ---------- toast ---------- */
let toastTimer = null;
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2400);
}

/* ---------- theme ---------- */
let themeOn = localStorage.getItem('runtracker_theme') === 'light';
function applyTheme() {
  document.documentElement.setAttribute('data-theme', themeOn ? 'light' : 'dark');
  els['toggle-theme'].classList.toggle('on', themeOn);
}
els['toggle-theme'].addEventListener('click', () => {
  themeOn = !themeOn;
  localStorage.setItem('runtracker_theme', themeOn ? 'light' : 'dark');
  applyTheme();
});

/* ---------- autopause / audio / notify toggles ---------- */
let autopauseEnabled = localStorage.getItem('runtracker_autopause') !== 'off';
function applyAutopauseToggle() { els['toggle-autopause'].classList.toggle('on', autopauseEnabled); }
els['toggle-autopause'].addEventListener('click', () => {
  autopauseEnabled = !autopauseEnabled;
  localStorage.setItem('runtracker_autopause', autopauseEnabled ? 'on' : 'off');
  applyAutopauseToggle();
});

let audioEnabled = localStorage.getItem('runtracker_audio') === 'on';
function applyAudioToggle() { els['toggle-audio'].classList.toggle('on', audioEnabled); }
els['toggle-audio'].addEventListener('click', () => {
  audioEnabled = !audioEnabled;
  localStorage.setItem('runtracker_audio', audioEnabled ? 'on' : 'off');
  applyAudioToggle();
  if (audioEnabled) speak('Audio cues on');
});

let notifyEnabled = localStorage.getItem('runtracker_notify') === 'on';
function applyNotifyToggle() { els['toggle-notify'].classList.toggle('on', notifyEnabled); }
async function ensureNotifyPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}
async function updateTrackingNotification() {
  if (!notifyEnabled || !('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg.showNotification) return;
    const distKm = totalDistanceKm();
    const distText = toDisplayDistance(distKm).toFixed(2) + ' ' + unit;
    reg.showNotification('Runtracker', {
      body: `${distText} · ${formatTime(elapsedMs / 1000)}`,
      tag: 'runtracker-live', silent: true, icon: 'icon-192.png'
    }).catch(() => {});
  } catch { /* service worker not ready yet — skip this update */ }
}
function closeTrackingNotification() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.ready
    .then(reg => reg.getNotifications({ tag: 'runtracker-live' }).then(ns => ns.forEach(n => n.close())))
    .catch(() => {});
}
els['toggle-notify'].addEventListener('click', async () => {
  if (!notifyEnabled) {
    const ok = await ensureNotifyPermission();
    if (!ok) { showToast('Notifications blocked — enable them for this site in your browser settings.'); return; }
    notifyEnabled = true;
  } else {
    notifyEnabled = false;
    closeTrackingNotification();
  }
  localStorage.setItem('runtracker_notify', notifyEnabled ? 'on' : 'off');
  applyNotifyToggle();
});

/* ---------- unit toggle ---------- */
function applyUnitLabel() {
  els['unit-toggle'].textContent = unit;
  els['manual-unit-label'].textContent = unit;
  els['treadmill-unit-label'].textContent = unit;
}
function toggleUnit() {
  unit = unit === 'km' ? 'mi' : 'km';
  localStorage.setItem(UNIT_KEY, unit);
  applyUnitLabel();
  nextSplitBoundaryKm = (Math.floor(totalDistanceKm() / splitUnitKm()) + 1) * splitUnitKm();
  if (els['active-panel'].style.display !== 'none') updateStats();
  if (els['view-history'].classList.contains('active')) renderHistory();
  if (els['view-squad'].classList.contains('active') && squadCode) fetchSquadLeaderboard();
}

/* ---------- GPS readiness check ---------- */
function checkGps() {
  if (!('geolocation' in navigator)) {
    els['gps-badge'].className = 'gps-badge error';
    els['gps-badge-text'].textContent = 'GPS not supported on this device';
    return;
  }
  navigator.geolocation.getCurrentPosition(
    () => {
      els['gps-badge'].className = 'gps-badge ready';
      els['gps-badge-text'].textContent = 'GPS ready';
    },
    (err) => {
      els['gps-badge'].className = 'gps-badge error';
      els['gps-badge-text'].textContent = err.code === 1 ? 'Location permission denied' : 'GPS unavailable';
      if (err.code === 1) {
        els['error-slot'].innerHTML = '<div class="error-banner">Turn on location access for this site in your browser settings to track runs.</div>';
      }
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

/* ---------- tracking state ---------- */
let watchId = null;
let points = [];
let elapsedMs = 0;
let lastTickTs = null;
let tickTimer = null;
let elevGain = 0;
let pauseReason = null;      // null | 'manual' | 'auto'
let wakeLock = null;
let currentSeg = 0;
let lastMovementTs = 0;
let lastNotifyTs = 0;

let treadmillActive = false;
let treadmillPaceSecPerUnit = 0;

let splits = [];
let lastSplitElapsedS = 0;
let nextSplitBoundaryKm = splitUnitKm();

const MAX_ACCURACY_M = 30;
const MAX_JUMP_MPS = 12;
const MOVEMENT_EPS_M = 2;
const AUTO_PAUSE_MS = 12000;
const AUTO_RESUME_M = 8;

/* ---------- wake lock ---------- */
async function acquireWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); }
  catch { /* unsupported or denied — tracking still works, screen may just sleep */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && pauseReason === null && (watchId != null || treadmillActive)) acquireWakeLock();
});

/* ---------- distance (GPS or treadmill) ---------- */
function totalDistanceKm() {
  if (treadmillActive) {
    const elapsedS = elapsedMs / 1000;
    const distInUnit = treadmillPaceSecPerUnit > 0 ? elapsedS / treadmillPaceSecPerUnit : 0;
    return unit === 'mi' ? distInUnit * KM_PER_MI : distInUnit;
  }
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].seg === points[i - 1].seg) d += haversine(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  }
  return d / 1000;
}

/* ---------- run lifecycle: GPS ---------- */
function startRun() {
  treadmillActive = false;
  points = []; elapsedMs = 0; elevGain = 0; pauseReason = null;
  splits = []; lastSplitElapsedS = 0; currentSeg = 0; nextSplitBoundaryKm = splitUnitKm();
  lastMovementTs = Date.now();
  els['idle-panel'].style.display = 'none';
  els['treadmill-panel'].style.display = 'none';
  els['active-panel'].style.display = 'block';
  els['route-box'].style.display = 'block';
  els['run-date'].textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  els['route-empty'].style.display = 'flex';
  els['live-splits'].innerHTML = '';
  els['btn-pause'].textContent = 'Pause';
  els['btn-pause'].className = 'btn btn-pause';
  updateStats();
  beginWatch();
  beginTimer();
  acquireWakeLock();
}

function beginWatch() {
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true, maximumAge: 1000, timeout: 15000
  });
}

function onPositionError(err) {
  els['live-indicator'].className = 'live paused';
  els['live-text'].textContent = err.code === 1 ? 'Permission lost' : 'Signal lost';
}

function autoResumeFromMovement(point) {
  pauseReason = null;
  currentSeg += 1;
  point.seg = currentSeg;
  lastMovementTs = Date.now();
  els['btn-pause'].textContent = 'Pause';
  els['btn-pause'].className = 'btn btn-pause';
  els['live-indicator'].className = 'live';
  els['live-text'].textContent = 'Tracking';
  points.push(point);
  updateStats(); checkSplit(); drawRoute(els['route-canvas'], points);
}

function onPosition(pos) {
  if (treadmillActive) return;
  const { latitude, longitude, altitude, accuracy } = pos.coords;
  if (accuracy != null && accuracy > MAX_ACCURACY_M) return;
  if (pauseReason === 'manual') return;

  const point = { lat: latitude, lng: longitude, alt: altitude, t: pos.timestamp, seg: currentSeg };
  const last = points[points.length - 1];
  const distM = last ? haversine(last.lat, last.lng, point.lat, point.lng) : 0;

  if (pauseReason === 'auto') {
    if (distM > AUTO_RESUME_M) autoResumeFromMovement(point);
    return;
  }

  els['live-indicator'].className = 'live';
  els['live-text'].textContent = 'Tracking';

  const sameSeg = last && last.seg === point.seg;
  if (sameSeg) {
    const dtS = Math.max((point.t - last.t) / 1000, 0.5);
    if (distM / dtS > MAX_JUMP_MPS) return;
    if (last.alt != null && point.alt != null) {
      const rise = point.alt - last.alt;
      if (rise > 0.5) elevGain += rise;
    }
    if (distM > MOVEMENT_EPS_M) lastMovementTs = Date.now();
  } else {
    lastMovementTs = Date.now();
  }

  points.push(point);
  els['route-empty'].style.display = 'none';
  updateStats();
  checkSplit();
  drawRoute(els['route-canvas'], points);
}

/* ---------- run lifecycle: treadmill ---------- */
function openTreadmillPanel() {
  els['idle-panel'].style.display = 'none';
  els['treadmill-panel'].style.display = 'block';
  els['treadmill-error'].style.display = 'none';
}
function closeTreadmillPanel() {
  els['treadmill-panel'].style.display = 'none';
  els['idle-panel'].style.display = 'block';
}
function startTreadmill() {
  const paceVal = parseFloat(els['treadmill-pace'].value);
  if (!paceVal || paceVal <= 0) {
    els['treadmill-error'].textContent = 'Enter a target pace above 0.';
    els['treadmill-error'].style.display = 'block';
    return;
  }
  treadmillActive = true;
  treadmillPaceSecPerUnit = paceVal * 60;
  points = []; elapsedMs = 0; elevGain = 0; pauseReason = null;
  splits = []; lastSplitElapsedS = 0; currentSeg = 0; nextSplitBoundaryKm = splitUnitKm();
  els['treadmill-panel'].style.display = 'none';
  els['active-panel'].style.display = 'block';
  els['route-box'].style.display = 'none';
  els['run-date'].textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) + ' · treadmill';
  els['live-splits'].innerHTML = '';
  els['btn-pause'].textContent = 'Pause';
  els['btn-pause'].className = 'btn btn-pause';
  updateStats();
  beginTimer();
  acquireWakeLock();
}

/* ---------- shared: splits, stats, timer, pause, finish ---------- */
function checkSplit() {
  const distKm = totalDistanceKm();
  if (distKm >= nextSplitBoundaryKm) {
    const elapsedS = elapsedMs / 1000;
    const durationS = elapsedS - lastSplitElapsedS;
    splits.push({ n: splits.length + 1, durationS });
    lastSplitElapsedS = elapsedS;
    nextSplitBoundaryKm += splitUnitKm();
    renderLiveSplits();
    if (audioEnabled) {
      const mins = Math.floor(durationS / 60), secs = Math.round(durationS % 60);
      speak(`${unit === 'mi' ? 'Mile' : 'Kilometer'} ${splits.length}, ${mins} minutes ${secs} seconds`);
    }
  }
}
function renderLiveSplits() {
  els['live-splits'].innerHTML = splits.map(s =>
    `<div class="split-row"><span>${s.n} ${unit}</span><b>${formatTime(s.durationS)}</b></div>`
  ).join('');
}

function updateStats() {
  const distKm = totalDistanceKm();
  els['stat-distance'].innerHTML = toDisplayDistance(distKm).toFixed(2) + `<span class="unit"> ${unit}</span>`;

  const elapsedS = elapsedMs / 1000;
  const paceSecPerKm = distKm > 0.02 ? elapsedS / distKm : NaN;
  els['stat-pace'].innerHTML = formatPace(toDisplayPaceSec(paceSecPerKm)) + `<span class="unit"> /${unit}</span>`;

  els['stat-elev'].innerHTML = (!treadmillActive && points.some(p => p.alt != null) ? Math.round(elevGain) : '–') + '<span class="unit"> m</span>';
  els['stat-time'].textContent = formatTime(elapsedS);

  if (notifyEnabled) {
    const now = Date.now();
    if (now - lastNotifyTs > 4000) { lastNotifyTs = now; updateTrackingNotification(); }
  }
}

function beginTimer() {
  lastTickTs = Date.now();
  lastNotifyTs = 0;
  tickTimer = setInterval(() => {
    const now = Date.now();
    if (pauseReason === null) {
      elapsedMs += now - lastTickTs;
      updateStats();
      if (!treadmillActive && autopauseEnabled && points.length > 0 && (now - lastMovementTs > AUTO_PAUSE_MS)) {
        triggerAutoPause();
      }
    }
    lastTickTs = now;
  }, 1000);
}

function triggerAutoPause() {
  pauseReason = 'auto';
  els['live-indicator'].className = 'live paused';
  els['live-text'].textContent = 'Auto-paused';
  els['btn-pause'].textContent = 'Resume';
  els['btn-pause'].className = 'btn btn-resume';
}

function togglePause() {
  if (pauseReason === null) {
    pauseReason = 'manual';
    els['btn-pause'].textContent = 'Resume';
    els['btn-pause'].className = 'btn btn-resume';
    els['live-indicator'].className = 'live paused';
    els['live-text'].textContent = 'Paused';
    releaseWakeLock();
  } else {
    pauseReason = null;
    currentSeg += 1;
    lastMovementTs = Date.now();
    lastTickTs = Date.now();
    els['btn-pause'].textContent = 'Pause';
    els['btn-pause'].className = 'btn btn-pause';
    els['live-indicator'].className = 'live';
    els['live-text'].textContent = 'Tracking';
    acquireWakeLock();
  }
}

function finishRun() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  clearInterval(tickTimer);
  watchId = null;
  releaseWakeLock();
  closeTrackingNotification();

  const distKm = totalDistanceKm();
  const validGpsRun = !treadmillActive && points.length >= 2 && distKm >= 0.05;
  const validTreadmillRun = treadmillActive && distKm >= 0.05;
  if (!validGpsRun && !validTreadmillRun) { resetToIdle(); return; }

  const elapsedS = elapsedMs / 1000;
  const finalPartial = elapsedS - lastSplitElapsedS;
  const remainingKm = distKm - (splits.length * splitUnitKm());
  if (remainingKm > 0.05) splits.push({ n: `+${toDisplayDistance(remainingKm).toFixed(2)}`, durationS: finalPartial });

  const run = {
    id: Date.now(),
    date: new Date().toISOString(),
    durationS: Math.round(elapsedS),
    distanceKm: Number(distKm.toFixed(3)),
    paceSecPerKm: elapsedS / distKm,
    elevGainM: (!treadmillActive && points.some(p => p.alt != null)) ? Math.round(elevGain) : null,
    points: treadmillActive ? [] : simplifyPoints(points, 120),
    splits: splits.map(s => ({ n: s.n, durationS: Math.round(s.durationS) })),
    manual: false,
    indoor: treadmillActive
  };
  const runs = loadRuns();
  runs.push(run);
  saveRuns(runs);
  pushRunToSquad(run);

  resetToIdle();
  switchTab('history');
}

function resetToIdle() {
  treadmillActive = false;
  els['active-panel'].style.display = 'none';
  els['treadmill-panel'].style.display = 'none';
  els['idle-panel'].style.display = 'block';
  els['btn-pause'].textContent = 'Pause';
  els['btn-pause'].className = 'btn btn-pause';
  checkGps();
}

/* ---------- manual entry ---------- */
function openManualModal() {
  els['manual-date'].value = new Date().toISOString().slice(0, 10);
  els['manual-distance'].value = '';
  els['manual-h'].value = '';
  els['manual-m'].value = '';
  els['manual-s'].value = '';
  els['manual-error'].style.display = 'none';
  els['manual-backdrop'].classList.add('open');
}
function closeManualModal() { els['manual-backdrop'].classList.remove('open'); }
function saveManualRun() {
  const dateStr = els['manual-date'].value;
  const distVal = parseFloat(els['manual-distance'].value);
  const h = parseInt(els['manual-h'].value, 10) || 0;
  const m = parseInt(els['manual-m'].value, 10) || 0;
  const s = parseInt(els['manual-s'].value, 10) || 0;
  const durationS = h * 3600 + m * 60 + s;

  if (!dateStr || !distVal || distVal <= 0 || durationS <= 0) {
    els['manual-error'].textContent = 'Add a date, a distance above 0, and a duration above 0.';
    els['manual-error'].style.display = 'block';
    return;
  }

  const distanceKm = unit === 'mi' ? distVal * KM_PER_MI : distVal;
  const run = {
    id: Date.now(),
    date: new Date(dateStr + 'T12:00:00').toISOString(),
    durationS,
    distanceKm: Number(distanceKm.toFixed(3)),
    paceSecPerKm: durationS / distanceKm,
    elevGainM: null,
    points: [],
    splits: null,
    manual: true,
    indoor: false
  };
  const runs = loadRuns();
  runs.push(run);
  saveRuns(runs);
  pushRunToSquad(run);
  closeManualModal();
  showToast('Run saved');
  switchTab('history');
}

/* ---------- share ---------- */
function shareRun(run) {
  const dist = toDisplayDistance(run.distanceKm).toFixed(2);
  const pace = formatPace(toDisplayPaceSec(run.paceSecPerKm));
  let text = `${dist} ${unit} run on ${formatDate(run.date)} — ${formatTime(run.durationS)}, avg pace ${pace}/${unit}`;
  if (run.elevGainM) text += `, +${run.elevGainM}m elevation gain`;
  if (navigator.share) {
    navigator.share({ text }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard')).catch(() => showToast(text));
  } else {
    showToast(text);
  }
}

/* ---------- totals / records / streak ---------- */
function startOfWeek(d) {
  const day = (d.getDay() + 6) % 7;
  const s = new Date(d); s.setHours(0, 0, 0, 0); s.setDate(d.getDate() - day);
  return s;
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

function renderTotals(runs) {
  if (!runs.length) { els['totals-row'].style.display = 'none'; return; }
  els['totals-row'].style.display = 'grid';
  const now = new Date();
  const wStart = startOfWeek(now), mStart = startOfMonth(now);
  let wDist = 0, wTime = 0, mDist = 0, mTime = 0;
  runs.forEach(r => {
    const d = new Date(r.date);
    if (d >= mStart) { mDist += r.distanceKm; mTime += r.durationS; }
    if (d >= wStart) { wDist += r.distanceKm; wTime += r.durationS; }
  });
  els['totals-week-dist'].innerHTML = toDisplayDistance(wDist).toFixed(1) + `<span class="unit"> ${unit}</span>`;
  els['totals-week-time'].textContent = formatHoursMinutes(wTime);
  els['totals-month-dist'].innerHTML = toDisplayDistance(mDist).toFixed(1) + `<span class="unit"> ${unit}</span>`;
  els['totals-month-time'].textContent = formatHoursMinutes(mTime);
}

function renderRecords(runs) {
  const eligible = runs.filter(r => r.distanceKm >= 1);
  if (!runs.length) { els['records-row'].style.display = 'none'; return; }
  els['records-row'].style.display = 'grid';
  if (eligible.length) {
    const bestPace = eligible.reduce((a, b) => a.paceSecPerKm < b.paceSecPerKm ? a : b);
    els['record-pace'].innerHTML = formatPace(toDisplayPaceSec(bestPace.paceSecPerKm)) + `<span class="unit"> /${unit}</span>`;
  } else {
    els['record-pace'].innerHTML = `–:––<span class="unit"> /${unit}</span>`;
  }
  const longest = runs.reduce((a, b) => a.distanceKm > b.distanceKm ? a : b);
  els['record-distance'].innerHTML = toDisplayDistance(longest.distanceKm).toFixed(2) + `<span class="unit"> ${unit}</span>`;
}

function renderStreak(runs) {
  if (!runs.length) { els['streak-wrap'].style.display = 'none'; return; }
  els['streak-wrap'].style.display = 'block';
  const days = new Set(runs.map(r => new Date(r.date).toDateString()));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const totalDays = 70;
  const cells = [];
  for (let i = totalDays - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    cells.push(days.has(d.toDateString()));
  }
  let html = '';
  for (let w = 0; w < 10; w++) {
    html += '<div class="streak-col">';
    for (let d = 0; d < 7; d++) html += `<div class="streak-cell${cells[w * 7 + d] ? ' hit' : ''}"></div>`;
    html += '</div>';
  }
  els['streak-grid'].innerHTML = html;
}

/* ---------- history view ---------- */
function renderHistory() {
  const runs = loadRuns().sort((a, b) => new Date(b.date) - new Date(a.date));
  renderTotals(runs);
  renderRecords(runs);
  renderStreak(runs);

  if (!runs.length) {
    els['history-list'].innerHTML = `<div class="empty-state">
      <p>No runs yet.<br>Start one from the Track tab, or log a past run by hand.</p>
    </div>`;
    return;
  }

  els['history-list'].innerHTML = '';
  runs.forEach(run => {
    const row = document.createElement('div');
    row.className = 'run-row';
    const dist = toDisplayDistance(run.distanceKm).toFixed(2);
    const pace = formatPace(toDisplayPaceSec(run.paceSecPerKm));
    const tag = run.manual ? ' · manual' : (run.indoor ? ' · treadmill' : '');
    row.innerHTML = `
      <canvas class="sparkline"></canvas>
      <div class="info">
        <p class="date">${formatDate(run.date)}${tag}</p>
        <p class="metrics">
          <b>${dist}<span> ${unit}</span></b>
          <b>${formatTime(run.durationS)}<span> time</span></b>
          <b>${pace}<span> /${unit}</span></b>
        </p>
      </div>
      <button class="delete-btn" aria-label="Delete run">&times;</button>
      <div class="run-detail" id="detail-${run.id}"></div>
    `;
    const canvas = row.querySelector('canvas');
    requestAnimationFrame(() => {
      if (run.points && run.points.length) drawRoute(canvas, run.points, '#9A9DA6');
      else drawManualPlaceholder(canvas);
    });

    row.querySelector('.info').addEventListener('click', () => toggleDetail(run));
    row.querySelector('.delete-btn').addEventListener('click', () => {
      if (confirm('Delete this run? This can\'t be undone.')) {
        saveRuns(loadRuns().filter(r => r.id !== run.id));
        renderHistory();
      }
    });
    els['history-list'].appendChild(row);
  });
}

function toggleDetail(run) {
  const detail = document.getElementById(`detail-${run.id}`);
  const isOpen = detail.classList.contains('open');
  document.querySelectorAll('.run-detail.open').forEach(d => d.classList.remove('open'));
  if (isOpen) return;

  let splitsHtml = '';
  if (run.splits && run.splits.length) {
    splitsHtml = run.splits.map(s => `<div class="split-row"><span>${s.n} ${unit}</span><b>${formatTime(s.durationS)}</b></div>`).join('');
  } else if (run.manual) {
    splitsHtml = `<div class="split-row"><span>Logged manually — no splits</span></div>`;
  } else if (run.indoor) {
    splitsHtml = `<div class="split-row"><span>Treadmill run — no GPS route</span></div>`;
  }
  const gpxBtn = (run.points && run.points.length) ? `<button class="share-btn" id="gpx-btn-${run.id}">Export GPX</button>` : '';
  detail.innerHTML = splitsHtml + `<button class="share-btn" id="share-btn-${run.id}">Share this run</button>` + gpxBtn;
  detail.querySelector(`#share-btn-${run.id}`).addEventListener('click', () => shareRun(run));
  const gpxEl = document.getElementById(`gpx-btn-${run.id}`);
  if (gpxEl) gpxEl.addEventListener('click', () => downloadFile(`run-${run.date.slice(0, 10)}.gpx`, buildGPX(run), 'application/gpx+xml'));
  detail.classList.add('open');
}

/* ---------- backup / restore ---------- */
function exportAllData() {
  const payload = { version: 1, exportedAt: new Date().toISOString(), runs: loadRuns() };
  downloadFile(`runtracker-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), 'application/json');
  els['data-status'].textContent = 'Backup downloaded.';
}
function handleImportFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const incoming = Array.isArray(parsed) ? parsed : parsed.runs;
      if (!Array.isArray(incoming)) throw new Error('bad format');
      const existing = loadRuns();
      const existingIds = new Set(existing.map(r => r.id));
      let added = 0;
      incoming.forEach(r => { if (r && r.id && !existingIds.has(r.id)) { existing.push(r); existingIds.add(r.id); added++; } });
      saveRuns(existing);
      els['data-status'].textContent = `Imported ${added} run${added === 1 ? '' : 's'}.`;
      renderHistory();
    } catch {
      els['data-status'].textContent = "Could not read that file — make sure it's a Runtracker backup.";
    }
  };
  reader.readAsText(file);
}

/* ---------- squad / Supabase ---------- */
let sb = null;
let sbUrl = localStorage.getItem('runtracker_sb_url') || '';
let sbKey = localStorage.getItem('runtracker_sb_key') || '';
let squadCode = localStorage.getItem('runtracker_squad_code') || '';
let squadName = localStorage.getItem('runtracker_squad_name') || '';

function initSupabase() {
  try {
    if (sbUrl && sbKey && window.supabase && window.supabase.createClient) {
      sb = window.supabase.createClient(sbUrl, sbKey);
      return true;
    }
  } catch { /* fall through to null client below */ }
  sb = null;
  return false;
}

function renderSquadView() {
  const configured = !!sb;
  els['squad-unconfigured'].style.display = configured ? 'none' : 'block';
  if (!configured) { els['squad-join'].style.display = 'none'; els['squad-board'].style.display = 'none'; return; }
  if (!squadCode) {
    els['squad-join'].style.display = 'block';
    els['squad-board'].style.display = 'none';
    els['squad-name'].value = squadName;
  } else {
    els['squad-join'].style.display = 'none';
    els['squad-board'].style.display = 'block';
    els['squad-code-label'].textContent = squadCode;
    fetchSquadLeaderboard();
  }
}

async function fetchSquadLeaderboard() {
  els['squad-list'].innerHTML = '<p class="hint-text">Loading…</p>';
  try {
    const since = startOfWeek(new Date()).toISOString().slice(0, 10);
    const { data, error } = await sb.from('squad_runs')
      .select('display_name,distance_km,duration_s,date')
      .eq('squad_code', squadCode)
      .gte('date', since);
    if (error) throw error;
    const agg = {};
    (data || []).forEach(r => {
      const key = r.display_name;
      if (!agg[key]) agg[key] = { name: key, distanceKm: 0, runs: 0 };
      agg[key].distanceKm += Number(r.distance_km);
      agg[key].runs += 1;
    });
    const board = Object.values(agg).sort((a, b) => b.distanceKm - a.distanceKm);
    if (!board.length) { els['squad-list'].innerHTML = '<p class="hint-text">No runs logged by your squad this week yet.</p>'; return; }
    els['squad-list'].innerHTML = board.map((m, i) => `
      <div class="squad-row">
        <span class="rank">${i + 1}</span>
        <span class="name">${escapeHtml(m.name)}</span>
        <span class="figs"><b>${toDisplayDistance(m.distanceKm).toFixed(1)} ${unit}</b><span>${m.runs} run${m.runs > 1 ? 's' : ''}</span></span>
      </div>`).join('');
  } catch {
    els['squad-list'].innerHTML = "<p class=\"hint-text\">Couldn't load — check your connection or the Supabase setup in Settings.</p>";
  }
}

function queuePendingSync(payload) {
  const q = JSON.parse(localStorage.getItem('runtracker_pending_sync') || '[]');
  q.push(payload);
  localStorage.setItem('runtracker_pending_sync', JSON.stringify(q));
}
async function pushRunToSquad(run) {
  if (!sb || !squadCode) return;
  const payload = { squad_code: squadCode, display_name: squadName, date: run.date.slice(0, 10), distance_km: run.distanceKm, duration_s: run.durationS, pace_sec_per_km: run.paceSecPerKm };
  try {
    const { error } = await sb.from('squad_runs').insert(payload);
    if (error) throw error;
  } catch {
    queuePendingSync(payload);
  }
}
async function flushPendingSync() {
  if (!sb) return;
  const q = JSON.parse(localStorage.getItem('runtracker_pending_sync') || '[]');
  if (!q.length) return;
  const remaining = [];
  for (const item of q) {
    try {
      const { error } = await sb.from('squad_runs').insert(item);
      if (error) throw error;
    } catch { remaining.push(item); }
  }
  localStorage.setItem('runtracker_pending_sync', JSON.stringify(remaining));
  if (remaining.length !== q.length && els['view-squad'].classList.contains('active')) fetchSquadLeaderboard();
}
window.addEventListener('online', flushPendingSync);

/* ---------- tabs ---------- */
function switchTab(name) {
  ['track', 'history', 'squad', 'settings'].forEach(n => {
    els[`view-${n}`].classList.toggle('active', n === name);
    els[`tab-${n}`].classList.toggle('active', n === name);
  });
  if (name === 'history') renderHistory();
  if (name === 'squad') renderSquadView();
}

/* ---------- wire up ---------- */
els['btn-start'].addEventListener('click', startRun);
els['btn-pause'].addEventListener('click', togglePause);
els['btn-finish'].addEventListener('click', finishRun);
els['tab-track'].addEventListener('click', () => switchTab('track'));
els['tab-history'].addEventListener('click', () => switchTab('history'));
els['tab-squad'].addEventListener('click', () => switchTab('squad'));
els['tab-settings'].addEventListener('click', () => switchTab('settings'));
els['unit-toggle'].addEventListener('click', toggleUnit);

els['btn-manual-open'].addEventListener('click', openManualModal);
els['btn-manual-open-2'].addEventListener('click', openManualModal);
els['btn-manual-cancel'].addEventListener('click', closeManualModal);
els['btn-manual-save'].addEventListener('click', saveManualRun);
els['manual-backdrop'].addEventListener('click', (e) => { if (e.target === els['manual-backdrop']) closeManualModal(); });

els['btn-treadmill-open'].addEventListener('click', openTreadmillPanel);
els['btn-treadmill-cancel'].addEventListener('click', closeTreadmillPanel);
els['btn-treadmill-start'].addEventListener('click', startTreadmill);

els['btn-export-data'].addEventListener('click', exportAllData);
els['import-file'].addEventListener('change', (e) => handleImportFile(e.target.files[0]));

els['btn-supabase-save'].addEventListener('click', () => {
  const url = els['supabase-url'].value.trim();
  const key = els['supabase-key'].value.trim();
  if (!url || !key) { els['supabase-status'].textContent = 'Add both the URL and the anon key.'; return; }
  sbUrl = url; sbKey = key;
  localStorage.setItem('runtracker_sb_url', sbUrl);
  localStorage.setItem('runtracker_sb_key', sbKey);
  const ok = initSupabase();
  els['supabase-status'].textContent = ok ? 'Connected.' : 'Could not initialize — double-check the URL and key.';
  if (ok) flushPendingSync();
  renderSquadView();
});

els['btn-squad-join'].addEventListener('click', () => {
  const name = els['squad-name'].value.trim();
  const code = els['squad-code'].value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!name || !code) { showToast('Add your name and a squad code.'); return; }
  squadName = name; squadCode = code;
  localStorage.setItem('runtracker_squad_name', squadName);
  localStorage.setItem('runtracker_squad_code', squadCode);
  renderSquadView();
  flushPendingSync();
});
els['btn-squad-leave'].addEventListener('click', () => {
  if (!confirm('Leave this squad?')) return;
  squadCode = '';
  localStorage.removeItem('runtracker_squad_code');
  renderSquadView();
});
els['btn-squad-refresh'].addEventListener('click', fetchSquadLeaderboard);

window.addEventListener('resize', () => {
  if (!treadmillActive && els['active-panel'].style.display !== 'none' && points.length) drawRoute(els['route-canvas'], points);
});

/* ---------- init ---------- */
applyTheme();
applyAutopauseToggle();
applyAudioToggle();
applyNotifyToggle();
applyUnitLabel();
els['supabase-url'].value = sbUrl;
els['supabase-key'].value = sbKey;
if (sbUrl && sbKey) { initSupabase(); flushPendingSync(); }
checkGps();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
