# Runtracker

A personal, offline-friendly run tracker. No account required for solo use —
tracking, history, records, and settings are all stored on your phone.
Squad leaderboards are the one opt-in feature that talks to a server.

## Getting it onto your phone

Browsers only allow GPS access on a secure origin (`https://` or
`localhost`) — not a plain `file://`. Easiest free options:

1. **GitHub Pages** — push this folder to a repo, enable Pages in
   Settings (source: Deploy from a branch → `main` → `/root`), and it's
   served at `https://<you>.github.io/<repo>`.
2. **Netlify Drop** — https://app.netlify.com/drop — drag the whole folder
   in on a computer for an instant link.

Then on your phone: open the link in Chrome → ⋮ menu → **Add to Home
screen**. It launches full-screen and works offline after the first load.

## Setting up Squad (optional)

The leaderboard needs its own free Supabase project (separate from any
other project you're running):

1. Create a project at supabase.com.
2. In the SQL editor, run:

   ```sql
   create table squad_runs (
     id bigint generated always as identity primary key,
     squad_code text not null,
     display_name text not null,
     date date not null,
     distance_km numeric not null,
     duration_s int not null,
     pace_sec_per_km numeric,
     created_at timestamptz default now()
   );

   alter table squad_runs enable row level security;

   create policy "anyone can read" on squad_runs
     for select using (true);

   create policy "anyone can insert" on squad_runs
     for insert with check (true);
   ```

   (Open read/insert is fine here since nothing sensitive — just distance,
   time, and pace — ever gets written, and there's no auth layer to keep
   simple for a personal project.)

3. In Supabase, go to **Project Settings → API** and copy the **Project
   URL** and the **anon public key**.
4. In the app, go to **Settings → Squad/Supabase**, paste both in, and
   save.
5. Go to the **Squad** tab, enter a name and a squad code, and share that
   same code with your friend so you land on the same leaderboard.

Runs sync automatically when you finish them. If you're offline at the
time, they're queued and sent the next time the app is online.

## Full feature list

**Tracking**
- GPS tracking with noise filtering (drops low-accuracy points and
  implausible speed jumps)
- Manual pause/resume and automatic pause when you stop moving for ~12s
  (toggle in Settings) — the paused stretch is never counted as distance
- Treadmill/indoor mode — enter a target pace, get a live timer + computed
  distance with no GPS needed
- Live per-km/mi splits, with optional spoken audio cues
- Screen stays on while tracking (Wake Lock API, where supported)
- Optional live stats in the notification shade — only updates while the
  app is open in front of you; Android still halts background GPS once
  you switch away, same as any regular website

**History**
- Route drawn from raw GPS points, no map tiles — works with zero
  connectivity
- This week / this month distance + time totals
- Personal records: best pace, longest run
- A 10-week activity streak grid
- Per-run splits, GPX export, and a share/copy summary button
- Manual run entry for runs logged without the app

**Data**
- Full backup export / import (one JSON file) — worth doing occasionally,
  since a browser data wipe erases local runs otherwise
- km ↔ mi toggle, applied everywhere

**Squad**
- Join a squad by code, see a weekly distance + run-count leaderboard
- Synced via your own Supabase project (see setup above); offline runs
  queue and sync automatically once back online

**Other**
- Light/dark theme toggle
- Installable as a home-screen app, works offline after first load

## Known limitations

- Standard web geolocation stops once the screen locks or the app is
  backgrounded — there's no background-location API for a regular
  website. Keep the tab in the foreground while tracking.
- The Wake Lock and Notification APIs aren't supported on every browser;
  the app checks and quietly no-ops where they're missing rather than
  breaking.
- Squad's row-level security is wide open (anyone with your URL/key
  could theoretically write to the table). Fine for a small friend group;
  not meant to scale beyond that without adding real auth.
