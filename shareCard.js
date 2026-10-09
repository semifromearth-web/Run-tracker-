/**
 * shareCard.js — Shareable stats-card export for the run tracker PWA.
 * Fully client-side (canvas), no network calls — matches the app's offline-first design.
 *
 * Usage:
 *   import { exportStatsCard } from './shareCard.js';
 *   exportStatsCard(run, { format: '9:16' });   // or '1:1'
 *
 * `run` shape expected:
 *   {
 *     distanceKm: 4.34,
 *     paceLabel: "10:07",      // per-km pace, already formatted mm:ss
 *     durationLabel: "43m 54s",
 *     points: [{ lat, lng }, ...]   // raw GPS points for the route trace
 *   }
 */

const SIZES = {
  '9:16': { w: 1080, h: 1920 },
  '1:1':  { w: 1080, h: 1080 },
};

const THEME = {
  bg: '#141414',
  text: '#F2F2EF',
  label: '#B9B9B3',
  route: '#7C9A24',   // app's olive green accent
  routeWidth: 10,
};

export function exportStatsCard(run, opts = {}) {
  const format = opts.format === '1:1' ? '1:1' : '9:16';
  const canvas = renderStatsCard(run, format);
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `run-${Date.now()}-${format.replace(':', 'x')}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

// Renders and returns the <canvas> itself, in case the caller wants to
// preview it (e.g. show it in a modal) before downloading / sharing.
export function renderStatsCard(run, format = '9:16') {
  const { w, h } = SIZES[format] || SIZES['9:16'];
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = THEME.bg;
  ctx.fillRect(0, 0, w, h);

  const centerX = w / 2;
  const square = format === '1:1';

  // --- Stats block ---
  const stats = [
    { label: 'Distance', value: `${run.distanceKm.toFixed(2)} km` },
    { label: 'Pace',     value: `${run.paceLabel} /km` },
    { label: 'Time',     value: run.durationLabel },
  ];

  let y = square ? h * 0.10 : h * 0.14;
  const labelFont = Math.round(w * (square ? 0.034 : 0.036));
  const valueFont = Math.round(w * (square ? 0.075 : 0.082));
  const blockGap = square ? h * 0.07 : h * 0.065;

  stats.forEach((s) => {
    ctx.textAlign = 'center';
    ctx.fillStyle = THEME.label;
    ctx.font = `700 ${labelFont}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(s.label, centerX, y);

    y += valueFont * 0.95;
    ctx.fillStyle = THEME.text;
    ctx.font = `800 ${valueFont}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(s.value, centerX, y);

    y += blockGap;
  });

  // --- Route trace ---
  if (run.points && run.points.length > 1) {
    drawRouteTrace(ctx, run.points, {
      top: y + (square ? h * 0.02 : h * 0.02),
      bottom: square ? h * 0.80 : h * 0.72,
      left: w * 0.14,
      right: w * 0.86,
      color: THEME.route,
      lineWidth: THEME.routeWidth,
    });
  }

  // --- Footer / logo mark ---
  ctx.textAlign = 'center';
  ctx.fillStyle = THEME.text;
  ctx.font = `800 ${Math.round(w * 0.055)}px system-ui, -apple-system, sans-serif`;
  ctx.fillText('RUNTRACKER', centerX, h * (square ? 0.93 : 0.945));

  return canvas;
}

// Projects raw lat/lng points onto a bounded box, preserving aspect ratio,
// and draws the trace as a smooth line — same idea as Strava's route cards.
function drawRouteTrace(ctx, points, box) {
  const lats = points.map(p => p.lat);
  const lngs = points.map(p => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);

  const boxW = box.right - box.left;
  const boxH = box.bottom - box.top;

  // Correct for latitude distortion so the route isn't stretched
  const latSpan = Math.max(maxLat - minLat, 1e-6);
  const lngSpan = Math.max(maxLng - minLng, 1e-6) * Math.cos((minLat * Math.PI) / 180);

  const scale = Math.min(boxW / lngSpan, boxH / latSpan) * 0.9;
  const drawW = lngSpan * scale;
  const drawH = latSpan * scale;
  const offsetX = box.left + (boxW - drawW) / 2;
  const offsetY = box.top + (boxH - drawH) / 2;

  const toXY = (p) => {
    const x = offsetX + ((p.lng - minLng) * Math.cos((minLat * Math.PI) / 180)) * scale;
    const y = offsetY + drawH - (p.lat - minLat) * scale;
    return [x, y];
  };

  ctx.beginPath();
  ctx.strokeStyle = box.color;
  ctx.lineWidth = box.lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  points.forEach((p, i) => {
    const [x, y] = toXY(p);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}
