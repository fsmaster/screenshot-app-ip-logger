# Screenshot App IP Logger

A simple web application similar to Grabify: generate short tracking links that log visitor information (IP, User-Agent, Accept-Language) when accessed. Supports both URL redirection and image serving.

**Important legal note**  
This tool logs personal data (IP addresses, browser details). Use responsibly and in compliance with privacy laws (GDPR, CCPA, etc.). Do not use for malicious purposes.

## Features

- Modern landing page with URL input or image upload — pick a file, drag &amp; drop,
  or **paste straight from the clipboard** (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>V</kbd>,
  ideal for screenshots), with a thumbnail preview of what you're about to upload
- Generates two links:
  - Short link (`https://scerenshot.app/xxxxxx`) → redirects to URL or serves image + logs visitor
  - Tracking link (`https://scerenshot.app/track/yyyyyy`) → shows list of visits
- **Blur teaser** (images): tick the **Blur** checkbox when uploading to serve a
  pixelated, blurred preview behind a "View full resolution" call-to-action. The
  visitor is logged on open; the crisp original loads when they click. Pixelation
  is generated once at upload with [jimp](https://www.npmjs.com/package/jimp)
  (squash to 80&nbsp;px wide, nearest-neighbour upscale).
- **Visitor geolocation**: each visit is resolved to country / region / city / ISP and
  plotted on an interactive map (Leaflet + OpenStreetMap, no API key)
- Stores data in SQLite (`tracker.db`)
- Runs standalone on HTTPS 443, **or** behind a reverse proxy (nginx/Apache)

## Requirements

- Ubuntu 24.04 LTS (or compatible)
- Domain name pointed to server IP
- Root/sudo access
- Open ports: 22 (SSH), 80 (Certbot), 443 (app)

## Quick Installation

```bash
# 1. Update & install basics
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw certbot nano

# 2. Firewall
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

# 3. Node.js 20.x LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 4. Project directory
sudo mkdir -p /var/www/screenshot-app
sudo chown -R $USER:$USER /var/www/screenshot-app
cd /var/www/screenshot-app

# 5. Clone repo
git clone https://github.com/fsmaster/screenshot-app-ip-logger.git .

# 6. Install dependencies (critical!)
npm install
# or if permission issues:
# sudo npm install

# 7. Create uploads folder (required for images!)
mkdir -p public/uploads
chmod 755 public/uploads

# 8. Get Let's Encrypt certificate
sudo certbot certonly --standalone \
  -d scerenshot.app \
  --non-interactive --agree-tos --email igor@fsmaster.com

# 9. Install & start with PM2 (runs as root to bind port 443)
sudo npm install -g pm2
sudo pm2 start app.js --name screenshot-app
sudo pm2 save
sudo pm2 startup   # run the exact command printed here
```


## Running behind a reverse proxy (recommended when sharing the host)

If port 443 is already in use by another site on the same server, run the app in
HTTP mode on localhost and let nginx terminate TLS:

```bash
# Start the app on an internal port (no certs are read in this mode)
HTTP_PORT=3001 APP_DOMAIN=scerenshot.app node app.js
```

Environment variables:

| Variable      | Default               | Purpose                                              |
|---------------|-----------------------|------------------------------------------------------|
| `HTTP_PORT`   | _(unset)_             | If set, run plain HTTP on `BIND_ADDR` behind a proxy |
| `BIND_ADDR`   | `127.0.0.1` (HTTP)    | Interface to bind                                    |
| `APP_DOMAIN`  | `scerenshot.app`      | Public domain used to build share links              |
| `BASE_URL`    | `https://$APP_DOMAIN` | Override the full public base URL                    |
| `CERT_DOMAIN` | `$APP_DOMAIN`         | Cert directory name (standalone HTTPS mode only)     |

Example nginx server block proxying to the app:

```nginx
server {
    listen 443 ssl;
    server_name scerenshot.app www.scerenshot.app;
    ssl_certificate     /etc/letsencrypt/live/scerenshot.app/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/scerenshot.app/privkey.pem;

    client_max_body_size 12M;   # allow image uploads

    location / {
        proxy_pass       http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
