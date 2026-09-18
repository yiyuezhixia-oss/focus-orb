const { spawn } = require('child_process');
const os = require('os');
const { app, BrowserWindow, ipcMain, Menu, Tray, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const SIZES = [80, 96, 120];
const DEFAULT_ORB_SIZE = 96;

/* 守护：仅对屏蔽列表生效，绝不结束以下进程 */
const GUARDED = new Set([
  'explorer.exe', 'dwm.exe', 'winlogon.exe', 'csrss.exe', 'smss.exe', 'wininit.exe',
  'services.exe', 'lsass.exe', 'svchost.exe', 'fontdrvhost.exe', 'ctfmon.exe', 'sihost.exe',
  'taskhostw.exe', 'runtimebroker.exe', 'shellexperiencehost.exe', 'startmenuexperiencehost.exe',
  'searchhost.exe', 'searchapp.exe', 'searchindexer.exe', 'applicationframehost.exe',
  'taskmgr.exe', 'conhost.exe', 'audiodg.exe', 'spoolsv.exe', 'wmiprvse.exe',
  'powershell.exe', 'cmd.exe', 'wsl.exe', 'node.exe', 'electron.exe',
  'focus orb.exe', 'focusorb.exe', 'focusorb-1.0.0.exe'
]);
try {
  GUARDED.add(path.basename(process.execPath).toLowerCase());
} catch (e) { /* ignore */ }

const GUARD_INTERVAL = 3000;  // 检测间隔
const GUARD_GRACE = 5000;     // 礼貌关闭等待时间
const GUARD_MAX_TRY = 3;      // 单个进程强制结束重试上限
const NOTICE_W = 300;
const NOTICE_H = 112;
const NOTICE_GAP = 14;
const NOTICE_MS = 5000;
const HIDE_ANIM_MS = 260;

let setupWin = null;
let orbWin = null;
let noticeWin = null;
let tray = null;
let iconPath = null;

let sessionActive = false;
let sessionPaused = false;
let sessionDone = false;
let currentSession = null;
let dragBase = null;
let noticeHideTimer = null;
let noticeCloseTimer = null;
let quitting = false;
let appsWin = null;
let pendingAppsSelection = [];
let guardTimer = null;
const pendingKill = new Map();

const store = { last: null, orbPos: null };

/* ---------------- 本地存储 ---------------- */

function storePath() {
  return path.join(app.getPath('userData'), 'focus-orb.json');
}

function loadStore() {
  try {
    const data = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    if (data && typeof data === 'object') {
      store.last = data.last || null;
      store.orbPos = data.orbPos || null;
    }
  } catch (e) { /* 首次运行无配置 */ }
}

function saveStore() {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(store, null, 2));
  } catch (e) { /* 忽略写入失败 */ }
}

/* ---------------- 托盘图标（运行时生成 PNG，无外部资源） ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(rgba, w, h) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function buildIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const r = size / 2 - 1.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const d = Math.sqrt(dx * dx + dy * dy);
      const a = Math.max(0, Math.min(1, r - d + 0.5));
      const t = y / (size - 1);
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(255 - 18 * t);
      rgba[i + 1] = Math.round(122 - 48 * t);
      rgba[i + 2] = Math.round(91 - 30 * t);
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(rgba, size, size);
}

function ensureIcon() {
  const dir = app.getPath('userData');
  iconPath = path.join(dir, 'orb-icon.png');
  try {
    if (!fs.existsSync(iconPath)) fs.writeFileSync(iconPath, buildIcon(64));
  } catch (e) {
    iconPath = null;
  }
}

/* ---------------- 窗口 ---------------- */

function preloadFile() {
  return path.join(__dirname, 'preload.js');
}

function commonWebPreferences() {
  return {
    preload: preloadFile(),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    backgroundThrottling: false
  };
}

function createSetupWindow() {
  setupWin = new BrowserWindow({
    width: 470,
    height: 838,
    minWidth: 470,
    minHeight: 660,
    resizable: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    center: true,
    fullscreenable: false,
    maximizable: false,
    icon: iconPath || undefined,
    title: 'Focus Orb',
    webPreferences: commonWebPreferences()
  });
  setupWin.loadFile(path.join(__dirname, 'src', 'setup.html'));
  setupWin.once('ready-to-show', () => {
    setupWin.show();
    setupWin.focus();
  });
  setupWin.on('close', (e) => {
    if (quitting) return;
    if (sessionActive) {
      e.preventDefault();
      setupWin.hide();
      return;
    }
    quitting = true;
    app.quit();
  });
  setupWin.on('closed', () => { setupWin = null; });
}

function showSetup() {
  if (!setupWin || setupWin.isDestroyed()) createSetupWindow();
  else {
    if (setupWin.isMinimized()) setupWin.restore();
    setupWin.show();
    setupWin.focus();
  }
}

function orbSizeOf(cfg) {
  const v = cfg && cfg.orbSize;
  return SIZES.includes(v) ? v : DEFAULT_ORB_SIZE;
}

function showAppsWindow(selected) {
  if (appsWin && !appsWin.isDestroyed()) {
    appsWin.focus();
    return;
  }
  appsWin = new BrowserWindow({
    width: 580,
    height: 680,
    parent: setupWin || undefined,
    frame: false,
    transparent: true,
    resizable: false,
    backgroundColor: '#00000000',
    show: false,
    fullscreenable: false,
    maximizable: false,
    icon: iconPath || undefined,
    webPreferences: commonWebPreferences()
  });
  appsWin.loadFile(path.join(__dirname, 'src', 'apps.html'));
  appsWin.once('ready-to-show', () => appsWin.show());
  appsWin.on('closed', () => {
    appsWin = null;
    if (setupWin && !setupWin.isDestroyed()) setupWin.focus();
  });
  pendingAppsSelection = Array.isArray(selected) ? selected : [];
}

function ensureOrbWindow() {
  if (orbWin && !orbWin.isDestroyed()) return orbWin;
  orbWin = new BrowserWindow({
    width: DEFAULT_ORB_SIZE,
    height: DEFAULT_ORB_SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    show: false,
    fullscreenable: false,
    webPreferences: commonWebPreferences()
  });
  orbWin.loadFile(path.join(__dirname, 'src', 'orb.html'));
  orbWin.setAlwaysOnTop(true, 'screen-saver');
  try {
    orbWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (e) { /* 部分平台不支持 */ }
  orbWin.on('closed', () => { orbWin = null; });
  return orbWin;
}

function defaultOrbPos(size) {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + area.width - size - 96,
    y: area.y + Math.round(area.height * 0.32)
  };
}

function showOrb(size) {
  const win = ensureOrbWindow();
  const s = size || DEFAULT_ORB_SIZE;
  if (win.getSize()[0] !== s) win.setSize(s, s);
  const pos = store.orbPos || defaultOrbPos(s);
  const display = screen.getDisplayNearestPoint({ x: pos.x, y: pos.y });
  const area = display.workArea;
  const x = Math.min(Math.max(pos.x, area.x), area.x + area.width - s);
  const y = Math.min(Math.max(pos.y, area.y), area.y + area.height - s);
  win.setPosition(Math.round(x), Math.round(y));
  win.show();
  win.focus();
}

function ensureNoticeWindow() {
  if (noticeWin && !noticeWin.isDestroyed()) return noticeWin;
  noticeWin = new BrowserWindow({
    width: NOTICE_W,
    height: NOTICE_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#00000000',
    show: false,
    fullscreenable: false,
    webPreferences: commonWebPreferences()
  });
  noticeWin.loadFile(path.join(__dirname, 'src', 'notice.html'));
  noticeWin.setAlwaysOnTop(true, 'screen-saver');
  try {
    noticeWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (e) { /* ignore */ }
  noticeWin.setIgnoreMouseEvents(true);
  noticeWin.on('closed', () => { noticeWin = null; });
  return noticeWin;
}

function showNotice(payload) {
  if (!orbWin || orbWin.isDestroyed()) return;
  const win = ensureNoticeWindow();
  const ob = orbWin.getBounds();
  const display = screen.getDisplayNearestPoint({ x: ob.x, y: ob.y });
  const area = display.workArea;

  let side;
  if (ob.x + ob.width + NOTICE_GAP + NOTICE_W <= area.x + area.width) side = 'right';
  else if (ob.x - NOTICE_GAP - NOTICE_W >= area.x) side = 'left';
  else side = (ob.x - area.x) < (area.x + area.width - (ob.x + ob.width)) ? 'right' : 'left';

  const x = side === 'right' ? ob.x + ob.width + NOTICE_GAP : ob.x - NOTICE_GAP - NOTICE_W;
  let y = ob.y + Math.round(ob.height / 2 - NOTICE_H / 2);
  y = Math.min(Math.max(y, area.y + 4), area.y + area.height - NOTICE_H - 4);

  win.setBounds({ x: Math.round(x), y: Math.round(y), width: NOTICE_W, height: NOTICE_H });

  const deliver = () => win.webContents.send('notice-data', Object.assign({}, payload, { side }));
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', deliver);
  else deliver();

  clearTimeout(noticeHideTimer);
  clearTimeout(noticeCloseTimer);
  if (!win.isVisible()) win.showInactive();
  noticeHideTimer = setTimeout(() => {
    win.webContents.send('notice-hide');
    noticeCloseTimer = setTimeout(() => {
      if (noticeWin && !noticeWin.isDestroyed()) noticeWin.hide();
    }, HIDE_ANIM_MS);
  }, NOTICE_MS);
}

function hideNotice() {
  clearTimeout(noticeHideTimer);
  clearTimeout(noticeCloseTimer);
  if (noticeWin && !noticeWin.isDestroyed() && noticeWin.isVisible()) {
    noticeWin.webContents.send('notice-hide');
    noticeCloseTimer = setTimeout(() => {
      if (noticeWin && !noticeWin.isDestroyed()) noticeWin.hide();
    }, HIDE_ANIM_MS);
  }
}

function endSession(backToSetup) {
  sessionActive = false;
  sessionPaused = false;
  sessionDone = false;
  currentSession = null;
  stopGuard();
  hideNotice();
  if (orbWin && !orbWin.isDestroyed()) {
    orbWin.hide();
  }
  updateTrayMenu();
  if (backToSetup !== false) showSetup();
}

/* ---------------- 托盘 ---------------- */

function updateTrayMenu() {
  if (!tray) return;
  const template = [];
  if (sessionActive) {
    template.push({
      label: sessionPaused ? '继续专注' : '暂停专注',
      click: () => {
        if (orbWin && !orbWin.isDestroyed()) orbWin.webContents.send('orb-command', sessionPaused ? 'resume' : 'pause');
      }
    });
    template.push({ label: '重新开始本次专注', click: () => { if (orbWin) orbWin.webContents.send('orb-command', 'restart'); } });
    template.push({ type: 'separator' });
    template.push({ label: '结束专注', click: () => endSession(true) });
  } else {
    template.push({ label: '新建专注', click: () => showSetup() });
  }
  template.push({ type: 'separator' });
  template.push({
    label: '退出',
    click: () => {
      quitting = true;
      app.exit(0);
    }
  });
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  if (!iconPath) return;
  tray = new Tray(iconPath);
  tray.setToolTip('Focus Orb 番茄钟');
  updateTrayMenu();
  tray.on('click', () => {
    if (sessionActive && orbWin && !orbWin.isDestroyed()) {
      if (orbWin.isVisible()) orbWin.focus();
      else showOrb(orbSizeOf(currentSession));
    } else {
      showSetup();
    }
  });
}

/* ---------------- 软件扫描 ---------------- */

function runPs(script, cb) {
  let child;
  try {
    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
  } catch (e) {
    if (cb) cb();
    return;
  }
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    if (cb) cb();
  };
  child.on('error', done);
  child.on('close', done);
  setTimeout(() => {
    try { child.kill(); } catch (e) { /* ignore */ }
    done();
  }, 60000);
}

function readJsonFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(data) ? data : [data];
  } catch (e) {
    return [];
  }
}

function scanInstalledApps() {
  const outFile = path.join(os.tmpdir(), 'focus-orb-scan.json');
  try { fs.unlinkSync(outFile); } catch (e) { /* ignore */ }
  const out = outFile.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$outFile = '" + out + "'",
    "$items = @{}",
    "function AddItem($n, $p) {",
    "  if (-not $n -or -not $p) { return }",
    "  if ($p -notmatch '\\.exe$') { return }",
    "  if (-not (Test-Path -LiteralPath $p)) { return }",
    "  if ($n -match '(?i)(uninstall|unins000|卸载|remove|repair|修复)') { return }",
    "  $key = $p.ToLower()",
    "  if (-not $script:items.ContainsKey($key)) { $script:items[$key] = [PSCustomObject]@{ name = $n; path = $p } }",
    "}",
    "$shell = New-Object -ComObject WScript.Shell",
    "$dirs = @($env:ProgramData + '\\Microsoft\\Windows\\Start Menu\\Programs', $env:APPDATA + '\\Microsoft\\Windows\\Start Menu\\Programs')",
    "foreach ($d in $dirs) {",
    "  if (Test-Path -LiteralPath $d) {",
    "    Get-ChildItem -LiteralPath $d -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {",
    "      AddItem $_.BaseName $shell.CreateShortcut($_.FullName).TargetPath",
    "    }",
    "  }",
    "}",
    "$regKeys = @('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    "foreach ($k in $regKeys) {",
    "  Get-ItemProperty -Path $k -ErrorAction SilentlyContinue | ForEach-Object {",
    "    $dn = $_.DisplayName; $di = $_.DisplayIcon",
    "    if (-not $dn) { return }",
    "    if ($di) { AddItem $dn (($di -split ',')[0].Trim([char]34).Trim()) }",
    "  }",
    "}",
    "$arr = @($items.Values | Sort-Object -Property name)",
    "if ($arr.Count -eq 0) { '[]' | Out-File -FilePath $outFile -Encoding utf8 }",
    "else { $arr | ConvertTo-Json -Compress | Out-File -FilePath $outFile -Encoding utf8 }"
  ].join('\n');

  return new Promise((resolve) => {
    runPs(script, () => resolve(readJsonFile(outFile)));
  });
}

/* ---------------- 屏蔽守护 ---------------- */

function procsScript(outFile, names) {
  const filter = names.map((n) => "Name='" + n.replace(/'/g, "''") + "'").join(' OR ');
  const out = outFile.replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$outFile = '" + out + "'",
    "$procs = @(Get-CimInstance Win32_Process -Filter \"" + filter + "\")",
    "if ($procs.Count -eq 0) { '[]' | Out-File -FilePath $outFile -Encoding utf8 }",
    "else { @($procs | Select-Object ProcessId,Name,ExecutablePath) | ConvertTo-Json -Compress | Out-File -FilePath $outFile -Encoding utf8 }"
  ].join('\n');
}

function closeScript(pids, force) {
  const ids = pids.join(',');
  if (force) {
    return [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "foreach ($id in @(" + ids + ")) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }"
    ].join('\n');
  }
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "foreach ($id in @(" + ids + ")) {",
    "  $p = Get-Process -Id $id -ErrorAction SilentlyContinue",
    "  if ($p) {",
    "    if ($p.MainWindowHandle -ne 0) { $null = $p.CloseMainWindow() }",
    "    else { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }",
    "  }",
    "}"
  ].join('\n');
}

function checkBlocked() {
  if (!sessionActive || !currentSession) return;
  const apps = (currentSession.blockedApps || []).filter((a) => a && a.path);
  const names = [...new Set(apps.map((a) => path.basename(String(a.path)).toLowerCase()))]
    .filter((n) => /\.exe$/.test(n) && !GUARDED.has(n));
  if (!names.length) return;

  const outFile = path.join(os.tmpdir(), 'focus-orb-procs.json');
  runPs(procsScript(outFile, names), () => {
    const procs = readJsonFile(outFile);
    const now = Date.now();
    const alive = new Set();
    const graceful = [];
    const force = [];

    for (const p of procs) {
      const pid = Number(p.ProcessId);
      if (!pid) continue;
      alive.add(pid);
      const pname = String(p.Name || '').toLowerCase();
      if (GUARDED.has(pname)) continue;
      const ppath = String(p.ExecutablePath || '').toLowerCase();
      const hit = apps.some((a) => {
        const ap = String(a.path).toLowerCase();
        return ppath ? ap === ppath : path.basename(ap) === pname;
      });
      if (!hit) continue;

      const rec = pendingKill.get(pid);
      if (!rec) {
        pendingKill.set(pid, { t: now, tries: 0 });
        graceful.push(pid);
      } else if (now - rec.t >= GUARD_GRACE) {
        if (rec.tries >= GUARD_MAX_TRY) continue;
        rec.tries += 1;
        rec.t = now;
        force.push(pid);
      }
    }

    for (const pid of [...pendingKill.keys()]) if (!alive.has(pid)) pendingKill.delete(pid);

    if (graceful.length) runPs(closeScript(graceful, false));
    if (force.length) runPs(closeScript(force, true));
  });
}

function startGuard() {
  stopGuard();
  const apps = (currentSession && currentSession.blockedApps) || [];
  if (!apps.length) return;
  pendingKill.clear();
  guardTimer = setInterval(checkBlocked, GUARD_INTERVAL);
  checkBlocked();
}

function stopGuard() {
  if (guardTimer) clearInterval(guardTimer);
  guardTimer = null;
  pendingKill.clear();
}

/* ---------------- IPC ---------------- */

ipcMain.handle('get-initial', () => ({ last: store.last }));

ipcMain.on('start-session', (_e, cfg) => {
  store.last = cfg;
  saveStore();
  currentSession = cfg;
  sessionActive = true;
  sessionPaused = false;
  sessionDone = false;
  hideNotice();
  if (setupWin && !setupWin.isDestroyed()) setupWin.hide();
  showOrb(orbSizeOf(cfg));
  const win = ensureOrbWindow();
  const send = () => win.webContents.send('session-data', cfg);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
  startGuard();
  updateTrayMenu();
});

ipcMain.on('orb-ready', () => {
  if (currentSession && orbWin && !orbWin.isDestroyed()) {
    orbWin.webContents.send('session-data', currentSession);
  }
});

ipcMain.on('orb-state', (_e, st) => {
  const before = sessionPaused;
  sessionPaused = !!st.paused;
  sessionDone = !!st.done;
  if (before !== sessionPaused) updateTrayMenu();
});

ipcMain.on('orb-drag-start', () => {
  if (!orbWin) return;
  dragBase = { pos: orbWin.getPosition(), start: screen.getCursorScreenPoint() };
});

ipcMain.on('orb-drag-move', () => {
  if (!dragBase || !orbWin || orbWin.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  orbWin.setPosition(
    Math.round(dragBase.pos[0] + p.x - dragBase.start.x),
    Math.round(dragBase.pos[1] + p.y - dragBase.start.y)
  );
});

ipcMain.on('orb-drag-end', () => {
  dragBase = null;
  if (orbWin && !orbWin.isDestroyed()) {
    const [x, y] = orbWin.getPosition();
    store.orbPos = { x, y };
    saveStore();
  }
});

ipcMain.on('orb-menu', (_e, st) => {
  if (!orbWin) return;
  const paused = !!(st && st.paused);
  const menu = Menu.buildFromTemplate([
    {
      label: paused ? '继续' : '暂停',
      click: () => orbWin.webContents.send('orb-command', paused ? 'resume' : 'pause')
    },
    { label: '重新开始', click: () => orbWin.webContents.send('orb-command', 'restart') },
    { label: '新建 / 编辑专注', click: () => showSetup() },
    { type: 'separator' },
    { label: '结束专注', click: () => endSession(true) },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.exit(0);
      }
    }
  ]);
  menu.popup({ window: orbWin });
});

ipcMain.on('show-notice', (_e, payload) => showNotice(payload));
ipcMain.on('hide-notice', () => hideNotice());

ipcMain.on('session-finished', () => {
  sessionDone = true;
  updateTrayMenu();
});

ipcMain.on('open-setup', () => showSetup());
ipcMain.on('end-session', () => endSession(true));
ipcMain.on('win-minimize', () => { if (setupWin) setupWin.minimize(); });
ipcMain.on('win-close', () => { if (setupWin) setupWin.close(); });

ipcMain.handle('scan-apps', async () => await scanInstalledApps());
ipcMain.on('open-apps', (_e, selected) => showAppsWindow(selected));
ipcMain.on('apps-ready', () => {
  if (appsWin && !appsWin.isDestroyed()) appsWin.webContents.send('apps-init', pendingAppsSelection);
});
ipcMain.on('apps-confirm', (_e, list) => {
  const picked = Array.isArray(list) ? list : [];
  if (setupWin && !setupWin.isDestroyed()) setupWin.webContents.send('apps-selected', picked);
  if (appsWin && !appsWin.isDestroyed()) appsWin.close();
});
ipcMain.on('apps-cancel', () => {
  if (appsWin && !appsWin.isDestroyed()) appsWin.close();
});
ipcMain.on('close-apps', () => {
  if (appsWin && !appsWin.isDestroyed()) appsWin.close();
});

/* ---------------- 启动 ---------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showSetup());

  app.whenReady().then(() => {
    loadStore();
    ensureIcon();
    createTray();
    ensureNoticeWindow();
    createSetupWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createSetupWindow();
      else showSetup();
    });
  });
}

app.on('before-quit', () => {
  quitting = true;
  stopGuard();
  saveStore();
});
