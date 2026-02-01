# Screenshot App IP Logger

A simple web application similar to Grabify: generate short tracking links that log visitor information (IP, User-Agent, Accept-Language) when accessed. Supports both URL redirection and image serving.

**Important legal note**  
This tool logs personal data (IP addresses, browser details). Use responsibly and in compliance with privacy laws (GDPR, CCPA, etc.). Do not use for malicious purposes.

## Features

- Modern landing page with URL input or image upload
- Generates two links:
  - Short link (`https://scereneshot.app/xxxxxx`) → redirects to URL or serves image + logs visitor
  - Tracking link (`https://scereneshot.app/track/yyyyyy`) → shows list of visits
- Stores data in SQLite (`tracker.db`)
- Runs directly on HTTPS port 443 with Let's Encrypt certificates
- No reverse proxy required (no Nginx/Apache needed)

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
  -d scereneshot.app \
  --non-interactive --agree-tos --email your@email.com

# 9. Install & start with PM2 (runs as root to bind port 443)
sudo npm install -g pm2
sudo pm2 start app.js --name screenshot-app
sudo pm2 save
sudo pm2 startup   # run the exact command printed here
