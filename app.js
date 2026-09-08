// app.js
// Express server for URL/image tracking / IP logger.
//
// Two run modes:
//   1. Standalone HTTPS (default) — binds 443 and reads Let's Encrypt certs directly.
//   2. Reverse-proxy / HTTP — set HTTP_PORT to run plain HTTP on localhost behind
//      nginx/Apache (which terminates TLS). No certs are read in this mode.
//
// Visitor geolocation (country / region / city / coordinates) is resolved per visit
// and rendered on the tracking page together with an interactive map.

const express     = require('express');
const https       = require('https');
const http        = require('http');
const fs          = require('fs');
const multer      = require('multer');
const sqlite3     = require('sqlite3').verbose();
const crypto      = require('crypto');
const bodyParser  = require('body-parser');
const path        = require('path');
const Jimp        = require('jimp');

const app = express();

// ─────────────────────────────────────────────────────────────────────────────
// Configuration (env-overridable)
// ─────────────────────────────────────────────────────────────────────────────

// NOTE: do not read process.env.HOSTNAME — on Linux that is the machine hostname.
const APP_DOMAIN  = process.env.APP_DOMAIN  || 'scerenshot.app';
const BASE_URL    = process.env.BASE_URL    || `https://${APP_DOMAIN}`;
const CERT_DOMAIN = process.env.CERT_DOMAIN || APP_DOMAIN;

// If HTTP_PORT is set we run plain HTTP on localhost behind a reverse proxy.
const HTTP_PORT   = process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT, 10) : null;
const HTTPS_PORT  = process.env.PORT ? parseInt(process.env.PORT, 10) : 443;
const BIND_ADDR   = process.env.BIND_ADDR || (HTTP_PORT ? '127.0.0.1' : '0.0.0.0');

// Trust X-Forwarded-* so req.ip reflects the real client behind a proxy.
app.set('trust proxy', true);

// View engine setup (EJS for tracking page)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// ─────────────────────────────────────────────────────────────────────────────
// Multer setup – image uploads
// ─────────────────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});

const upload = multer({ storage });

// ─────────────────────────────────────────────────────────────────────────────
// SQLite database setup
// ─────────────────────────────────────────────────────────────────────────────

const db = new sqlite3.Database('tracker.db', (err) => {
  if (err) {
    console.error('SQLite connection failed:', err.message);
    process.exit(1);
  }
  console.log('Connected to SQLite database (tracker.db)');
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS links (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT UNIQUE NOT NULL,
      track_code TEXT UNIQUE NOT NULL,
      type       TEXT NOT NULL CHECK(type IN ('url', 'image')),
      target     TEXT NOT NULL,
      blur       INTEGER NOT NULL DEFAULT 0,
      blur_interactive INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Migrate older databases that predate the blur column.
  db.all(`PRAGMA table_info(links)`, (err, cols) => {
    if (err || !cols) return;
    if (!cols.some(c => c.name === 'blur')) {
      db.run(`ALTER TABLE links ADD COLUMN blur INTEGER NOT NULL DEFAULT 0`);
    }
  });

  // Migrate older databases that predate the blur_interactive column.
  db.all(`PRAGMA table_info(links)`, (err, cols) => {
    if (err || !cols) return;
    if (!cols.some(c => c.name === 'blur_interactive')) {
      db.run(`ALTER TABLE links ADD COLUMN blur_interactive INTEGER NOT NULL DEFAULT 0`);
    }
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS visits (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id      INTEGER NOT NULL,
      ip           TEXT NOT NULL,
      user_agent   TEXT,
      accept_lang  TEXT,
      country      TEXT,
      country_code TEXT,
      region       TEXT,
      city         TEXT,
      lat          REAL,
      lon          REAL,
      org          TEXT,
      visited_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (link_id) REFERENCES links(id)
    )
  `);

  // Migrate older databases that predate the geolocation columns.
  db.all(`PRAGMA table_info(visits)`, (err, cols) => {
    if (err || !cols) return;
    const have = new Set(cols.map(c => c.name));
    const wanted = [
      ['country', 'TEXT'], ['country_code', 'TEXT'], ['region', 'TEXT'],
      ['city', 'TEXT'], ['lat', 'REAL'], ['lon', 'REAL'], ['org', 'TEXT'],
    ];
    wanted.forEach(([name, type]) => {
      if (!have.has(name)) db.run(`ALTER TABLE visits ADD COLUMN ${name} ${type}`);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function randomCode() {
  return crypto.randomBytes(3).toString('hex');
}

// Width (px) the image is squashed down to before being blown back up. The
// smaller this is, the chunkier / more unrecognisable the pixelation.
const BLUR_WIDTH = 80;
const BLUR_WIDTH_INTERACTIVE = 40;  // heavy pixelation for reveal

// Derive the on-disk name of an interactive blur file: "1720000000.png" -> "1720000000.interactive.png".
function interactiveBlurFilename(filename) {
  const ext = path.extname(filename);
  return filename.slice(0, filename.length - ext.length) + '.interactive' + ext;
}


// Derive the on-disk name of an image's blurred sibling: "1720000000.png" -> "1720000000.blur.png".
function blurFilename(filename) {
  const ext = path.extname(filename);
  return filename.slice(0, filename.length - ext.length) + '.blur' + ext;
}

// Produce a heavily-pixelated, softly-blurred copy of an uploaded image so the
// short link renders a teasing low-res preview that begs to be clicked for the
// full-resolution original. Squash to BLUR_WIDTH px wide, blow it back up with
// nearest-neighbour sampling (hard mosaic), then a light gaussian to blend the
// blocks into a "can't-quite-make-it-out" haze. Resolves true on success.
async function makeBlur(srcPath, destPath, width = BLUR_WIDTH) {
  try {
    const img = await Jimp.read(srcPath);
    const w = img.bitmap.width;
    const h = img.bitmap.height;
    const tw = Math.max(1, width);
    const th = Math.max(1, Math.round((h * tw) / w));

    img
      .resize(tw, th)                                  // squash to a tiny thumbnail
      .resize(w, h, Jimp.RESIZE_NEAREST_NEIGHBOR)      // blow back up -> crisp blocky mosaic
      .blur(1);                                        // 1px to kill hard aliasing only

    await img.writeAsync(destPath);
    return true;
  } catch (e) {
    console.error('Blur generation failed:', e.message);
    return false;
  }
}

// Normalise an IP for lookup (strip IPv4-mapped IPv6 prefix).
function normaliseIp(ip) {
  return (ip || '').replace(/^::ffff:/i, '').trim();
}

// True for addresses that cannot be geolocated (loopback / private ranges).
function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^(fc|fd)/i.test(ip)) return true; // unique-local IPv6
  return false;
}

// Resolve geolocation via ipwho.is (free, HTTPS, no API key).
// Always resolves (null on any failure) so a lookup never blocks logging.
function lookupGeo(ip) {
  return new Promise((resolve) => {
    const clean = normaliseIp(ip);
    if (isPrivateIp(clean)) return resolve(null);

    const url = `https://ipwho.is/${encodeURIComponent(clean)}` +
                `?fields=success,country,country_code,region,city,latitude,longitude,connection`;

    const req = https.get(url, { timeout: 4000 }, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve(j && j.success ? j : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// Log a visit immediately, then enrich it with geolocation asynchronously so the
// visitor's redirect/image is never delayed by the external lookup.
function logVisit(linkId, req) {
  const ip = normaliseIp(
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket.remoteAddress
  );
  const ua   = req.get('User-Agent') || null;
  const lang = req.get('Accept-Language') || null;

  db.run(
    `INSERT INTO visits (link_id, ip, user_agent, accept_lang) VALUES (?, ?, ?, ?)`,
    [linkId, ip, ua, lang],
    function (err) {
      if (err || !this.lastID) return;
      const visitId = this.lastID;
      lookupGeo(ip).then((g) => {
        if (!g) return;
        const org = g.connection?.org || g.connection?.isp || null;
        db.run(
          `UPDATE visits
             SET country=?, country_code=?, region=?, city=?, lat=?, lon=?, org=?
           WHERE id=?`,
          [g.country, g.country_code, g.region, g.city, g.latitude, g.longitude, org, visitId]
        );
      });
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// Landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Create new tracking link
app.post('/create', upload.single('image'), async (req, res) => {
  const { url } = req.body;
  const file    = req.file;
  // Blur options only apply to images. Checkboxes arrive as "on" when ticked.
  const wantBlur         = !!file && (req.body.blur === 'on' || req.body.blur === '1' || req.body.blur === 'true');
  const wantBlurInteractive = !!file && (req.body.blur_interactive === 'on' || req.body.blur_interactive === '1' || req.body.blur_interactive === 'true');

  let type, target;

  if (file) {
    type   = 'image';
    target = file.filename;
  } else if (url?.trim()) {
    type   = 'url';
    target = url.trim();
    try {
      new URL(target);
    } catch {
      return res.status(400).send('Invalid URL format');
    }
  } else {
    return res.status(400).send('Provide a URL or upload an image');
  }

  // Pre-generate blurred versions if enabled. Fall back silently on failure.
  let blur = 0, blur_interactive = 0;
  const srcPath = path.join(__dirname, 'public/uploads', target);

  if (wantBlur) {
    const destPath = path.join(__dirname, 'public/uploads', blurFilename(target));
    blur = (await makeBlur(srcPath, destPath, BLUR_WIDTH)) ? 1 : 0;
  }

  if (wantBlurInteractive) {
    const destPath = path.join(__dirname, 'public/uploads', interactiveBlurFilename(target));
    blur_interactive = (await makeBlur(srcPath, destPath, BLUR_WIDTH_INTERACTIVE)) ? 1 : 0;
  }

  const code      = randomCode();
  const trackCode = randomCode();

  db.run(
    `INSERT INTO links (code, track_code, type, target, blur, blur_interactive) VALUES (?, ?, ?, ?, ?, ?)`,
    [code, trackCode, type, target, blur, blur_interactive],
    function (err) {
      if (err) {
        console.error('Database insert failed:', err.message);
        return res.status(500).send('Error creating tracking link');
      }

      let blurNote = '';
      if (blur_interactive) {
        blurNote = ' <em>(heavily pixelated, click to reveal)</em>';
      } else if (blur) {
        blurNote = ' <em>(pixelated teaser)</em> — add <code>?full=1</code> for original';
      }

      res.send(`
        <h2>Success!</h2>
        <p>Share link: <strong><a href="${BASE_URL}/${code}">${BASE_URL}/${code}</a></strong>${blurNote}</p>
        <p>Track visits: <strong><a href="${BASE_URL}/track/${trackCode}">${BASE_URL}/track/${trackCode}</a></strong></p>
      `);
    }
  );
});



// Handle short link (redirect or serve image + log visit)

// Handle short link (redirect or serve image + log visit)
app.get('/:code', (req, res) => {
  const { code } = req.params;

  db.get('SELECT * FROM links WHERE code = ?', [code], (err, row) => {
    if (err) {
      console.error('Database query error:', err.message);
      return res.status(500).send('Server error');
    }
    if (!row) {
      return res.status(404).send('Link not found');
    }

    const uploads = path.join(__dirname, 'public/uploads');

    // Log the visit (for all primary accesses — blurred or not).
    logVisit(row.id, req);

    if (row.type === 'url') {
      res.redirect(row.target);
    } else if (row.type === 'image') {
      // Interactive blur: render HTML page with click-to-reveal.
      if (row.blur_interactive) {
        return res.render('interactive', { code: row.code });
      }

      const blurPath = path.join(uploads, blurFilename(row.target));
      const fullPath = path.join(uploads, row.target);

      // Standard blur: show teaser by default, full-res if ?full=1.
      if (row.blur && req.query.full !== '1' && fs.existsSync(blurPath)) {
        return res.sendFile(blurPath, (err) => {
          if (err) {
            console.error('File send error:', err.message);
            res.status(404).send('Image not found');
          }
        });
      }

      // Sub-resources for interactive reveal (?img=interactive|full).
      if (req.query.img === 'interactive' || req.query.img === 'full') {
        const intPath = path.join(uploads, interactiveBlurFilename(row.target));
        const wantInteractive = req.query.img === 'interactive' && row.blur_interactive && fs.existsSync(intPath);
        return res.sendFile(wantInteractive ? intPath : fullPath, (err) => {
          if (err) {
            console.error('File send error:', err.message);
            res.status(404).send('Image not found');
          }
        });
      }

      // Normal or full-res view: serve the original.
      res.sendFile(fullPath, (err) => {
        if (err) {
          console.error('File send error:', err.message);
          res.status(404).send('Image not found');
        }
      });
    }
  });
});

app.get('/track/:track', (req, res) => {
  const { track } = req.params;

  db.get('SELECT id FROM links WHERE track_code = ?', [track], (err, row) => {
    if (err || !row) {
      return res.status(404).send('Tracker not found');
    }

    db.all(
      `SELECT ip, user_agent, accept_lang, visited_at,
              country, country_code, region, city, lat, lon, org
       FROM visits WHERE link_id = ? ORDER BY visited_at DESC`,
      [row.id],
      (err, rows) => {
        if (err) {
          console.error('Visits query failed:', err.message);
          return res.status(500).send('Error loading statistics');
        }

        res.render('track', { visits: rows });
      }
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Server start
// ─────────────────────────────────────────────────────────────────────────────

if (HTTP_PORT) {
  // Behind a reverse proxy: plain HTTP on localhost, TLS handled upstream.
  http.createServer(app).listen(HTTP_PORT, BIND_ADDR, () => {
    console.log(`Server running (HTTP) at http://${BIND_ADDR}:${HTTP_PORT} — public ${BASE_URL}`);
  });
} else {
  // Standalone HTTPS using Let's Encrypt certs.
  const options = {
    key:  fs.readFileSync(`/etc/letsencrypt/live/${CERT_DOMAIN}/privkey.pem`),
    cert: fs.readFileSync(`/etc/letsencrypt/live/${CERT_DOMAIN}/fullchain.pem`),
  };
  https.createServer(options, app).listen(HTTPS_PORT, BIND_ADDR, () => {
    console.log(`Server running (HTTPS) at ${BASE_URL}`);
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received – shutting down gracefully');
  db.close(() => process.exit(0));
});
