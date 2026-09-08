/* ---------- storage ---------- */
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

/* ---------- math helpers ---------- */
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

/* ---------- route drawing (raw GPS points, no map tiles) ---------- */
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
    ctx.beginPath();
    ctx.arc(rect.width / 2, rect.height / 2, 4, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  const lats = points.map(p => p.lat), lngs = points.map(p => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const pad = 18;
  const spanLat = (maxLat - minLat) || 0.0001;
  const spanLng = (maxLng - minLng) || 0.0001;
  const scaleX = (rect.width - pad * 2) / spanLng;
  const scaleY = (rect.height - pad * 2) / spanLat;
  const scale = Math.min(scaleX, scaleY);
  const offX = (rect.width - spanLng * scale) / 2;
  const offY = (rect.height - spanLat * scale) / 2;

  const toXY = p => [
    offX + (p.lng - minLng) * scale,
    rect.height - (offY + (p.lat - minLat) * scale)
  ];

  ctx.strokeStyle = strokeColor || '#378ADD';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  points.forEach((p, i) => {
    const [x, y] = toXY(p);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
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

function simplifyPoints(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

/* ---------- tracking state ---------- */
let watchId = null;
let points = [];
let elapsedMs = 0;
let lastTickTs = null;
let tickTimer = null;
let elevGain = 0;
let skipNextDistance = false;
let isPaused = false;
let wakeLock = null;

let splits = [];          // completed {distLabel, durationS} during this run
let lastSplitElapsedS = 0;
let nextSplitBoundaryKm = splitUnitKm();

const MAX_ACCURACY_M = 30;
const MAX_JUMP_MPS = 12;

const els = {};
['idle-panel','active-panel','gps-badge','gps-badge-text','error-slot','btn-start',
 'btn-pause','btn-finish','run-date','live-indicator','live-text','stat-time',
 'route-canvas','route-empty','stat-distance','stat-pace','stat-elev','live-splits',
 'view-track','view-history','tab-track','tab-history','history-list',
 'unit-toggle','btn-manual-open','btn-manual-open-2','manual-backdrop','manual-date',
 'manual-distance','manual-unit-label','manual-h','manual-m','manual-s','manual-error',
 'btn-manual-cancel','btn-manual-save','toast','totals-row','totals-week-dist',
 'totals-week-time','totals-month-dist','totals-month-time']
 .forEach(id => els[id] = document.getElementById(id));

/* ---------- toast ---------- */
let toastTimer = null;
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

/* ---------- wake lock (keep screen on while tracking) ---------- */
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* not supported, or denied — tracking still works, screen just may sleep */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && watchId != null && !isPaused) acquireWakeLock();
});

/* ---------- unit toggle ---------- */
function applyUnitLabel() {
  els['unit-toggle'].textContent = unit;
  els['manual-unit-label'].textContent = unit;
}
function toggleUnit() {
  unit = unit === 'km' ? 'mi' : 'km';
  localStorage.setItem(UNIT_KEY, unit);
  applyUnitLabel();
  nextSplitBoundaryKm = (Math.floor(totalDistanceM() / 1000 / splitUnitKm()) + 1) * splitUnitKm();
  if (els['active-panel'].style.display !== 'none') updateStats();
  if (els['view-history'].classList.contains('active')) renderHistory();
}
applyUnitLabel();

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

/* ---------- run lifecycle ---------- */
function startRun() {
  points = []; elapsedMs = 0; elevGain = 0; isPaused = false; skipNextDistance = false;
  splits = []; lastSplitElapsedS = 0; nextSplitBoundaryKm = splitUnitKm();
  els['idle-panel'].style.display = 'none';
  els['active-panel'].style.display = 'block';
  els['run-date'].textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  els['route-empty'].style.display = 'flex';
  els['live-splits'].innerHTML = '';
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

function onPosition(pos) {
  if (isPaused) return;
  const { latitude, longitude, altitude, accuracy } = pos.coords;
  els['live-indicator'].className = 'live';
  els['live-text'].textContent = 'Tracking';

  if (accuracy != null && accuracy > MAX_ACCURACY_M) return;

  const point = { lat: latitude, lng: longitude, alt: altitude, t: pos.timestamp };
  const last = points[points.length - 1];

  if (last && !skipNextDistance) {
    const distM = haversine(last.lat, last.lng, point.lat, point.lng);
    const dtS = Math.max((point.t - last.t) / 1000, 0.5);
    if (distM / dtS > MAX_JUMP_MPS) return;
    if (last.alt != null && point.alt != null) {
      const rise = point.alt - last.alt;
      if (rise > 0.5) elevGain += rise;
    }
  }
  skipNextDistance = false;

  points.push(point);
  els['route-empty'].style.display = 'none';
  updateStats();
  checkSplit();
  drawRoute(els['route-canvas'], points);
}

function totalDistanceM() {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversine(points[i-1].lat, points[i-1].lng, points[i].lat, points[i].lng);
  return d;
}

function checkSplit() {
  const distKm = totalDistanceM() / 1000;
  if (distKm >= nextSplitBoundaryKm) {
    const elapsedS = elapsedMs / 1000;
    const durationS = elapsedS - lastSplitElapsedS;
    splits.push({ n: splits.length + 1, durationS });
    lastSplitElapsedS = elapsedS;
    nextSplitBoundaryKm += splitUnitKm();
    renderLiveSplits();
  }
}

function renderLiveSplits() {
  els['live-splits'].innerHTML = splits.map(s =>
    `<div class="split-row"><span>${s.n} ${unit}</span><b>${formatTime(s.durationS)}</b></div>`
  ).join('');
}

function updateStats() {
  const distM = totalDistanceM();
  const distKm = distM / 1000;
  els['stat-distance'].innerHTML = toDisplayDistance(distKm).toFixed(2) + `<span class="unit"> ${unit}</span>`;

  const elapsedS = elapsedMs / 1000;
  const paceSecPerKm = distKm > 0.02 ? elapsedS / distKm : NaN;
  els['stat-pace'].innerHTML = formatPace(toDisplayPaceSec(paceSecPerKm)) + `<span class="unit"> /${unit}</span>`;

  els['stat-elev'].innerHTML = (points.some(p => p.alt != null) ? Math.round(elevGain) : '–') + '<span class="unit"> m</span>';

  els['stat-time'].textContent = formatTime(elapsedS);
}

function beginTimer() {
  lastTickTs = Date.now();
  tickTimer = setInterval(() => {
    if (!isPaused) {
      const now = Date.now();
      elapsedMs += now - lastTickTs;
      lastTickTs = now;
      updateStats();
    }
  }, 1000);
}

function togglePause() {
  isPaused = !isPaused;
  if (isPaused) {
    els['btn-pause'].textContent = 'Resume';
    els['btn-pause'].className = 'btn btn-resume';
    els['live-indicator'].className = 'live paused';
    els['live-text'].textContent = 'Paused';
    releaseWakeLock();
  } else {
    lastTickTs = Date.now();
    skipNextDistance = true;
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

  const distKm = totalDistanceM() / 1000;
  if (points.length < 2 || distKm < 0.05) {
    resetToIdle();
    return;
  }

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
    elevGainM: points.some(p => p.alt != null) ? Math.round(elevGain) : null,
    points: simplifyPoints(points, 120),
    splits: splits.map(s => ({ n: s.n, durationS: Math.round(s.durationS) })),
    manual: false
  };
  const runs = loadRuns();
  runs.push(run);
  saveRuns(runs);

  resetToIdle();
  switchTab('history');
}

function resetToIdle() {
  els['active-panel'].style.display = 'none';
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
function closeManualModal() {
  els['manual-backdrop'].classList.remove('open');
}
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
    manual: true
  };
  const runs = loadRuns();
  runs.push(run);
  saveRuns(runs);
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

/* ---------- totals ---------- */
function startOfWeek(d) {
  const day = (d.getDay() + 6) % 7;
  const s = new Date(d); s.setHours(0, 0, 0, 0); s.setDate(d.getDate() - day);
  return s;
}
function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
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

/* ---------- history view ---------- */
function renderHistory() {
  const runs = loadRuns().sort((a, b) => new Date(b.date) - new Date(a.date));
  renderTotals(runs);

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
    row.innerHTML = `
      <canvas class="sparkline"></canvas>
      <div class="info">
        <p class="date">${formatDate(run.date)}${run.manual ? ' · manual' : ''}</p>
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
  }
  detail.innerHTML = splitsHtml + `<button class="share-btn">Share this run</button>`;
  detail.querySelector('.share-btn').addEventListener('click', () => shareRun(run));
  detail.classList.add('open');
}

/* ---------- tabs ---------- */
function switchTab(name) {
  const track = name === 'track';
  els['view-track'].classList.toggle('active', track);
  els['view-history'].classList.toggle('active', !track);
  els['tab-track'].classList.toggle('active', track);
  els['tab-history'].classList.toggle('active', !track);
  if (!track) renderHistory();
}

/* ---------- wire up ---------- */
els['btn-start'].addEventListener('click', startRun);
els['btn-pause'].addEventListener('click', togglePause);
els['btn-finish'].addEventListener('click', finishRun);
els['tab-track'].addEventListener('click', () => switchTab('track'));
els['tab-history'].addEventListener('click', () => switchTab('history'));
els['unit-toggle'].addEventListener('click', toggleUnit);
els['btn-manual-open'].addEventListener('click', openManualModal);
els['btn-manual-open-2'].addEventListener('click', openManualModal);
els['btn-manual-cancel'].addEventListener('click', closeManualModal);
els['btn-manual-save'].addEventListener('click', saveManualRun);
els['manual-backdrop'].addEventListener('click', (e) => { if (e.target === els['manual-backdrop']) closeManualModal(); });

window.addEventListener('resize', () => {
  if (els['active-panel'].style.display !== 'none' && points.length) drawRoute(els['route-canvas'], points);
});

checkGps();

/* ---------- offline support ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
