# Tinxy UI

A lightweight, zero-dependency web dashboard for controlling [Tinxy](https://tinxy.in) smart home devices — fans, lights, and sockets — from any browser.

**Live (EC2):** http://54.91.145.63
**Live (Raspberry Pi):** https://connect-pi.local
**Local dev:** http://localhost:3456

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Project Structure](#project-structure)
- [Run on localhost](#run-on-localhost)
- [Deploy on Raspberry Pi](#deploy-on-raspberry-pi)
- [Deployment (AWS EC2)](#deployment-aws-ec2)
- [Architecture](#architecture)
- [API Reference](#api-reference)
- [Device Grouping](#device-grouping)
- [Fan Speed Fix](#fan-speed-fix)
- [Known Issues](#known-issues)
- [Commit History & Changes](#commit-history--changes)

---

## Overview

Tinxy UI talks directly to the Tinxy cloud backend (`https://backend.tinxy.in`) using a Bearer API token. It fetches all devices on the account, renders them as interactive cards, and polls for live state updates every 10 seconds.

---

## Features

- **Token auth** — Bearer token stored in `localStorage`; a default token is pre-seeded so the dashboard loads instantly without manual login
- **Live polling** — device states refresh every 10 s; polling pauses when the browser tab is hidden and resumes on focus
- **Fan control** — Off / Low / Med / High speed buttons using correct API brightness values (`33 / 66 / 100`)
- **Switch toggle** — single toggle per relay with optimistic UI update
- **Device grouping** — multiple physical Tinxy devices can be merged into one card (e.g. "Sachin Room" + "Laptop" → one box)
- **Single-node naming** — when a device has only one relay and no custom node name, the device name is used as the label (e.g. "Laptop" instead of "Switch 1")
- **Status bar** — transient toast-style feedback on every action
- **Error handling** — 401/403 auto-logout; network errors surfaced with a retry button

---

## Project Structure

```
TinxyUI/
├── tinxy-ui/               # The web app
│   ├── index.html          # Single-page app shell + <template> elements
│   ├── styles.css          # All styling
│   ├── app.js              # All application logic (no build step)
│   ├── serve.js            # Tiny Node.js HTTP server (port 3456)
│   └── package.json        # npm metadata + start script
├── ecosystem.config.js     # PM2 process config (production)
└── .claude/
    └── launch.json         # Local dev server config for Claude Code preview
```

---

## Run on localhost

**Prerequisites:** Node.js ≥ 18 ([download](https://nodejs.org/))

```bash
git clone https://github.com/sachin245/TinxyUI.git
cd TinxyUI/tinxy-ui
node serve.js
# → http://localhost:3456
```

Or via npm:

```bash
npm start
```

To use a different port:

```bash
PORT=4000 node serve.js   # macOS/Linux
$env:PORT=4000; node serve.js   # Windows PowerShell
```

The server (`serve.js`) is a plain Node.js HTTP server — no framework, no build step. Edit `index.html`, `styles.css`, or `app.js` and hard-refresh the browser.

Open http://localhost:3456, paste your Tinxy Bearer token (Tinxy mobile app → Settings → API Token → Get), and click **Connect**.

> **Rule:** Always verify changes locally before deploying.

---

## Deploy on Raspberry Pi

The Pi (`connect-pi.local`, port `6001`) auto-deploys on every push to `main` via a self-hosted GitHub Actions runner. Full setup details live in [`pi.md`](./pi.md); the short version:

### One-time setup on the Pi

```bash
# 1. Install Node 20, PM2, nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx
sudo npm install -g pm2

# 2. Clone repo and start
cd ~ && git clone https://github.com/sachin245/TinxyUI.git
cd TinxyUI && pm2 start ecosystem.pi.config.js
pm2 save && pm2 startup     # follow printed command to enable on reboot

# 3. Install GitHub Actions self-hosted runner (see pi.md for token + steps)
#    Workflow: .github/workflows/deploy-pi.yml
```

Configure HTTPS via `mkcert` (recommended for LAN) or Let's Encrypt + nip.io (public IP). nginx config and SSL details are in [`pi.md`](./pi.md).

### Deploy a code change

Just push to `main` — the runner picks up the job, pulls the repo, and restarts PM2:

```bash
git push origin main
```

Manual deploy (if the runner is offline):

```bash
ssh pi@connect-pi.local \
  "cd ~/TinxyUI && git pull origin main && pm2 restart tinxy-ui"
```

### Pi PM2 commands

```bash
pm2 status                   # check process state
pm2 logs tinxy-ui            # tail logs
pm2 restart tinxy-ui         # restart
```

---

## Deployment (AWS EC2)

### Instance details

| Property | Value |
|---|---|
| IP | `54.91.145.63` |
| Region | `us-east-1` |
| OS | Amazon Linux 2023 |
| User | `ec2-user` |
| PEM key | `C:\Users\sachi\OneDrive\Documents\GitHub\ec2-access.pem` |

### Stack

| Layer | Tool |
|---|---|
| Process manager | PM2 v6 (auto-restarts, survives reboots via systemd) |
| Reverse proxy | nginx 1.28 (port 80 → 3456) |
| Runtime | Node.js v20 |
| Source | GitHub (`https://github.com/sachin245/TinxyUI`) |

### Deploy a change

The fastest deploy is a one-liner using the helper batch script:

```bat
C:\Users\sachi\push_and_deploy.bat
```

This script:
1. `git add` + `git commit` + `git push origin main`
2. SSH into EC2 → `git pull origin main`
3. `pm2 restart tinxy-ui`

Output is written to `C:\Users\sachi\deploy_result.txt`.

### Manual SSH

```bash
ssh -i "C:\Users\sachi\OneDrive\Documents\GitHub\ec2-access.pem" \
    -o StrictHostKeyChecking=no \
    ec2-user@54.91.145.63
```

> **Note:** Use Git Bash's SSH (`C:\Program Files\Git\usr\bin\ssh.exe`), not Windows OpenSSH — the Windows binary exits with code 255 silently in this environment.

### nginx config

`/etc/nginx/conf.d/tinxy-ui.conf` — proxies all traffic on port 80 to `localhost:3456`:

```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://localhost:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### EC2 Security Group

| Port | Status | Purpose |
|---|---|---|
| 22 | Open | SSH |
| 80 | Open | Web app (nginx) |
| 443 | Blocked | — |
| 3456 | Blocked | App runs internally; nginx proxies port 80 → 3456 |

---

## Architecture

```
Browser
  │
  ├─ GET  /v2/devices/                          → list all devices
  ├─ GET  /v2/devices/:id/state?deviceNumber=N  → get node state
  └─ POST /v2/devices/:id/toggle                → toggle / set speed
       body: { request: { state: 0|1, brightness: 0|33|66|100 }, deviceNumber: N }

Polling: every 10 s, all registered nodes are fetched concurrently (Promise.allSettled)
Auth:    Bearer token in Authorization header, stored in localStorage
```

### Key modules in `app.js`

| Function | Purpose |
|---|---|
| `tinxyFetch(path, options)` | Authenticated fetch wrapper with error handling |
| `loadDevices()` | Fetches device list, applies grouping, renders cards |
| `buildDeviceCard(device)` | Renders one device as a card |
| `buildGroupedCard(name, devices[])` | Merges multiple devices into one card |
| `buildSwitchRow(device, idx, ...)` | Single relay toggle row |
| `buildFanRow(device, idx, ...)` | Fan with Off/Low/Med/High speed buttons |
| `registerNode(deviceId, nodeNumber, fn)` | Registers a node for polling |
| `pollAllStates()` | Concurrent state refresh for all registered nodes |
| `brightnessToSpeed(isOn, brightness)` | Maps API brightness % → speed index 0–3 |

---

## API Reference

**Base URL:** `https://backend.tinxy.in`
**Auth:** `Authorization: Bearer <token>`

### Get all devices
```
GET /v2/devices/
```

### Get node state
```
GET /v2/devices/:deviceId/state?deviceNumber=:N
Response: { state: "ON"|"OFF", brightness: 0|33|66|100 }
```

### Toggle / set state
```
POST /v2/devices/:deviceId/toggle
Body: {
  request: { state: 0|1, brightness: 0|33|66|100 },
  deviceNumber: N
}
Response: { state: "ON"|"OFF", brightness: number }
```

---

## Device Grouping

Devices can be merged into a single card by editing `DEVICE_GROUPS` in `app.js`:

```js
const DEVICE_GROUPS = [
  { groupName: 'Sachin Room', match: ['Sachin Room', 'Laptop'] },
];
```

- `groupName` — label shown on the merged card
- `match` — array of Tinxy device names to include in the group
- Devices not matched by any group render as individual cards
- The badge on the merged card counts ON states across **all** nodes of all grouped devices

---

## Fan Speed Fix

**Bug:** The original code sent `brightness: 1/2/3` for Low/Med/High. The Tinxy API expects **percentage values**.

**Fix (commit `ac1ac1b`):**

| Speed | Old (wrong) | Fixed |
|---|---|---|
| Off | `0` | `0` |
| Low | `1` | `33` |
| Med | `2` | `66` |
| High | `3` | `100` |

The state API also returns these percentage values, so `brightnessToSpeed()` maps them back to a speed index for the UI.

---

## Known Issues

### Laptop switch returns 500
The "Laptop" smart switch (`deviceId: 69a6e067277dfbeb910cd662`) returns `500 Internal Server Error` on toggle. The state endpoint reads fine (`{ state: "OFF", status: 0 }`), confirming the device is physically **offline** (not connected to WiFi). The code and API payload are correct — power-cycle the device to bring it back online.

---

## Commit History & Changes

| Commit | Description |
|---|---|
| `c2a31e2` | Initial commit — Tinxy light control UI |
| `ac1ac1b` | **Fix fan speed commands** — use correct brightness values (33/66/100) |
| `cd477ad` | Add deployment configs: package.json and PM2 ecosystem file |
| `53c42a8` | Set default API token on app start |
| `a08612b` | Group Sachin Room and Laptop into one card |
| `a085c7d` | Single-node naming: use device name instead of generic "Switch 1" |
