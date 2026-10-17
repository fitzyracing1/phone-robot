# phone-robot

[![phone-robot ci](https://github.com/fitzyracing1/phone-robot/actions/workflows/ci.yml/badge.svg)](https://github.com/fitzyracing1/phone-robot/actions/workflows/ci.yml)

**Milestone 1 of the phone-robot plan.** An Android phone logs its GPS position, activity (still, walking, driving)
and a motion summary every 10 seconds and streams them to your own small server, which stores everything and shows
the latest point and recent track on a map. There is no model, no calls and no SMS yet.

![server page (demo data)](docs/server-page.png)
*The server page with demo data: a walk, then a short drive.*

```
android/   Kotlin app (minSdk 26, targetSdk 35): settings screen + foreground service → batches → POST /ingest
server/    zero-dependency Node server: POST /ingest → NDJSON, GET /healthz, map page, DIS example config
```

## 1. Run the server

You need Node 18+ (or Docker). It has no dependencies.

```bash
cd server
export INGEST_TOKEN=$(openssl rand -hex 24)   # the phone's upload token (min 16 chars)
export VIEW_TOKEN=$(openssl rand -hex 24)     # optional; key for the map page (defaults to INGEST_TOKEN)
npm start                                      # → http://localhost:8080
npm test
```

| Env | Default | |
|---|---|---|
| `INGEST_TOKEN` | required | bearer token the app sends to `POST /ingest`; the server refuses to start without one |
| `VIEW_TOKEN` | `INGEST_TOKEN` | bearer token for `/api/*`, which the map page uses |
| `PORT` | `8080` | |
| `DATA_DIR` | `./data` (`/data` in Docker) | one `points-YYYY-MM-DD.ndjson` per UTC day |
| `RECENT_MAX` | `5000` | points kept in memory for the page; reloaded from disk on restart |

| Route | Auth | |
|---|---|---|
| `POST /ingest` | `Authorization: Bearer $INGEST_TOKEN` | body `{device, samples:[{t, loc?, activity?, transitions?, motion?, battery?, charging?}]}`, max 500 samples / 1 MB. The server validates it and drops unknown fields. |
| `GET /healthz` | none | `{ok, points, uptimeS}`. Contains no location data. |
| `GET /` | none (shell only) | the map page. Open `https://<server>/#key=<VIEW_TOKEN>`: the key stays in the URL fragment, so it never reaches server logs, and is saved in the browser. |
| `GET /api/latest`, `GET /api/track?minutes=60&device=` | `Authorization: Bearer $VIEW_TOKEN` | JSON for the page |

The page loads Leaflet 1.9.4 from unpkg (pinned with SRI) and map tiles from OpenStreetMap. It sends a strict CSP and has no tracking.

**Docker:** `docker build -t phone-robot-server server && docker run -p 8080:8080 -e INGEST_TOKEN=... -v $PWD/data:/data phone-robot-server`

**Railway** (not deployed yet):
1. Create a new project from this repo and set the service's root directory to `server`. `railway.json` builds the Dockerfile and health-checks `/healthz`.
2. Add a volume mounted at `/data`, and set `RAILWAY_RUN_UID=0` (Railway volumes are root-owned; the image otherwise runs as `node`).
3. Set `INGEST_TOKEN` (and `VIEW_TOKEN`) as variables.
4. Generate a domain. The app needs that `https://` URL.

**Watch it with [DIS](https://github.com/fitzyracing1/DIS):**
```bash
PHONE_ROBOT_URL=https://your-server.up.railway.app npx -y github:fitzyracing1/DIS once --config server/examples/dis.config.json
```
For the phone's own dependencies (FCM, Google Play services and so on), combine it with DIS's `examples/phone-providers.config.json`.

## 2. Get the APK

- **From CI:**
  1. Open the latest green run of [phone-robot ci](https://github.com/fitzyracing1/phone-robot/actions/workflows/ci.yml) on `main`.
  2. Under **Artifacts**, download `phone-robot-debug-apk` (you must be signed in to GitHub).
  3. Unzip it to get `app-debug.apk`.
- **Build it yourself:** with JDK 17 and the Android SDK (platform 35) installed, run `cd android && ./gradlew assembleDebug`. The APK lands in `android/app/build/outputs/apk/debug/app-debug.apk`.

This is a debug build, signed with a debug key. If Android refuses to install a newer APK over an older one ("package conflicts"), uninstall the old one first.

## 3. Sideload it on the phone

1. Copy `app-debug.apk` to the phone: download it on the phone, use Drive, or run `adb install app-debug.apk`.
2. Open it. Android asks you to allow **Install unknown apps** for the app you opened it from (Files, Chrome…). Allow it, then tap **Install**.
   Play Protect may warn about an unknown developer. Choose **Install anyway** (it's your build).
3. Open **phone-robot** and enter:
   - **Server URL:** your `https://` server URL (plain `http://` is refused because the upload carries your location and a token);
   - **Upload token:** the server's `INGEST_TOKEN`;
   - **Device name:** e.g. `pixel-8`.

   Tap **Save settings**.
4. Tap **Start logging** and answer the permission prompts:
   - **Location → While using the app, Precise** (required).
   - **Notifications** (Android 13+). Recommended: this shows the "Logging…" notification with a Stop button.
   - **Physical activity** (Android 10+). Needed for walking/driving transitions.
5. Optional: **Allow location all the time**. Logging with the screen off works without it. It only matters if Android kills the app and restarts the service later.
6. Optional: **Battery settings**. Some phones (Samsung, Xiaomi, OnePlus…) kill background apps aggressively. If logging stops with the screen off, set phone-robot to "Unrestricted" or "Don't optimise".
7. Open `https://<server>/#key=<VIEW_TOKEN>` to watch the track. To stop, tap **Stop logging** in the app or **Stop** in the notification.

## How the app works

- **One foreground service** (type `location`) with a visible notification. It runs only while you've pressed Start.
- **Every 10 s it writes one sample:**
  - the latest **Fused Location** fix: `PRIORITY_HIGH_ACCURACY` while moving, `BALANCED_POWER_ACCURACY` while the activity is `STILL`;
  - the current **activity** plus any **Activity Recognition transitions** (ENTER/EXIT for still, walking, running, bicycle, vehicle) since the last sample;
  - an **accelerometer and gyroscope summary** for the window: sample count, mean |a|, RMS and peak deviation from 1 g, and rotation speed;
  - the battery level.
- **Offline queue:** samples are appended to `files/queue/pending.ndjson` and sealed into a batch every 6 samples (1 min).
  - Batches are uploaded oldest first and deleted only after a 2xx.
  - Uploads back off from 30 s to 15 min and retry right away when the network comes back.
  - Up to 3 days of batches are kept. A batch the server rejects as malformed (400) is set aside rather than retried forever.
- **No wake locks:**
  - The 10 s clock is a Handler that the location callback nudges, and that callback is what wakes the CPU with the screen off.
  - Motion sensors run at 50 Hz with a 10 s `maxReportLatency`, so the sensor hub batches events instead of waking the CPU 50 times a second.
  - The app doesn't request a battery-optimisation exemption.
- **Privacy:** HTTPS only. Settings and queue are app-private, with backup and device transfer disabled. Nothing is sent anywhere except your server.

## Milestone 1 is done when

- [ ] **A walk** (≥ 10 min) shows up on the server page as a continuous track with the screen **off** the whole time. Activity reads `WALKING`, with an `ENTER WALKING` transition.
- [ ] **A short drive** (≥ 10 min) does the same, with `IN_VEHICLE`. Its transitions (`EXIT WALKING`/`ENTER IN_VEHICLE`, then back) line up with when you got in and out.
- [ ] Samples arrive about every 10 s, with no gaps over 1 min, while the screen is off for **30+ minutes**.
- [ ] Battery drain caused by phone-robot is **under ~5% per hour**. Check Settings → Battery → app usage, or compare the `battery` field over an hour with the phone otherwise idle.
- [ ] **Offline:** turn on airplane mode for 5 min while walking, then turn it off. The gap fills in from the queue and no samples are lost.
- [ ] DIS shows `phone-robot-server` lit, and it turns dark after 2 failed checks if the server is stopped.

Next steps are in the plan (milestone 2: FCM start/stop, a small planner with a turn limit, a safety layer, and DIS dependency gating).

## License

[MIT](LICENSE)
