/* ---------- storage ---------- */
const STORE_KEY = 'runtracker_runs';

function loadRuns() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch { return []; }
}
function saveRuns(runs) {
  localStorage.setItem(STORE_KEY, JSON.stringify(runs));
}

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

function formatPace(secPerKm) {
  if (!isFinite(secPerKm) || secPerKm <= 0) return '–:––';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) +
         ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/* ---------- route drawing (raw GPS points, no map tiles) ---------- */
function drawRoute(canvas, points, strokeColor) {
  if (!points.length) return;
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
let points = [];        // accepted {lat,lng,alt,t}
let elapsedMs = 0;       // active (unpaused) running time
let lastTickTs = null;
let tickTimer = null;
let elevGain = 0;
let skipNextDistance = false;
let isPaused = false;

const MAX_ACCURACY_M = 30;
const MAX_JUMP_MPS = 12; // discard GPS jitter faster than ~43 km/h

const els = {};
['idle-panel','active-panel','gps-badge','gps-badge-text','error-slot','btn-start',
 'btn-pause','btn-finish','run-date','live-indicator','live-text','stat-time',
 'route-canvas','route-empty','stat-distance','stat-pace','stat-elev',
 'view-track','view-history','tab-track','tab-history','history-list','history-count']
 .forEach(id => els[id] = document.getElementById(id));

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
  els['idle-panel'].style.display = 'none';
  els['active-panel'].style.display = 'block';
  els['run-date'].textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  els['route-empty'].style.display = 'flex';
  updateStats();
  beginWatch();
  beginTimer();
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

  if (accuracy != null && accuracy > MAX_ACCURACY_M) return; // too noisy, skip

  const point = { lat: latitude, lng: longitude, alt: altitude, t: pos.timestamp };
  const last = points[points.length - 1];

  if (last && !skipNextDistance) {
    const distM = haversine(last.lat, last.lng, point.lat, point.lng);
    const dtS = Math.max((point.t - last.t) / 1000, 0.5);
    if (distM / dtS > MAX_JUMP_MPS) return; // implausible jump, discard
    if (last.alt != null && point.alt != null) {
      const rise = point.alt - last.alt;
      if (rise > 0.5) elevGain += rise;
    }
  }
  skipNextDistance = false;

  points.push(point);
  els['route-empty'].style.display = 'none';
  updateStats();
  drawRoute(els['route-canvas'], points);
}

function totalDistanceM() {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversine(points[i-1].lat, points[i-1].lng, points[i].lat, points[i].lng);
  return d;
}

function updateStats() {
  const distM = totalDistanceM();
  const distKm = distM / 1000;
  els['stat-distance'].innerHTML = distKm.toFixed(2) + '<span class="unit"> km</span>';

  const elapsedS = elapsedMs / 1000;
  const paceSecPerKm = distKm > 0.02 ? elapsedS / distKm : NaN;
  els['stat-pace'].innerHTML = formatPace(paceSecPerKm) + '<span class="unit"> /km</span>';

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
  } else {
    lastTickTs = Date.now();
    skipNextDistance = true; // don't count distance across the pause gap
    els['btn-pause'].textContent = 'Pause';
    els['btn-pause'].className = 'btn btn-pause';
    els['live-indicator'].className = 'live';
    els['live-text'].textContent = 'Tracking';
  }
}

function finishRun() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  clearInterval(tickTimer);
  watchId = null;

  const distKm = totalDistanceM() / 1000;
  if (points.length < 2 || distKm < 0.05) {
    resetToIdle();
    return;
  }

  const elapsedS = elapsedMs / 1000;
  const run = {
    id: Date.now(),
    date: new Date().toISOString(),
    durationS: Math.round(elapsedS),
    distanceKm: Number(distKm.toFixed(3)),
    paceSecPerKm: elapsedS / distKm,
    elevGainM: points.some(p => p.alt != null) ? Math.round(elevGain) : null,
    points: simplifyPoints(points, 120)
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

/* ---------- history view ---------- */
function renderHistory() {
  const runs = loadRuns().sort((a, b) => new Date(b.date) - new Date(a.date));
  els['history-count'].textContent = runs.length ? `${runs.length} run${runs.length > 1 ? 's' : ''}` : '';

  if (!runs.length) {
    els['history-list'].innerHTML = `<div class="empty-state">
      <p>No runs yet.<br>Start one from the Track tab and it'll show up here.</p>
    </div>`;
    return;
  }

  els['history-list'].innerHTML = '';
  runs.forEach(run => {
    const row = document.createElement('div');
    row.className = 'run-row';
    row.innerHTML = `
      <canvas class="sparkline"></canvas>
      <div class="info">
        <p class="date">${formatDate(run.date)}</p>
        <p class="metrics">
          <b>${run.distanceKm.toFixed(2)}<span> km</span></b>
          <b>${formatTime(run.durationS)}<span> time</span></b>
          <b>${formatPace(run.paceSecPerKm)}<span> /km</span></b>
        </p>
      </div>
      <button class="delete-btn" aria-label="Delete run">&times;</button>
    `;
    const canvas = row.querySelector('canvas');
    requestAnimationFrame(() => drawRoute(canvas, run.points, '#9A9DA6'));
    row.querySelector('.delete-btn').addEventListener('click', () => {
      if (confirm('Delete this run? This can\'t be undone.')) {
        saveRuns(loadRuns().filter(r => r.id !== run.id));
        renderHistory();
      }
    });
    els['history-list'].appendChild(row);
  });
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
