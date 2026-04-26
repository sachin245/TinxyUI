# AWS Deployment Guide — Dudu Life Control

## Instance Details

| Property | Value |
|---|---|
| IP | `54.91.145.63` *(check AWS console — changes on restart)* |
| Region | `us-east-1` |
| OS | Amazon Linux 2023 |
| User | `ec2-user` |
| PEM key | `C:\Users\sachi\OneDrive\Documents\GitHub\ec2-access.pem` |
| App repo | `https://github.com/sachin245/TinxyUI` |
| Repo path on EC2 | `/home/ec2-user/TinxyUI` |

## Stack

| Layer | Tool |
|---|---|
| Runtime | Node.js v20 |
| Process manager | PM2 v6 (auto-restarts, survives reboots) |
| Reverse proxy | nginx 1.28 (port 80 + 443 → 3456) |
| SSL | Let's Encrypt via certbot (nip.io domain) |
| Live URL | `https://54-91-145-63.nip.io` *(update IP segment if instance IP changes)* |

---

## SSH into EC2

Use **Git Bash SSH** — Windows OpenSSH exits silently with code 255.

```bash
"C:\Program Files\Git\usr\bin\ssh.exe" \
  -i "C:\Users\sachi\OneDrive\Documents\GitHub\ec2-access.pem" \
  -o StrictHostKeyChecking=no \
  ec2-user@54.91.145.63
```

---

## Deploy a Code Change (standard flow)

Run locally after pushing to `main`:

```bash
"C:\Program Files\Git\usr\bin\ssh.exe" \
  -i "C:\Users\sachi\OneDrive\Documents\GitHub\ec2-access.pem" \
  -o StrictHostKeyChecking=no \
  ec2-user@54.91.145.63 \
  "cd /home/ec2-user/TinxyUI && git pull origin main && pm2 restart tinxy-ui && pm2 status"
```

---

## EC2 Security Group

Security Group ID: `sg-0e31203d805a7239b` (default)

| Port | Protocol | Source | Purpose |
|---|---|---|---|
| 22 | TCP | 0.0.0.0/0 | SSH |
| 80 | TCP | 0.0.0.0/0 | HTTP (nginx → HTTPS redirect) |
| 443 | TCP | 0.0.0.0/0 | HTTPS (nginx → app) |
| 8000 | TCP | 0.0.0.0/0 | Custom (pre-existing) |
| 8501 | TCP | 0.0.0.0/0 | Custom (pre-existing) |

---

## nginx Config

File: `/etc/nginx/conf.d/tinxy-ui.conf`

```nginx
server {
    listen 80;
    server_name 54-91-145-63.nip.io;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name 54-91-145-63.nip.io;

    ssl_certificate     /etc/letsencrypt/live/54-91-145-63.nip.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/54-91-145-63.nip.io/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

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

Reload nginx after editing:
```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## PM2 Commands

```bash
pm2 status                  # check app status
pm2 restart tinxy-ui        # restart app
pm2 logs tinxy-ui           # view logs
pm2 stop tinxy-ui           # stop app
pm2 start ecosystem.config.js  # start from config (first time)
```

PM2 config file: `/home/ec2-user/TinxyUI/ecosystem.config.js`

---

## SSL Certificate (Let's Encrypt)

- **Domain:** `54-91-145-63.nip.io` (nip.io maps IP → domain so Let's Encrypt works on raw IPs)
- **Cert path:** `/etc/letsencrypt/live/54-91-145-63.nip.io/`
- **Expires:** 2026-07-25 (auto-renews via certbot systemd timer)
- **Registered email:** `sac.khurana@gmail.com`

### If the EC2 IP changes — re-issue cert for new IP:

```bash
# 1. Get new cert (replace NEW_IP with actual IP, using hyphens)
sudo certbot --nginx -d NEW-IP-HERE.nip.io \
  --non-interactive --agree-tos \
  -m sac.khurana@gmail.com --redirect

# 2. Update nginx server_name and ssl paths manually if certbot can't auto-patch:
sudo nano /etc/nginx/conf.d/tinxy-ui.conf
# → change server_name and ssl_certificate paths to new domain

sudo nginx -t && sudo systemctl reload nginx
```

### Manual cert renewal:
```bash
sudo certbot renew --dry-run   # test renewal
sudo certbot renew             # force renew now
```

---

## First-Time Setup on a Fresh EC2 Instance

```bash
# 1. Install Node.js 20
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs

# 2. Install PM2
sudo npm install -g pm2

# 3. Install nginx
sudo dnf install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx

# 4. Install certbot
sudo dnf install -y certbot python3-certbot-nginx

# 5. Clone repo
cd /home/ec2-user
git clone https://github.com/sachin245/TinxyUI.git
cd TinxyUI

# 6. Start app with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # follow the printed command to enable on reboot

# 7. Write nginx config (see nginx Config section above)
sudo nano /etc/nginx/conf.d/tinxy-ui.conf
sudo nginx -t && sudo systemctl reload nginx

# 8. Issue SSL cert (replace IP with actual)
sudo certbot --nginx -d 54-91-145-63.nip.io \
  --non-interactive --agree-tos \
  -m sac.khurana@gmail.com --redirect
```

---

## Troubleshooting

| Problem | Command |
|---|---|
| App not responding | `pm2 logs tinxy-ui` |
| nginx error | `sudo journalctl -u nginx -n 50` |
| SSL cert error | `sudo certbot certificates` |
| Check what's on port 3456 | `sudo ss -tlnp \| grep 3456` |
| Restart everything | `pm2 restart tinxy-ui && sudo systemctl reload nginx` |
