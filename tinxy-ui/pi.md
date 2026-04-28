# Raspberry Pi Deployment Guide — Dudu Life Control

## Instance Details

| Property | Value |
|---|---|
| Hostname | `connect-pi` → accessible at `connect-pi.local` |
| App port | `6001` (internal, proxied by nginx) |
| Live URL | `https://connect-pi.local` |
| Repo path on Pi | `/home/pi/TinxyUI` *(adjust if different user)* |

## Stack

| Layer | Tool |
|---|---|
| Runtime | Node.js v20 |
| Process manager | PM2 (auto-restarts, survives reboots) |
| Reverse proxy | nginx (port 80 + 443 → 6001) |
| SSL | mkcert (locally-trusted CA) **or** Let's Encrypt via nip.io if Pi has a public IP |

---

## SSH into Pi

```bash
ssh pi@connect-pi.local
# or by IP:
ssh pi@192.168.x.x
```

---

## First-Time Setup on Pi

### 1. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v  # should be v20.x
```

### 2. Install PM2

```bash
sudo npm install -g pm2
```

### 3. Install nginx

```bash
sudo apt install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

### 4. Clone repo and start app

```bash
cd ~
git clone https://github.com/sachin245/TinxyUI.git
cd TinxyUI
pm2 start ecosystem.pi.config.js
pm2 save
pm2 startup  # run the printed command to enable on reboot
```

---

## HTTPS Setup — Option A: mkcert (recommended for local network)

mkcert creates a real CA trusted by your devices. No browser warnings once you install the CA.

### Install mkcert on the Pi

```bash
sudo apt install -y libnss3-tools wget
wget -q https://dl.filippo.io/mkcert/latest?for=linux/arm64 -O mkcert
# For 32-bit Pi (armv7):
# wget -q https://dl.filippo.io/mkcert/latest?for=linux/arm -O mkcert
chmod +x mkcert
sudo mv mkcert /usr/local/bin/mkcert
mkcert -version
```

### Create local CA and certificate

```bash
mkcert -install
sudo mkdir -p /etc/ssl/tinxy-ui
sudo mkcert -key-file /etc/ssl/tinxy-ui/connect-pi.local-key.pem \
            -cert-file /etc/ssl/tinxy-ui/connect-pi.local.pem \
            connect-pi.local
```

### Trust the CA on other devices

The root CA is at `$(mkcert -CAROOT)/rootCA.pem`.

- **macOS/Linux:** copy to device and run `mkcert -install` or add to system trust store
- **iOS:** AirDrop the `rootCA.pem`, tap to install, then enable in Settings → General → About → Certificate Trust Settings
- **Android:** Settings → Security → Install certificates

---

## HTTPS Setup — Option B: Let's Encrypt via nip.io (public IP only)

Use this if your Pi is reachable from the internet (port 80 + 443 forwarded on your router).

```bash
# Replace dots with hyphens in your Pi's public IP, e.g. 1.2.3.4 → 1-2-3-4
DOMAIN="YOUR-PUBLIC-IP-HERE.nip.io"

sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d $DOMAIN \
  --non-interactive --agree-tos \
  -m sac.khurana@gmail.com --redirect
```

Then update the nginx `server_name` below to `$DOMAIN`.

---

## nginx Config

File: `/etc/nginx/conf.d/tinxy-ui.conf`

```nginx
server {
    listen 80;
    server_name connect-pi.local;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name connect-pi.local;

    # mkcert certs — swap paths if using Let's Encrypt
    ssl_certificate     /etc/ssl/tinxy-ui/connect-pi.local.pem;
    ssl_certificate_key /etc/ssl/tinxy-ui/connect-pi.local-key.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://localhost:6001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Write the config then reload:

```bash
sudo nano /etc/nginx/conf.d/tinxy-ui.conf
sudo nginx -t && sudo systemctl reload nginx
```

---

## Deploy a Code Change

```bash
ssh pi@connect-pi.local \
  "cd ~/TinxyUI && git pull origin main && pm2 restart tinxy-ui && pm2 status"
```

---

## PM2 Commands

```bash
pm2 status                         # check app status
pm2 restart tinxy-ui               # restart app
pm2 logs tinxy-ui                  # view logs
pm2 stop tinxy-ui                  # stop app
pm2 start ecosystem.pi.config.js   # start from config (first time)
```

---

## CI/CD — GitHub Actions Self-Hosted Runner

The Pi runs a GitHub Actions runner agent that polls GitHub for jobs. No inbound ports, no SSH keys to manage. Workflow file: `.github/workflows/deploy-pi.yml` (auto-deploys on push to `main`).

### One-time runner installation on the Pi

**1. Get a registration token from GitHub:**

GitHub repo → **Settings** → **Actions** → **Runners** → **New self-hosted runner** → choose **Linux** + **ARM64** (or **ARM** for 32-bit Pi). Copy the token shown.

**2. Install the runner on the Pi:**

```bash
# Run as the pi user (NOT root)
mkdir -p ~/actions-runner && cd ~/actions-runner

# Download the latest ARM64 runner — check github.com/actions/runner/releases for newest
curl -o actions-runner-linux-arm64.tar.gz -L \
  https://github.com/actions/runner/releases/download/v2.319.1/actions-runner-linux-arm64-2.319.1.tar.gz
tar xzf actions-runner-linux-arm64.tar.gz

# Configure — paste the token from step 1
./config.sh \
  --url https://github.com/sachin245/TinxyUI \
  --token YOUR_REGISTRATION_TOKEN \
  --name connect-pi \
  --labels self-hosted,linux,ARM64,connect-pi \
  --work _work \
  --unattended
```

**3. Install as a systemd service (auto-start on reboot):**

```bash
sudo ./svc.sh install pi
sudo ./svc.sh start
sudo ./svc.sh status
```

**4. Verify in GitHub:**

Repo → **Settings** → **Actions** → **Runners** → should show `connect-pi` with a green dot.

### Trigger a deploy

```bash
# Auto: push to main
git push origin main

# Manual: from GitHub UI → Actions → "Deploy to Raspberry Pi" → Run workflow
```

### Runner maintenance

```bash
sudo ./svc.sh status     # check runner service
sudo ./svc.sh stop       # stop runner
sudo ./svc.sh start      # start runner
sudo ./svc.sh uninstall  # remove service (keeps config)
./config.sh remove --token TOKEN  # fully unregister
journalctl -u actions.runner.* -f  # live runner logs
```

### Why labels matter

The workflow targets `[self-hosted, linux, ARM64, connect-pi]`. If you ever add a second Pi, the `connect-pi` label keeps deploys pinned to *this* host. Don't drop the label.

---

## Troubleshooting

| Problem | Command |
|---|---|
| App not responding | `pm2 logs tinxy-ui` |
| nginx error | `sudo journalctl -u nginx -n 50` |
| Check port 6001 | `sudo ss -tlnp \| grep 6001` |
| Restart everything | `pm2 restart tinxy-ui && sudo systemctl reload nginx` |
| mkcert cert path | `mkcert -CAROOT` |
| Runner offline | `sudo ~/actions-runner/svc.sh status` |
| Runner logs | `journalctl -u actions.runner.* -n 100` |
