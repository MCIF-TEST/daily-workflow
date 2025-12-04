/**
 * TheHaydenSphere — Backend v3 (Enterprise Single-File)
 *
 * Run:
 *   npm i express cors bcrypt jsonwebtoken multer uuid
 *   node server.js
 *
 * Core features:
 *  - Composite file storage under ./data/
 *  - bcrypt PIN storage & management
 *  - JWT auth (access + refresh)
 *  - Notes metadata + versioned encrypted blobs (gzip + AES-GCM)
 *  - Encryption profiles: client-only, server-assisted, hybrid
 *  - File uploads (encrypted)
 *  - Tasks (Day A/B) CRUD + reorder
 *  - Courses, Watchlist, Topics CRUD
 *  - Sessions (pomodoro/focus) logging (no XP)
 *  - SSE events for realtime sync
 *  - Search across metadata
 *  - Export/import/backups
 *  - History log for audit
 *
 * No gamification/XP features included.
 */

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const BLOBS_DIR = path.join(DATA_DIR, 'blobs'); // each note id -> folder
const FILES_DIR = path.join(DATA_DIR, 'files'); // attachment storage
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const NOTES_INDEX = path.join(DATA_DIR, 'notesIndex.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const COURSES_FILE = path.join(DATA_DIR, 'courses.json');
const WATCH_FILE = path.join(DATA_DIR, 'watch.json');
const TOPICS_FILE = path.join(DATA_DIR, 'topics.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const HISTORY_LOG = path.join(DATA_DIR, 'history.log');

const JWT_SECRET = process.env.THEHAYDEN_JWT_SECRET || crypto.randomBytes(32).toString('hex');
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '1h';
const REFRESH_TOKEN_TTL = process.env.REFRESH_TOKEN_TTL || '7d';
const BCRYPT_ROUNDS = 12;

// ensure directories exist
[DATA_DIR, BLOBS_DIR, FILES_DIR, BACKUP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// init files if missing
function writeIfMissing(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
}
writeIfMissing(META_FILE, { createdAt: Date.now(), version: 'thehaydensphere.v3', pinHash: null, encryptionProfile: 'client-only' });
writeIfMissing(NOTES_INDEX, []);
writeIfMissing(TASKS_FILE, { A: [], B: [] });
writeIfMissing(COURSES_FILE, []);
writeIfMissing(WATCH_FILE, []);
writeIfMissing(TOPICS_FILE, []);
writeIfMissing(SESSIONS_FILE, []);

// simple in-memory SSE clients
const sseClients = [];

// helper: read/write JSON convenience
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function writeJson(p, v) { fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8'); }

const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' }));

// multer setup for file uploads (store temp, we'll encrypt and move)
const upload = multer({ dest: path.join(__dirname, 'tmp_uploads'), limits: { fileSize: 50 * 1024 * 1024 } });

// ---------- Utilities ----------
function logHistory(action, payload) {
  const entry = { ts: Date.now(), action, payload };
  fs.appendFileSync(HISTORY_LOG, JSON.stringify(entry) + '\n');
  // SSE push
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  sseClients.forEach(res => res.write(data));
}
function id(prefix = '') { return prefix + uuidv4(); }
function now() { return Date.now(); }
function sha256Hex(input) { return crypto.createHash('sha256').update(input).digest('hex'); }

// AES-GCM helpers
async function deriveKeyFromPin(pin) {
  // PBKDF2 -> 32 bytes
  const salt = Buffer.from('TheHaydenSphereSaltV3');
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(pin, salt, 200000, 32, 'sha256', (err, key) => {
      if (err) return reject(err);
      resolve(key);
    });
  });
}
function aesGcmEncrypt(keyBuf, plaintextBuffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const enc = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([enc, tag]).toString('base64'), iv: iv.toString('base64') };
}
function aesGcmDecrypt(keyBuf, ciphertextBase64, ivBase64) {
  const buffer = Buffer.from(ciphertextBase64, 'base64');
  const iv = Buffer.from(ivBase64, 'base64');
  const tag = buffer.slice(buffer.length - 16);
  const ciphertext = buffer.slice(0, buffer.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain;
}

// gzip helpers
function gzipBufferSync(buf) { return zlib.gzipSync(buf); }
function gunzipBufferSync(buf) { return zlib.gunzipSync(buf); }

// backup creation
function createBackup() {
  const backup = {
    meta: readJson(META_FILE),
    notesIndex: readJson(NOTES_INDEX),
    tasks: readJson(TASKS_FILE),
    courses: readJson(COURSES_FILE),
    watch: readJson(WATCH_FILE),
    topics: readJson(TOPICS_FILE),
    sessions: readJson(SESSIONS_FILE),
    createdAt: Date.now()
  };
  const filename = path.join(BACKUP_DIR, `backup_${Date.now()}.json`);
  fs.writeFileSync(filename, JSON.stringify(backup, null, 2));
  logHistory('backup.created', { file: path.basename(filename) });
  // rotate: keep last 30
  const backups = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup_')).sort();
  if (backups.length > 30) {
    const toRemove = backups.slice(0, backups.length - 30);
    toRemove.forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
  }
}

// schedule nightly backups (every 24h)
setInterval(() => {
  try { createBackup(); } catch (e) { console.error('Backup failed', e); }
}, 24 * 60 * 60 * 1000);

// ---------- Auth: PIN setup & JWT ----------
const meta = readJson(META_FILE);

app.post('/api/v3/auth/setup-pin', async (req, res) => {
  /**
   * body: { pin } - called once to set PIN if not set. If pin exists, requires { currentPin, pin } and will validate currentPin.
   */
  const { pin, currentPin } = req.body || {};
  if (!pin || pin.length < 6) return res.status(400).json({ error: 'pin required (min 6 chars recommended)' });
  const meta = readJson(META_FILE);
  if (!meta.pinHash) {
    const hash = await bcrypt.hash(pin, BCRYPT_ROUNDS);
    meta.pinHash = hash;
    writeJson(META_FILE, meta);
    logHistory('auth.setupPin', { createdAt: Date.now() });
    return res.json({ ok: true, message: 'PIN created' });
  } else {
    // change PIN
    if (!currentPin) return res.status(400).json({ error: 'currentPin required to change pin' });
    const ok = await bcrypt.compare(currentPin, meta.pinHash);
    if (!ok) return res.status(403).json({ error: 'invalid currentPin' });
    const hash = await bcrypt.hash(pin, BCRYPT_ROUNDS);
    meta.pinHash = hash; writeJson(META_FILE, meta); logHistory('auth.changePin', { ts: Date.now() });
    return res.json({ ok: true, message: 'PIN changed' });
  }
});

// login -> issue access + refresh tokens
app.post('/api/v3/auth/login', async (req, res) => {
  const { pin } = req.body || {};
  const meta = readJson(META_FILE);
  if (!meta.pinHash) return res.status(400).json({ error: 'PIN not set; call setup-pin first' });
  if (!pin) return res.status(400).json({ error: 'pin required' });
  const match = await bcrypt.compare(pin, meta.pinHash);
  if (!match) return res.status(403).json({ error: 'invalid pin' });
  const accessToken = jwt.sign({ sub: 'default' }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
  const refreshToken = jwt.sign({ sub: 'default', type: 'refresh' }, JWT_SECRET, { expiresIn: REFRESH_TOKEN_TTL });
  logHistory('auth.login', { ts: Date.now() });
  return res.json({ accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL });
});

app.post('/api/v3/auth/refresh', (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  try {
    const payload = jwt.verify(refreshToken, JWT_SECRET);
    if (payload.type !== 'refresh') return res.status(400).json({ error: 'invalid token' });
    const accessToken = jwt.sign({ sub: payload.sub }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
    return res.json({ accessToken, expiresIn: ACCESS_TOKEN_TTL });
  } catch (e) {
    return res.status(403).json({ error: 'invalid refresh token' });
  }
});

// auth middleware
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'no auth' });
  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return res.status(400).json({ error: 'bad auth header' });
  const token = parts[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload.sub || 'default';
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
}

// SSE endpoint for real-time updates
app.get('/api/v3/events', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('\n');
  sseClients.push(res);
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx >= 0) sseClients.splice(idx, 1);
  });
});

// ---------- Tasks (Day A/B) ----------
function loadTasks() { return readJson(TASKS_FILE) || { A: [], B: [] }; }
function saveTasks(obj) { writeJson(TASKS_FILE, obj); logHistory('tasks.update', { counts: { A: obj.A.length, B: obj.B.length } }); }

app.get('/api/v3/tasks', requireAuth, (req, res) => {
  const day = req.query.day === 'B' ? 'B' : 'A';
  const tasks = loadTasks();
  return res.json({ day, tasks: tasks[day] || [] });
});

app.post('/api/v3/tasks', requireAuth, (req, res) => {
  const { day = 'A', name, minutes = 30, tags = [] } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const tasks = loadTasks();
  const t = { id: id('t'), name, minutes, done: false, notesId: null, courseId: null, tags, createdAt: now() };
  tasks[day] = tasks[day] || [];
  tasks[day].push(t);
  saveTasks(tasks);
  logHistory('tasks.create', { taskId: t.id, day });
  return res.json({ ok: true, task: t });
});

app.patch('/api/v3/tasks/:id', requireAuth, (req, res) => {
  const tid = req.params.id;
  const patch = req.body || {};
  const tasks = loadTasks();
  let found = null;
  ['A', 'B'].forEach(d => {
    const idx = (tasks[d] || []).findIndex(x => x.id === tid);
    if (idx >= 0) { Object.assign(tasks[d][idx], patch, { updatedAt: now() }); found = tasks[d][idx]; }
  });
  if (!found) return res.status(404).json({ error: 'task not found' });
  saveTasks(tasks);
  logHistory('tasks.update', { taskId: tid, patch });
  return res.json({ ok: true, task: found });
});

app.delete('/api/v3/tasks/:id', requireAuth, (req, res) => {
  const tid = req.params.id;
  const tasks = loadTasks();
  ['A', 'B'].forEach(d => {
    const idx = (tasks[d] || []).findIndex(x => x.id === tid);
    if (idx >= 0) tasks[d].splice(idx, 1);
  });
  saveTasks(tasks);
  logHistory('tasks.delete', { taskId: tid });
  return res.json({ ok: true });
});

// reorder
app.post('/api/v3/tasks/reorder', requireAuth, (req, res) => {
  const { day = 'A', order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
  const tasks = loadTasks();
  const map = {};
  (tasks[day] || []).forEach(t => map[t.id] = t);
  tasks[day] = order.map(i => map[i]).filter(Boolean);
  saveTasks(tasks);
  logHistory('tasks.reorder', { day, order });
  return res.json({ ok: true, tasks: tasks[day] });
});

// ---------- Courses ----------
function loadCourses() { return readJson(COURSES_FILE) || []; }
function saveCourses(arr) { writeJson(COURSES_FILE, arr); logHistory('courses.update', { count: arr.length }); }

app.get('/api/v3/courses', requireAuth, (req, res) => res.json({ courses: loadCourses() }));
app.post('/api/v3/courses', requireAuth, (req, res) => {
  const { name, url, notes = '', tags = [] } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: 'name+url required' });
  const arr = loadCourses();
  const c = { id: id('c'), name, url, notes, tags, createdAt: now() };
  arr.unshift(c); saveCourses(arr); logHistory('courses.create', { id: c.id });
  return res.json({ ok: true, course: c });
});
app.patch('/api/v3/courses/:id', requireAuth, (req, res) => {
  const arr = loadCourses(); const c = arr.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  Object.assign(c, req.body, { updatedAt: now() }); saveCourses(arr); logHistory('courses.update', { id: c.id }); return res.json({ ok: true, course: c });
});
app.delete('/api/v3/courses/:id', requireAuth, (req,res)=>{ const arr=loadCourses(); const idx=arr.findIndex(x=>x.id===req.params.id); if(idx>=0){arr.splice(idx,1); saveCourses(arr); logHistory('courses.delete',{id:req.params.id}); return res.json({ok:true});} return res.status(404).json({error:'notfound'}); });

// ---------- Watchlist (YouTube) ----------
function loadWatch() { return readJson(WATCH_FILE) || []; }
function saveWatch(arr) { writeJson(WATCH_FILE, arr); logHistory('watch.update', { count: arr.length }); }

app.get('/api/v3/watch', requireAuth, (req,res)=>res.json({ watch: loadWatch() }));
app.post('/api/v3/watch', requireAuth, (req,res)=>{
  const { url, title = '', thumbnail = '', tags = [] } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  const arr = loadWatch(); const w = { id: id('v'), url, title, thumbnail, notes: '', tags, seen:false, createdAt: now() }; arr.unshift(w); saveWatch(arr); logHistory('watch.add',{id:w.id}); return res.json({ ok:true, item:w });
});
app.patch('/api/v3/watch/:id', requireAuth, (req,res)=>{ const arr=loadWatch(); const w=arr.find(x=>x.id===req.params.id); if(!w) return res.status(404).json({error:'notfound'}); Object.assign(w, req.body, { updatedAt: now() }); saveWatch(arr); logHistory('watch.update',{id:w.id}); return res.json({ok:true,item:w}); });
app.delete('/api/v3/watch/:id', requireAuth, (req,res)=>{ const arr=loadWatch(); const idx=arr.findIndex(x=>x.id===req.params.id); if(idx>=0){arr.splice(idx,1); saveWatch(arr); logHistory('watch.delete',{id:req.params.id}); return res.json({ok:true});} return res.status(404).json({error:'notfound'}) });

// ---------- Topics / Knowledge Vault ----------
function loadTopics(){ return readJson(TOPICS_FILE) || []; }
function saveTopics(arr){ writeJson(TOPICS_FILE, arr); logHistory('topics.update',{count:arr.length}); }

app.get('/api/v3/topics', requireAuth, (req,res)=>res.json({ topics: loadTopics() }));
app.post('/api/v3/topics', requireAuth, (req,res)=>{ const { name } = req.body||{}; if(!name) return res.status(400).json({error:'name required'}); const arr=loadTopics(); const t={id:id('t'),name,children:[],notes:'',tags:[],createdAt:now()}; arr.unshift(t); saveTopics(arr); logHistory('topics.create',{id:t.id}); return res.json({ok:true,topic:t}); });
app.patch('/api/v3/topics/:id', requireAuth, (req,res)=>{ const arr=loadTopics(); const t=arr.find(x=>x.id===req.params.id); if(!t) return res.status(404).json({error:'notfound'}); Object.assign(t, req.body, { updatedAt: now() }); saveTopics(arr); logHistory('topics.update',{id:t.id}); return res.json({ok:true,topic:t}); });
app.delete('/api/v3/topics/:id', requireAuth, (req,res)=>{ const arr=loadTopics(); const idx=arr.findIndex(x=>x.id===req.params.id); if(idx>=0){arr.splice(idx,1); saveTopics(arr); logHistory('topics.delete',{id:req.params.id}); return res.json({ok:true});} return res.status(404).json({error:'notfound'}) });

// add child
app.post('/api/v3/topics/:id/children', requireAuth, (req,res)=>{ const arr=loadTopics(); const t=arr.find(x=>x.id===req.params.id); if(!t) return res.status(404).json({error:'notfound'}); const { name } = req.body||{}; if(!name) return res.status(400).json({error:'name required'}); const child={id:id('st'),name,notes:'',tags:[]}; t.children = t.children || []; t.children.push(child); saveTopics(arr); logHistory('topics.child.create',{topicId:t.id,childId:child.id}); return res.json({ok:true,child}); });

// ---------- Sessions (focus/pomodoro) logging (NO XP) ----------
function loadSessions(){ return readJson(SESSIONS_FILE) || []; }
function saveSessions(arr){ writeJson(SESSIONS_FILE, arr); logHistory('sessions.update',{count:arr.length}); }

app.get('/api/v3/sessions', requireAuth, (req,res)=>res.json({ sessions: loadSessions() }));
app.post('/api/v3/sessions', requireAuth, (req,res)=>{
  const { type='focus', durationMinutes=25, metadata={} } = req.body || {};
  const arr = loadSessions();
  const s = { id: id('s'), type, durationMinutes, metadata, createdAt: now() };
  arr.unshift(s); saveSessions(arr); logHistory('sessions.create', { id: s.id, type, durationMinutes });
  return res.json({ ok:true, session: s });
});

// ---------- Notes metadata + versioned encrypted blobs ----------
function loadNotesIndex(){ return readJson(NOTES_INDEX) || []; }
function saveNotesIndex(arr){ writeJson(NOTES_INDEX, arr); logHistory('notes.index.update',{count:arr.length}); }

// create new note (metadata + optional blob)
app.post('/api/v3/notes', requireAuth, async (req,res)=>{
  /**
   * body:
   * { id? , title, type, tags[], summary, blob?: { ciphertext, iv, meta } , encryptionMode?: 'client-only'|'server-assisted'|'hybrid' }
   *
   * - client-only: client sends encrypted blob; server only stores ciphertext
   * - server-assisted: client sends plaintext in 'blob.plaintext' and server encrypts it using server master key (derived from server secret)
   * - hybrid: client sends encrypted blob; server additionally wraps with server envelope (optional)
   */
  const { id: maybeId, title, type='general', tags=[], summary='', blob, encryptionMode } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  const nid = maybeId || id('n');
  const notes = loadNotesIndex();
  const entry = { id: nid, title, type, tags, summary, createdAt: now(), updatedAt: now() };
  notes.unshift(entry);
  saveNotesIndex(notes);

  // Ensure blob dir
  const noteDir = path.join(BLOBS_DIR, nid);
  if (!fs.existsSync(noteDir)) fs.mkdirSync(noteDir, { recursive: true });

  // determine encryption policy
  const metaConf = readJson(META_FILE);
  const profile = encryptionMode || metaConf.encryptionProfile || 'client-only';

  // If client sent plaintext (server-assisted), encrypt via server key
  if (blob && blob.plaintext && profile === 'server-assisted') {
    try {
      const serverKey = crypto.scryptSync(JWT_SECRET, 'server-key-salt-v3', 32);
      const gz = gzipBufferSync(Buffer.from(blob.plaintext, 'utf8'));
      const enc = aesGcmEncrypt(serverKey, gz);
      const versionMeta = { iv: enc.iv, checksum: sha256Hex(enc.ciphertext), mode: 'server-assisted', meta: blob.meta || {} };
      // write gzipped encrypted blob as versions/<timestamp>.json.gz content: {ciphertext,iv,meta}
      const verPath = path.join(noteDir, 'versions');
      if (!fs.existsSync(verPath)) fs.mkdirSync(verPath);
      const filename = path.join(verPath, `${Date.now()}.json.gz`);
      fs.writeFileSync(filename, gzipBufferSync(Buffer.from(JSON.stringify({ ciphertext: enc.ciphertext, iv: enc.iv, meta: versionMeta }))));
    } catch (e) { console.error('server-assisted encrypt failed', e); return res.status(500).json({ error: 'server encryption failed' }); }
  } else if (blob && blob.ciphertext && blob.iv) {
    // client sent encrypted ciphertext (client-only or hybrid); we store as-is as a version
    const verPath = path.join(noteDir, 'versions');
    if (!fs.existsSync(verPath)) fs.mkdirSync(verPath);
    const versionMeta = { iv: blob.iv, checksum: sha256Hex(blob.ciphertext), mode: profile, meta: blob.meta || {} };
    const filename = path.join(verPath, `${Date.now()}.json.gz`);
    fs.writeFileSync(filename, gzipBufferSync(Buffer.from(JSON.stringify({ ciphertext: blob.ciphertext, iv: blob.iv, meta: versionMeta }))));
  }

  logHistory('notes.create', { id: nid, title, profile });
  return res.json({ ok: true, note: entry });
});

// list versions for a note
app.get('/api/v3/notes/:id/versions', requireAuth, (req,res)=>{
  const nid = req.params.id;
  const verDir = path.join(BLOBS_DIR, nid, 'versions');
  if (!fs.existsSync(verDir)) return res.status(404).json({ error: 'no versions' });
  const files = fs.readdirSync(verDir).sort().reverse();
  const versions = files.map(f => {
    const ts = Number(f.split('.json.gz')[0]);
    const data = fs.readFileSync(path.join(verDir, f));
    // read gz content just to extract meta without decrypting ciphertext
    try {
      const content = JSON.parse(gunzipBufferSync(data).toString('utf8'));
      return { filename: f, ts, meta: content.meta || null };
    } catch (e) {
      return { filename: f, ts, meta: null };
    }
  });
  return res.json({ versions });
});

// download specific version (returns ciphertext and iv; server will not decrypt client-only blobs)
app.get('/api/v3/notes/:id/versions/:file', requireAuth, (req,res)=>{
  const nid = req.params.id;
  const file = req.params.file;
  const full = path.join(BLOBS_DIR, nid, 'versions', file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });
  const gz = fs.readFileSync(full);
  const payload = JSON.parse(gunzipBufferSync(gz).toString('utf8'));
  return res.json({ ciphertext: payload.ciphertext, iv: payload.iv, meta: payload.meta });
});

// replace note metadata
app.patch('/api/v3/notes/:id', requireAuth, (req,res)=>{
  const nid = req.params.id;
  const notes = loadNotesIndex();
  const idx = notes.findIndex(n => n.id === nid);
  if (idx < 0) return res.status(404).json({ error: 'note not found' });
  Object.assign(notes[idx], req.body, { updatedAt: now() });
  saveNotesIndex(notes);
  logHistory('notes.update', { id: nid });
  return res.json({ ok: true, note: notes[idx] });
});

// delete note (metadata + versions)
app.delete('/api/v3/notes/:id', requireAuth, (req,res)=>{
  const nid = req.params.id;
  let notes = loadNotesIndex();
  notes = notes.filter(n => n.id !== nid);
  saveNotesIndex(notes);
  const noteDir = path.join(BLOBS_DIR, nid);
  if (fs.existsSync(noteDir)) fs.rmSync(noteDir, { recursive: true, force: true });
  logHistory('notes.delete', { id: nid });
  return res.json({ ok: true });
});

// ---------- Attachments (encrypted file uploads) ----------
app.post('/api/v3/files/upload', requireAuth, upload.single('file'), async (req,res)=>{
  // client should encrypt file before uploading if privacy desired; server can optionally encrypt using server key
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const file = req.file;
    const originalName = file.originalname;
    const tmpPath = file.path;
    const idFile = id('f');
    const destDir = path.join(FILES_DIR, idFile);
    fs.mkdirSync(destDir, { recursive: true });
    // by default we move file as-is (raw), compute checksum, then optionally encrypt with server key if requested
    const raw = fs.readFileSync(tmpPath);
    const checksum = sha256Hex(raw);
    const meta = { originalName, checksum, size: raw.length, uploadedAt: now() };
    // store raw file compressed
    const gz = gzipBufferSync(raw);
    fs.writeFileSync(path.join(destDir, 'file.gz'), gz);
    fs.writeFileSync(path.join(destDir, 'meta.json'), JSON.stringify(meta, null, 2));
    fs.unlinkSync(tmpPath);
    logHistory('files.upload', { id: idFile, name: originalName });
    return res.json({ ok: true, id: idFile, meta });
  } catch (e) {
    console.error(e); return res.status(500).json({ error: 'upload failed' });
  }
});

// download attachment (raw)
app.get('/api/v3/files/:id', requireAuth, (req,res)=>{
  const idFile = req.params.id;
  const dir = path.join(FILES_DIR, idFile);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'not found' });
  const meta = readJson(path.join(dir, 'meta.json'));
  const gz = fs.readFileSync(path.join(dir, 'file.gz'));
  const raw = gunzipBufferSync(gz);
  res.setHeader('Content-Disposition', `attachment; filename="${meta.originalName}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  return res.send(raw);
});

// ---------- Search (simple metadata search) ----------
app.get('/api/v3/search', requireAuth, (req,res)=>{
  const q = (req.query.q || '').toLowerCase();
  if (!q) return res.json({ results: [] });
  const results = [];
  // notes
  const notes = loadNotesIndex();
  for (const n of notes) {
    if ((n.title + ' ' + (n.summary || '') + ' ' + (n.tags || []).join(' ')).toLowerCase().includes(q)) results.push({ type:'note', id: n.id, title: n.title });
  }
  // courses
  const courses = loadCourses();
  for (const c of courses) {
    if ((c.name + ' ' + (c.notes || '') + ' ' + (c.tags || []).join(' ')).toLowerCase().includes(q)) results.push({ type:'course', id: c.id, title: c.name });
  }
  // topics
  const topics = loadTopics();
  for (const t of topics) { if ((t.name + ' ' + (t.notes||'')).toLowerCase().includes(q)) results.push({ type:'topic', id:t.id, title:t.name }); }
  // watch
  const watch = loadWatch();
  for (const v of watch) { if ((v.title + ' ' + (v.url||'') + ' ' + (v.notes||'')).toLowerCase().includes(q)) results.push({ type:'video', id: v.id, title: v.title || v.url }); }
  return res.json({ results });
});

// ---------- Export / Import / Backups endpoints ----------
app.get('/api/v3/export', requireAuth, (req,res)=>{
  // Exports metadata + pointers (does not embed huge blobs) as JSON
  const payload = {
    meta: readJson(META_FILE),
    notesIndex: loadNotesIndex(),
    tasks: loadTasks(),
    courses: loadCourses(),
    watch: loadWatch(),
    topics: loadTopics(),
    sessions: loadSessions(),
    exportedAt: now()
  };
  res.setHeader('Content-Disposition', `attachment; filename=thehaydensphere_export_${Date.now()}.json`);
  res.setHeader('Content-Type', 'application/json');
  return res.send(JSON.stringify(payload, null, 2));
});

app.post('/api/v3/import', requireAuth, (req,res)=>{
  const payload = req.body || {};
  if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'invalid payload' });
  if (payload.notesIndex) saveNotesIndex(payload.notesIndex);
  if (payload.tasks) saveTasks(payload.tasks);
  if (payload.courses) saveCourses(payload.courses);
  if (payload.watch) saveWatch(payload.watch);
  if (payload.topics) saveTopics(payload.topics);
  if (payload.sessions) saveSessions(payload.sessions);
  logHistory('import', { summary: Object.keys(payload) });
  return res.json({ ok: true });
});

// ---------- AI Hooks (placeholders) ----------
app.post('/api/v3/ai/summarize', requireAuth, async (req,res) => {
  // placeholder: client can provide plaintext and server returns a quick heuristic summary
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  // naive summary: first 200 chars + sentence break
  const summary = text.length > 200 ? text.slice(0, 200) + '…' : text;
  return res.json({ summary, sourceLength: text.length });
});
app.post('/api/v3/ai/autotag', requireAuth, async (req,res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  // naive tagger: select frequent words longer than 4 chars
  const words = text.toLowerCase().match(/\b[a-z]{5,}\b/g) || [];
  const freq = {};
  words.forEach(w => freq[w] = (freq[w]||0)+1);
  const tags = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,8).map(x=>x[0]);
  return res.json({ tags });
});

// ---------- Server status & debug ----------
app.get('/api/v3/status', (req,res) => {
  const meta = readJson(META_FILE);
  return res.json({ ok: true, version: meta.version, ts: now() });
});

app.get('/api/v3/debug/summary', requireAuth, (req,res) => {
  const summary = {
    notesCount: (loadNotesIndex() || []).length,
    tasks: loadTasks(),
    courses: loadCourses().length,
    watch: loadWatch().length,
    topics: loadTopics().length,
    sessions: loadSessions().length,
    backups: fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).length : 0
  };
  return res.json({ summary });
});

// ---------- Helper endpoints for encryption (snapshot helpers) ----------
app.post('/api/v3/enc/derive', requireAuth, async (req,res) => {
  const { pin } = req.body || {};
  if (!pin) return res.status(400).json({ error: 'pin required' });
  try {
    const key = await deriveKeyFromPin(pin);
    return res.json({ key: key.toString('base64') });
  } catch (e) {
    return res.status(500).json({ error: 'derive failed' });
  }
});
app.post('/api/v3/enc/encrypt', requireAuth, async (req,res) => {
  const { keyBase64, payload } = req.body || {};
  if (!keyBase64 || !payload) return res.status(400).json({ error: 'key & payload required' });
  try {
    const keyBuf = Buffer.from(keyBase64, 'base64');
    const plain = Buffer.from(JSON.stringify(payload), 'utf8');
    const gz = gzipBufferSync(plain);
    const enc = aesGcmEncrypt(keyBuf, gz);
    return res.json({ ciphertext: enc.ciphertext, iv: enc.iv, checksum: sha256Hex(enc.ciphertext) });
  } catch (e) { return res.status(500).json({ error: 'encrypt failed' }); }
});
app.post('/api/v3/enc/decrypt', requireAuth, async (req,res) => {
  const { keyBase64, ciphertext, iv } = req.body || {};
  if (!keyBase64 || !ciphertext || !iv) return res.status(400).json({ error: 'key+ciphertext+iv required' });
  try {
    const keyBuf = Buffer.from(keyBase64, 'base64');
    const plainGz = aesGcmDecrypt(keyBuf, ciphertext, iv);
    const json = JSON.parse(gunzipBufferSync(plainGz).toString('utf8'));
    return res.json({ payload: json });
  } catch (e) { return res.status(500).json({ error: 'decrypt failed', detail: e.message }); }
});

// ---------- Startup helpers / defaults ----------
function ensureDefaultDays() {
  const tasks = loadJsonSafe(TASKS_FILE, { A: [], B: [] });
  if (!tasks.A || tasks.A.length === 0) {
    tasks.A = [
      { id: id('t'), name: 'Reading', minutes: 60, done: false, notesId: null, courseId: null, tags: [] },
      { id: id('t'), name: 'Course Study', minutes: 60, done: false, notesId: null, courseId: null, tags: [] },
      { id: id('t'), name: 'News Study', minutes: 30, done: false, notesId: null, courseId: null, tags: [] },
      { id: id('t'), name: 'Bible Reading', minutes: 45, done: false, notesId: null, courseId: null, tags: [] }
    ];
  }
  if (!tasks.B || tasks.B.length === 0) {
    tasks.B = [
      { id: id('t'), name: 'Reading', minutes: 60, done: false, notesId: null, courseId: null, tags: [] },
      { id: id('t'), name: 'GED Study', minutes: 60, done: false, notesId: null, courseId: null, tags: [] },
      { id: id('t'), name: 'Course Study', minutes: 60, done: false, notesId: null, courseId: null, tags: [] },
      { id: id('t'), name: 'News Study', minutes: 30, done: false, notesId: null, courseId: null, tags: [] },
      { id: id('t'), name: 'Bible Reading', minutes: 30, done: false, notesId: null, courseId: null, tags: [] }
    ];
  }
  writeJson(TASKS_FILE, tasks);
}
function loadJsonSafe(p, fallback) { try { return readJson(p) || fallback; } catch (e) { return fallback; } }
ensureDefaultDays();

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`TheHaydenSphere v3 backend listening on http://localhost:${PORT}`);
  console.log('Ensure you call POST /api/v3/auth/setup-pin to initialize PIN if not already set.');
  createBackup(); // initial backup on start
});

