// shareCard.js — transparent-background run stats overlay (PNG with alpha)
// Drop-in replacement: same export name app.js already imports.

const SIZES = { '9:16': [1080, 1920], '1:1': [1080, 1080] };
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const ORANGE = '#FC4C02';

function setShadow(ctx, on) {
  // soft shadow keeps white text readable on bright photos
  ctx.shadowColor = on ? 'rgba(0,0,0,0.45)' : 'transparent';
  ctx.shadowBlur = on ? 14 : 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = on ? 3 : 0;
}

function drawRoute(ctx, points, box) {
  if (!points || points.length < 2) return;
  const midLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const kx = Math.cos(midLat * Math.PI / 180); // keep route shape undistorted
  const xs = points.map(p => p.lng * kx), ys = points.map(p => p.lat);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = (maxX - minX) || 1e-6, spanY = (maxY - minY) || 1e-6;
  const scale = Math.min(box.w / spanX, box.h / spanY);
  const offX = box.x + (box.w - spanX * scale) / 2;
  const offY = box.y + (box.h - spanY * scale) / 2;
  const toXY = p => [offX + (p.lng * kx - minX) * scale, offY + (maxY - p.lat) * scale];

  ctx.save();
  setShadow(ctx, true);
  ctx.strokeStyle = ORANGE;
  ctx.lineWidth = 14;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  let seg = null;
  ctx.beginPath();
  points.forEach(p => {
    const [x, y] = toXY(p);
    if (p.seg !== seg) { ctx.moveTo(x, y); seg = p.seg; } else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // start + end dots
  const [sx, sy] = toXY(points[0]);
  const [ex, ey] = toXY(points[points.length - 1]);
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(sx, sy, 14, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(ex, ey, 14, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawStat(ctx, label, value, unit, x, y, labelSize, valueSize) {
  ctx.save();
  setShadow(ctx, true);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `600 ${labelSize}px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '4px';
  ctx.fillText(label.toUpperCase(), x, y);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

  ctx.fillStyle = '#fff';
  ctx.font = `800 ${valueSize}px ${FONT}`;
  const vy = y + valueSize * 0.95;
  ctx.fillText(value, x, vy);
  if (unit) {
    const w = ctx.measureText(value).width;
    ctx.font = `700 ${valueSize * 0.38}px ${FONT}`;
    ctx.fillText(unit, x + w + 14, vy);
  }
  ctx.restore();
}

export function renderStatsCard(stats, { format = '9:16' } = {}) {
  const [W, H] = SIZES[format] || SIZES['9:16'];
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H); // fully transparent — no background fill anywhere

  const distance = stats.distanceLabel
    || (stats.distanceKm != null ? Number(stats.distanceKm).toFixed(2) : '--');
  const distUnit = stats.distanceUnit || (stats.distanceLabel ? '' : 'km');
  const paceUnit = stats.paceUnit || '';
  const hasRoute = stats.points && stats.points.length > 1;

  if (format === '1:1') {
    // stats stacked on the left, route on the right
    const x = 90;
    drawStat(ctx, 'Distance', distance, distUnit, x, 150, 30, 100);
    drawStat(ctx, 'Pace', stats.paceLabel || '--', paceUnit, x, 430, 30, 100);
    drawStat(ctx, 'Time', stats.durationLabel || '--', '', x, 710, 30, 100);
    if (hasRoute) drawRoute(ctx, stats.points, { x: 560, y: 110, w: 430, h: 860 });
  } else {
    // route on top, stats stacked below (Strava-style)
    if (hasRoute) drawRoute(ctx, stats.points, { x: 110, y: 300, w: 860, h: 780 });
    const x = 90;
    drawStat(ctx, 'Distance', distance, distUnit, x, 1230, 36, 130);
    drawStat(ctx, 'Pace', stats.paceLabel || '--', paceUnit, x, 1480, 36, 130);
    drawStat(ctx, 'Time', stats.durationLabel || '--', '', x, 1730, 36, 130);
  }
  return canvas;
}

export async function shareStatsCardNative(stats, opts = {}) {
  const canvas = renderStatsCard(stats, opts);
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('Could not render stats card');
  const file = new File([blob], 'run-stats.png', { type: 'image/png' });

  // image file only — adding title/text can make some share sheets send text instead
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  // fallback: download the PNG
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'run-stats.png';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
