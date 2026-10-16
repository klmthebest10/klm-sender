'use strict';
// KLM Sender — aplikasi desktop (Windows)
// - Menyajikan tampilan yang sama ke jendela aplikasi dan ke HP di WiFi yang sama (server lokal)
// - File yang diterima ditulis langsung ke disk (tanpa batas ukuran, tanpa kompres)
const { app, BrowserWindow, ipcMain, shell, dialog, Notification, nativeImage } = require('electron');
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const APP_DIR = path.join(__dirname, 'app');
const PREFERRED_PORT = 47800;
let win = null;
let server = null;
let port = 0;

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.setAppUserModelId('com.klm.sender');

/* ---------- pengaturan ---------- */
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {};
function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch (e) { settings = {}; }
  if (!settings.saveDir) settings.saveDir = path.join(app.getPath('downloads'), 'KLM Sender');
}
function saveSettings() { try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (e) {} }

/* ---------- alamat jaringan lokal ---------- */
function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const [name, list] of Object.entries(nets)) {
    for (const n of list || []) {
      if (n.family !== 'IPv4' || n.internal) continue;
      if (n.address.startsWith('169.254.')) continue;
      const virtual = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|docker|vbox|Bluetooth/i.test(name);
      const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address);
      out.push({ address: n.address, name, score: (virtual ? 0 : 2) + (priv ? 1 : 0) + (n.address.startsWith('192.168.') ? 1 : 0) });
    }
  }
  return out.sort((a, b) => b.score - a.score).map(x => ({ address: x.address, name: x.name }));
}

/* ---------- server lokal (untuk jendela & HP di WiFi yang sama) ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(APP_DIR, p));
  if (!file.startsWith(APP_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Tidak ditemukan'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}
function startServer() {
  return new Promise(resolve => {
    const tryListen = (p, attempt) => {
      const s = http.createServer(handle);
      s.once('error', () => { if (attempt < 10) tryListen(p + 1, attempt + 1); else { const s2 = http.createServer(handle); s2.listen(0, '0.0.0.0', () => { server = s2; port = s2.address().port; resolve(); }); } });
      s.listen(p, '0.0.0.0', () => { server = s; port = p; resolve(); });
    };
    tryListen(PREFERRED_PORT, 0);
  });
}

/* ---------- penulisan file ---------- */
const handles = new Map();
let nextId = 1;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
function safeSegment(s) {
  let t = String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!t || t === '.' || t === '..') t = 'file';
  if (RESERVED.test(t)) t = '_' + t;
  return t.slice(0, 200);
}
async function uniquePath(dir, name) {
  const ext = path.extname(name); const stem = ext ? name.slice(0, -ext.length) : name;
  for (let k = 0; k < 10000; k++) {
    const cand = path.join(dir, k ? `${stem} (${k})${ext}` : name);
    try { await fsp.access(cand); } catch (e) { return cand; }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}
ipcMain.handle('file-open', async (_e, relName) => {
  const parts = String(relName || 'file').split(/[\\/]+/).filter(p => p && p !== '.' && p !== '..').map(safeSegment);
  const fname = parts.pop() || 'file';
  const dir = path.join(settings.saveDir, ...parts);
  await fsp.mkdir(dir, { recursive: true });
  const final = await uniquePath(dir, fname);
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
  try { await fsp.access(final); final = await uniquePath(path.dirname(final), path.basename(final)); } catch (e) {}
  await fsp.rename(h.temp, final);
  return final;
});
ipcMain.handle('file-abort', async (_e, id) => {
  const h = handles.get(id); if (!h) return; handles.delete(id);
  try { await h.fh.close(); } catch (e) {}
  try { await fsp.unlink(h.temp); } catch (e) {}
});

/* ---------- lain-lain ---------- */
ipcMain.handle('info', () => ({ port, lan: lanAddresses(), saveDir: settings.saveDir, version: app.getVersion(), platform: process.platform }));
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
    width: 500, height: 860, minWidth: 380, minHeight: 560,
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
  if (process.env.KLM_SELFTEST) selfTest();
}

/* uji mandiri (hanya dipakai saat pengembangan) */
async function selfTest() {
  const out = process.env.KLM_SELFTEST;
  settings.saveDir = path.join(out, 'received');
  win.webContents.once('did-finish-load', async () => {
    await new Promise(r => setTimeout(r, 2500));
    const res = await win.webContents.executeJavaScript(`(async () => {
      const n = window.klmNative; const info = await n.info();
      const h = await n.fileOpen('Folder A/tes video.mp4');
      const a = new Uint8Array(10*1024*1024); for (let i=0;i<a.length;i++) a[i]=i%251;
      await n.fileWrite(h.id, a); await n.fileWrite(h.id, a.subarray(0, 12345));
      const p = await n.fileClose(h.id);
      return { info, p, status: document.getElementById('statusText').textContent, code: document.getElementById('myCode').textContent, qr: document.getElementById('qr').innerHTML.length };
    })()`);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(res, null, 2));
    const { nativeTheme } = require('electron');
    for (const [w, h, f, t] of [[500, 1100, 'shot-light.png', 'light'], [500, 1100, 'shot-dark.png', 'dark']]) {
      nativeTheme.themeSource = t; win.setSize(w, h); await new Promise(r => setTimeout(r, 800));
      const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(out, f), img.toPNG());
    }
    // ambil halaman seperti dibuka HP lewat jaringan lokal
    const lan = lanAddresses()[0];
    const r = await new Promise(res => http.get(`http://${lan ? lan.address : '127.0.0.1'}:${port}/?to=ABC123`, x => { let n = 0; x.on('data', d => n += d.length); x.on('end', () => res({ status: x.statusCode, bytes: n })); }).on('error', e => res({ error: e.message })));
    fs.writeFileSync(path.join(out, 'lan.json'), JSON.stringify(r));
    app.quit();
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { for (const h of handles.values()) { try { h.fh.close(); fs.unlinkSync(h.temp); } catch (e) {} } if (server) server.close(); app.quit(); });
