// app.js
// HTTPS Express server for URL/image tracking / IP logger
// Reads Let's Encrypt certificates directly from standard Certbot paths
// No symlinks or custom certs/ folder required in project

const express     = require('express');
const https       = require('https');
const fs          = require('fs');
const multer      = require('multer');
const sqlite3     = require('sqlite3').verbose();
const crypto      = require('crypto');
const bodyParser  = require('body-parser');
const path        = require('path');

const app = express();
const PORT = 443;

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const HOSTNAME = 'scerenshot.app';           // ← change domain here if needed
const BASE_URL = `https://${HOSTNAME}`;

// Domain used for certificate paths (usually same as HOSTNAME)
const CERT_DOMAIN = 'scerenshot.app';

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
  destination: (req, file, cb) => {
    cb(null, 'public/uploads/');
  },
  filename: (req, file, cb) => {
    // Unique filename: timestamp + original extension
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  }
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
      target     TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS visits (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id     INTEGER NOT NULL,
      ip          TEXT NOT NULL,
      user_agent  TEXT,
      accept_lang TEXT,
      visited_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (link_id) REFERENCES links(id)
    )
  `);
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: generate 6-character hex code
// ─────────────────────────────────────────────────────────────────────────────

function randomCode() {
  return crypto.randomBytes(3).toString('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// Landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Create new tracking link
app.post('/create', upload.single('image'), (req, res) => {
  const { url } = req.body;
  const file    = req.file;

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

  const code      = randomCode();
  const trackCode = randomCode();

  db.run(
    `INSERT INTO links (code, track_code, type, target) VALUES (?, ?, ?, ?)`,
    [code, trackCode, type, target],
    function (err) {
      if (err) {
        console.error('Database insert failed:', err.message);
        return res.status(500).send('Error creating tracking link');
      }

      res.send(`
        <h2>Success!</h2>
        <p>Share link: <strong><a href="${BASE_URL}/${code}">${BASE_URL}/${code}</a></strong></p>
        <p>Track visits: <strong><a href="${BASE_URL}/track/${trackCode}">${BASE_URL}/track/${trackCode}</a></strong></p>
      `);
    }
  );
});

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

    // Log visitor information
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    db.run(
      `INSERT INTO visits (link_id, ip, user_agent, accept_lang)
       VALUES (?, ?, ?, ?)`,
      [row.id, ip, req.get('User-Agent'), req.get('Accept-Language')]
    );

    if (row.type === 'url') {
      res.redirect(row.target);
    } else {
      res.sendFile(path.join(__dirname, 'public/uploads', row.target), (err) => {
        if (err) {
          console.error('File send error:', err.message);
          res.status(404).send('Image not found');
        }
      });
    }
  });
});

// Tracking / statistics page
app.get('/track/:track', (req, res) => {
  const { track } = req.params;

  db.get('SELECT id FROM links WHERE track_code = ?', [track], (err, row) => {
    if (err || !row) {
      return res.status(404).send('Tracker not found');
    }

    db.all(
      `SELECT ip, user_agent, accept_lang, visited_at
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
// HTTPS Server – load certs directly from Certbot location
// ─────────────────────────────────────────────────────────────────────────────

const options = {
  key:  fs.readFileSync(`/etc/letsencrypt/live/${CERT_DOMAIN}/privkey.pem`),
  cert: fs.readFileSync(`/etc/letsencrypt/live/${CERT_DOMAIN}/fullchain.pem`),
  // ca:   fs.readFileSync(`/etc/letsencrypt/live/${CERT_DOMAIN}/chain.pem`), // usually not needed
};

https.createServer(options, app).listen(PORT, () => {
  console.log(`Server running at ${BASE_URL}`);
});

// Graceful shutdown (optional but good practice)
process.on('SIGTERM', () => {
  console.log('SIGTERM received – shutting down gracefully');
  db.close(() => {
    process.exit(0);
  });
});