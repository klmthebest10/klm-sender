'use strict';
// KLM Sender — aplikasi desktop (Windows)
// - Server lokal (hub) di Wi-Fi: HP/PC lain cukup memindai QR, bisa tanpa internet
// - Banyak perangkat sekaligus; file dialirkan langsung (streaming) tanpa kompres
// - File yang diterima PC ditulis langsung ke disk, tanpa batas ukuran
const { app, BrowserWindow, ipcMain, shell, dialog, Notification, nativeImage } = require('electron');
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { pipeline, Transform } = require('stream');

const APP_DIR = path.join(__dirname, 'app');
const PREFERRED_PORT = 47800;
const SELFTEST = process.env.KLM_SELFTEST || '';
let win = null;
let server = null;
let port = 0;

if (!SELFTEST && !app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.setAppUserModelId('com.klm.sender');

/* ---------- pengaturan ---------- */
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {};
let saveTimer = null;
function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch (e) { settings = {}; }
  if (!settings.saveDir) settings.saveDir = path.join(app.getPath('downloads'), 'KLM Sender');
  if (!settings.kv || typeof settings.kv !== 'object') settings.kv = {};
  if (SELFTEST) {
    settings.saveDir = path.join(SELFTEST, 'received');
    settings.kv = Object.assign({ 'klm-name': 'PC Uji', 'klm-auto': '1', 'klm-code': 'PCTEST' }, settings.kv);
  }
}
function saveSettings() {
  if (SELFTEST) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (e) {}
  }, 200);
}

/* ---------- alamat jaringan lokal ---------- */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family !== 'IPv4' || n.internal || n.address.startsWith('169.254.')) continue;
      const virtual = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|docker|vbox|Bluetooth|Tailscale|ZeroTier/i.test(name);
      const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address);
      out.push({ address: n.address, name, score: (virtual ? 0 : 3) + (priv ? 1 : 0) + (n.address.startsWith('192.168.') ? 1 : 0) });
    }
  }
  return out.sort((a, b) => b.score - a.score).map(x => ({ address: x.address, name: x.name }));
}

/* ---------- utilitas ---------- */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
function safeSegment(s) {
  let t = String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!t || t === '.' || t === '..') t = 'file';
  if (RESERVED.test(t)) t = '_' + t;
  return t.slice(0, 200);
}
async function exists(p) { try { await fsp.access(p); return true; } catch (e) { return false; } }
async function uniquePath(dir, name) {
  const ext = path.extname(name); const stem = ext ? name.slice(0, -ext.length) : name;
  for (let k = 0; k < 10000; k++) {
    const cand = path.join(dir, k ? `${stem} (${k})${ext}` : name);
    if (!(await exists(cand)) && !(await exists(cand + '.klmpart'))) return cand;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}
async function targetFor(relName) {
  const parts = String(relName || 'file').split(/[\\/]+/).filter(p => p && p !== '.' && p !== '..').map(safeSegment);
  const fname = parts.pop() || 'file';
  const dir = path.join(settings.saveDir, ...parts);
  await fsp.mkdir(dir, { recursive: true });
  return uniquePath(dir, fname);
}
const cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
function isLocal(req) { const a = req.socket.remoteAddress || ''; return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; }
function json(res, code, obj) { if (res.headersSent) { try { res.end(); } catch (e) {} return; } res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readJson(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', d => { n += d.length; if (n > limit) { reject(new Error('terlalu besar')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/* ---------- hub: daftar perangkat & pesan (Server-Sent Events) ---------- */
const clients = new Map(); // kode -> { code, name, kind, host, res }
function sse(c, obj) { try { c.res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) {} }
function peersList() { return [...clients.values()].map(c => ({ code: c.code, name: c.name, kind: c.kind, host: c.host })); }
function broadcastPeers() { const list = peersList(); for (const c of clients.values()) sse(c, { type: 'peers', list }); }

/* ---------- hub: transfer file (pengirim POST → hub → penerima GET / disk) ---------- */
const xfers = new Map();
function xfer(tid) {
  let x = xfers.get(tid);
  if (!x) {
    x = { tid, bytes: 0, size: 0, from: '', to: '', up: null, sink: null, started: false, finished: false };
    x.timeout = setTimeout(() => { if (!x.started) fail(x, 'Waktu tunggu habis'); }, 5 * 60 * 1000);
    xfers.set(tid, x);
  }
  return x;
}
function notify(x, extra) {
  const base = { type: 'xfer', tid: x.tid, bytes: x.bytes, size: x.size };
  for (const code of new Set([x.from, x.to])) { const c = clients.get(code); if (c) sse(c, Object.assign({}, base, extra, code === x.to ? {} : { path: undefined })); }
}
function tryStart(x) {
  if (x.started || !x.up || !x.sink) return;
  x.started = true; clearTimeout(x.timeout);
  const counter = new Transform({ transform(chunk, _e, cb) { x.bytes += chunk.length; cb(null, chunk); } });
  x.timer = setInterval(() => notify(x, {}), 400);
  pipeline(x.up.req, counter, x.sink.stream, async err => {
    clearInterval(x.timer);
    if (x.finished) return;
    if (err || (x.size && x.bytes !== x.size)) return fail(x, err ? err.message : 'Ukuran tidak cocok');
    let finalPath = null;
    try {
      if (x.sink.type === 'disk') {
        finalPath = x.sink.final;
        if (await exists(finalPath)) finalPath = await uniquePath(path.dirname(finalPath), path.basename(finalPath));
        await fsp.rename(x.sink.temp, finalPath);
      }
    } catch (e) { return fail(x, 'Gagal menyimpan: ' + e.message); }
    x.finished = true; xfers.delete(x.tid);
    notify(x, { done: true, ok: true, path: finalPath });
    json(x.up.res, 200, { ok: true, bytes: x.bytes });
  });
}
function fail(x, reason) {
  if (x.finished) return;
  x.finished = true; clearTimeout(x.timeout); clearInterval(x.timer); xfers.delete(x.tid);
  if (x.up) { json(x.up.res, 500, { ok: false, reason }); try { x.up.req.destroy(); } catch (e) {} }
  if (x.sink) {
    try { x.sink.stream.destroy(); } catch (e) {}
    if (x.sink.type === 'disk') fsp.unlink(x.sink.temp).catch(() => {});
  }
  notify(x, { done: true, ok: false, reason });
}

async function api(req, res, url) {
  const p = url.pathname, q = url.searchParams;
  if (p === '/api/hub') return json(res, 200, { app: 'klm-sender', ok: true });

  if (p === '/api/events' && req.method === 'GET') {
    const code = cleanCode(q.get('id'));
    if (code.length !== 6) return json(res, 400, { ok: false });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    req.socket.setKeepAlive(true); req.socket.setNoDelay(true);
    const old = clients.get(code);
    if (old) { try { old.res.end(); } catch (e) {} }
    const c = { code, name: String(q.get('name') || 'Perangkat').slice(0, 40), kind: q.get('kind') === 'hp' ? 'hp' : 'pc', host: q.get('host') === '1' && isLocal(req), res };
    clients.set(code, c);
    sse(c, { type: 'welcome', you: code });
    broadcastPeers();
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
    res.on('close', () => { clearInterval(ping); if (clients.get(code) === c) { clients.delete(code); broadcastPeers(); } });
    return;
  }

  if (p === '/api/msg' && req.method === 'POST') {
    const b = await readJson(req);
    const from = clients.get(cleanCode(b.from)), to = clients.get(cleanCode(b.to));
    if (!from || !to) return json(res, 404, { ok: false });
    sse(to, { type: 'msg', from: from.code, msg: b.msg });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/name' && req.method === 'POST') {
    const b = await readJson(req);
    const c = clients.get(cleanCode(b.from));
    if (c) { c.name = String(b.name || c.name).slice(0, 40); broadcastPeers(); }
    return json(res, 200, { ok: true });
  }

  let m;
  if ((m = p.match(/^\/api\/up\/([A-Za-z0-9-]{1,80})$/)) && req.method === 'POST') {
    const x = xfer(m[1]);
    if (x.up) return json(res, 409, { ok: false });
    x.from = cleanCode(q.get('from')); x.to = cleanCode(q.get('to')); x.size = Math.max(0, +q.get('size') || 0);
    x.up = { req, res };
    req.on('close', () => { if (!req.complete && !x.finished) fail(x, 'Pengirim berhenti'); });
    tryStart(x);
    return;
  }
  if ((m = p.match(/^\/api\/down\/([A-Za-z0-9-]{1,80})$/)) && req.method === 'GET') {
    const x = xfer(m[1]);
    if (x.sink) return json(res, 409, { ok: false });
    const name = safeSegment(q.get('name') || 'file');
    const size = Math.max(0, +q.get('size') || 0);
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Disposition': contentDisposition(name), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (q.has('size')) headers['Content-Length'] = String(size);
    res.writeHead(200, headers);
    if (q.has('size') && size === 0 && x.up) { /* berkas kosong */ }
    x.sink = { type: 'http', stream: res };
    res.on('close', () => { if (!res.writableFinished && !x.finished) fail(x, 'Penerima berhenti'); });
    tryStart(x);
    return;
  }
  if ((m = p.match(/^\/api\/cancel\/([A-Za-z0-9-]{1,80})$/)) && req.method === 'POST') {
    const x = xfers.get(m[1]); if (x) fail(x, 'Dibatalkan');
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { ok: false });
}

/* ---------- server lokal ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  if (url.pathname.startsWith('/api/')) { api(req, res, url).catch(e => json(res, 500, { ok: false, reason: e.message })); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let p;
  try { p = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(APP_DIR, p));
  if (!file.startsWith(APP_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Tidak ditemukan'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}
function makeServer() {
  const s = http.createServer(handle);
  s.requestTimeout = 0;      // file besar boleh berjam-jam
  s.headersTimeout = 60000;
  s.timeout = 0;
  s.keepAliveTimeout = 30000;
  return s;
}
function startServer() {
  return new Promise(resolve => {
    const tryListen = (p, attempt) => {
      const s = makeServer();
      s.once('error', () => {
        if (attempt < 10) return tryListen(p + 1, attempt + 1);
        const s2 = makeServer(); s2.listen(0, '0.0.0.0', () => { server = s2; port = s2.address().port; resolve(); });
      });
      s.listen(p, '0.0.0.0', () => { server = s; port = p; resolve(); });
    };
    tryListen(PREFERRED_PORT, 0);
  });
}

/* ---------- IPC: penyimpanan langsung ke disk ---------- */
const handles = new Map();
let nextId = 1;
ipcMain.handle('file-open', async (_e, relName) => {
  const final = await targetFor(relName);
  const temp = final + '.klmpart';
  const fh = await fsp.open(temp, 'w');
  const id = nextId++;
  handles.set(id, { fh, temp, final });
  return { id, name: path.basename(final) };
});
ipcMain.handle('file-write', async (_e, id, data) => {
  const h = handles.get(id); if (!h) throw new Error('File tidak terbuka');
  const buf = Buffer.from(data.buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data));
  let off = 0; while (off < buf.length) { const { bytesWritten } = await h.fh.write(buf, off, buf.length - off); off += bytesWritten; }
  return true;
});
ipcMain.handle('file-close', async (_e, id) => {
  const h = handles.get(id); if (!h) return null; handles.delete(id);
  await h.fh.close();
  let final = h.final;
  if (await exists(final)) final = await uniquePath(path.dirname(final), path.basename(final));
  await fsp.rename(h.temp, final);
  return final;
});
ipcMain.handle('file-abort', async (_e, id) => {
  const h = handles.get(id); if (!h) return; handles.delete(id);
  try { await h.fh.close(); } catch (e) {}
  try { await fsp.unlink(h.temp); } catch (e) {}
});
// penerima PC untuk transfer lewat Wi-Fi lokal: hub menulis langsung ke disk
ipcMain.handle('hub-sink', async (_e, tid, relName) => {
  const x = xfer(String(tid));
  if (x.sink) return null;
  const final = await targetFor(relName);
  const temp = final + '.klmpart';
  x.sink = { type: 'disk', stream: fs.createWriteStream(temp), temp, final };
  tryStart(x);
  return { name: path.basename(final) };
});
ipcMain.handle('hub-cancel', (_e, tid) => { const x = xfers.get(String(tid)); if (x) fail(x, 'Dibatalkan'); });

/* ---------- IPC lain ---------- */
ipcMain.handle('info', () => ({ port, lan: lanAddresses(), saveDir: settings.saveDir, version: app.getVersion(), platform: process.platform, kv: settings.kv }));
ipcMain.handle('kv-set', (_e, k, v) => { settings.kv[String(k)] = v == null ? null : String(v); saveSettings(); return true; });
ipcMain.handle('choose-dir', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Pilih folder simpan', defaultPath: settings.saveDir, properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return settings.saveDir;
  settings.saveDir = r.filePaths[0]; saveSettings(); return settings.saveDir;
});
ipcMain.handle('open-dir', async () => { await fsp.mkdir(settings.saveDir, { recursive: true }); return shell.openPath(settings.saveDir); });
ipcMain.handle('open-file', (_e, p) => p && shell.openPath(p));
ipcMain.handle('show-file', (_e, p) => { if (p) shell.showItemInFolder(p); });
ipcMain.handle('notify', (_e, title, body) => {
  try { if (Notification.isSupported()) { const n = new Notification({ title, body, icon: iconPath() }); n.on('click', () => { if (win) { win.show(); win.focus(); } }); n.show(); } } catch (e) {}
  if (win && !win.isFocused()) win.flashFrame(true);
});
ipcMain.on('progress', (_e, v) => { if (win) win.setProgressBar(typeof v === 'number' ? v : -1); });

function iconPath() { const p = path.join(__dirname, 'build', 'icon.png'); return fs.existsSync(p) ? p : undefined; }

async function createWindow() {
  loadSettings();
  await startServer();
  win = new BrowserWindow({
    width: 520, height: 900, minWidth: 380, minHeight: 560,
    title: 'KLM Sender', backgroundColor: '#ECEBE4', autoHideMenuBar: true, show: false,
    icon: iconPath() ? nativeImage.createFromPath(iconPath()) : undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  win.on('focus', () => win.flashFrame(false));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`http://127.0.0.1:${port}/`)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => cb(['notifications', 'clipboard-sanitized-write', 'fileSystem'].includes(perm)));
  win.loadURL(`http://127.0.0.1:${port}/?app=desktop`);
  win.on('closed', () => { win = null; });
  if (SELFTEST) selfTest();
}

/* uji mandiri (hanya untuk pengembangan) */
function selfTest() {
  const out = SELFTEST;
  const shots = async (prefix) => {
    const { nativeTheme } = require('electron');
    for (const t of ['light', 'dark']) {
      nativeTheme.themeSource = t; await new Promise(r => setTimeout(r, 700));
      const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(out, `${prefix}-${t}.png`), img.toPNG());
    }
    nativeTheme.themeSource = 'light';
  };
  win.webContents.once('did-finish-load', async () => {
    win.setSize(520, 1250);
    fs.writeFileSync(path.join(out, 'port.txt'), String(port));
    await new Promise(r => setTimeout(r, 3000));
    await shots('idle');
    // klien uji meminta PC mengirim file (simulasi seret file ke jendela)
    for (let i = 0; i < 120 && !fs.existsSync(path.join(out, 'pc-send')); i++) await new Promise(r => setTimeout(r, 500));
    await win.webContents.executeJavaScript(`(() => { const u=new Uint8Array(5*1024*1024); for(let i=0;i<u.length;i++) u[i]=(i*7)%256; const dt=new DataTransfer(); dt.items.add(new File([u],'dari-pc.bin')); document.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true})); return true; })()`);
    // tunggu skrip uji klien selesai (menulis file "clients-done")
    for (let i = 0; i < 120 && !fs.existsSync(path.join(out, 'clients-done')); i++) await new Promise(r => setTimeout(r, 500));
    await new Promise(r => setTimeout(r, 800));
    await shots('busy');
    const state = await win.webContents.executeJavaScript(`({ status: document.getElementById('statusText').textContent, devs: [...document.querySelectorAll('.dev b')].map(x=>x.textContent), tx: [...document.querySelectorAll('.tx .badge')].map(x=>x.textContent) })`);
    fs.writeFileSync(path.join(out, 'state.json'), JSON.stringify(state, null, 2));
    app.quit();
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  for (const h of handles.values()) { try { h.fh.close(); fs.unlinkSync(h.temp); } catch (e) {} }
  for (const x of xfers.values()) fail(x, 'Aplikasi ditutup');
  if (server) server.close();
  app.quit();
});
