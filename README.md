# Runtracker

A personal, offline-friendly run tracker. No account, no subscription, no
server — everything (routes, distance, pace, history) is stored on your
phone in the browser's local storage.

## Getting it onto your phone

Browsers only allow GPS access (`navigator.geolocation`) on a **secure
origin** — `https://` or `localhost`. A plain `file://` won't work. The
easiest free ways to get an https URL for these files:

1. **Netlify Drop** — go to https://app.netlify.com/drop on a computer and
   drag this whole folder in. It gives you a free `https://...netlify.app`
   link instantly, no account needed for a one-off deploy.
2. **GitHub Pages** — push this folder to a GitHub repo, turn on Pages in
   the repo settings, and it's served at `https://<you>.github.io/<repo>`.

Once you have the https link:
1. Open it in Chrome on your Android phone.
2. Tap the ⋮ menu → **Add to Home screen**.
3. Launch it from the home screen icon — it opens full-screen like a real
   app, and works with no signal once the page has loaded once (the service
   worker caches everything it needs).

## What's implemented

- GPS tracking (`watchPosition`) with basic noise filtering — points with
  poor accuracy or implausible speed jumps are discarded.
- Live distance (Haversine formula), pace, elapsed time, elevation gain
  (when the phone reports altitude — not all do).
- Route drawn as a plain line from your raw GPS points — no map tiles, so
  it works with zero connectivity.
- Pause/resume that doesn't count distance across the paused gap.
- Run history with per-run route thumbnails, and delete.
- Installable as a home-screen app with offline shell caching.

## Known limitation

Standard web geolocation stops updating once the screen locks or the app
is backgrounded — there's no background-location API available to a
regular website. Keep the screen on and the tab in the foreground while
tracking. A "real" background-capable version would need to be a native
app (or wrapped with something like Capacitor), which is a bigger step up
if this ever becomes worth it.
