// app.js ── Express app running directly on HTTPS (port 443)

const express     = require('express');
const https       = require('https');
const fs          = require('fs');
const multer      = require('multer');
const sqlite3     = require('sqlite3').verbose();
const crypto      = require('crypto');
const bodyParser  = require('body-parser');
const path        = require('path');

const app = express();
const PORT = 443;   // ← we bind directly to 443

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// ── Multer for image uploads ────────────────────────────────────────────────
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads/'),
    filename:    (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, Date.now() + ext);
    }
});
const upload = multer({ storage });

// ── SQLite ──────────────────────────────────────────────────────────────────
const db = new sqlite3.Database('tracker.db', err => {
    if (err) {
        console.error('DB open failed:', err.message);
        process.exit(1);
    }
    console.log('SQLite connected');
});

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS links (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            code       TEXT UNIQUE NOT NULL,
            track_code TEXT UNIQUE NOT NULL,
            type       TEXT NOT NULL,     -- 'url' | 'image'
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

// Helper: 6-char random hex
function randomCode() {
    return crypto.randomBytes(3).toString('hex');
}

// ── Routes ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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
        try { new URL(target); } catch {
            return res.status(400).send('Invalid URL');
        }
    } else {
        return res.status(400).send('URL or image required');
    }

    const code      = randomCode();
    const trackCode = randomCode();

    db.run(
        `INSERT INTO links (code, track_code, type, target) VALUES (?,?,?,?)`,
        [code, trackCode, type, target],
        function(err) {
            if (err) {
                console.error(err);
                return res.status(500).send('DB error');
            }

            const base = 'https://scerenshot.app';
            res.send(`
                <h2>Created</h2>
                <p>Share: <a href="${base}/${code}">${base}/${code}</a></p>
                <p>Track: <a href="${base}/track/${trackCode}">${base}/track/${trackCode}</a></p>
            `);
        }
    );
});

app.get('/:code', (req, res) => {
    const { code } = req.params;

    db.get('SELECT * FROM links WHERE code = ?', [code], (err, row) => {
        if (err || !row) return res.status(404).send('Not found');

        // Log visit
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
        db.run(
            `INSERT INTO visits (link_id, ip, user_agent, accept_lang) VALUES (?,?,?,?)`,
            [row.id, ip, req.get('User-Agent'), req.get('Accept-Language')]
        );

        if (row.type === 'url') {
            res.redirect(row.target);
        } else {
            res.sendFile(path.join(__dirname, 'public/uploads', row.target));
        }
    });
});

app.get('/track/:track', (req, res) => {
    const { track } = req.params;

    db.get('SELECT id FROM links WHERE track_code = ?', [track], (err, row) => {
        if (err || !row) return res.status(404).send('Not found');

        db.all(
            `SELECT ip, user_agent, accept_lang, visited_at
             FROM visits WHERE link_id = ? ORDER BY visited_at DESC`,
            [row.id],
            (err, rows) => {
                if (err) return res.status(500).send('DB error');
                res.render('track', { visits: rows });
            }
        );
    });
});

// ── HTTPS Server ────────────────────────────────────────────────────────────
const options = {
    key:  fs.readFileSync('./certs/privkey.pem'),
    cert: fs.readFileSync('./certs/fullchain.pem')
};

https.createServer(options, app).listen(PORT, () => {
    console.log(`HTTPS server running on https://scerenshot.app:${PORT}`);
});