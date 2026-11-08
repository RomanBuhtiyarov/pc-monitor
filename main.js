const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, dialog, Notification, shell, powerMonitor } = require('electron');
const path = require('path'), fs = require('fs');
const { execFile } = require('child_process');
const si = require('systeminformation');
const { scan } = require('./src/procs');

app.disableHardwareAcceleration();           // fewer GPU-process resources
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=64');
if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('local.pcmonitor');

const DEFAULTS = { warn: 70, crit: 90, diskWarn: 85, diskCrit: 95, widget: true, widgetPos: null, projectRoots: ['D:\\project_hub'], notify: true };
let cfgFile, cfg = { ...DEFAULTS };
const saveCfg = () => { try { fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2)); } catch {} };

let tray, widget, panel;
let stats = { cpu: 0, ram: 0, ramUsedGB: 0, ramTotalGB: 0, disk: 0, gpu: null, rx: 0, tx: 0 };
let analysis = null, level = 0, worst = { name: 'CPU', v: 0 };
let scanning = false, lastScan = 0, lastNotify = 0, prevLevel = 0, killing = false;

// ---------- tray icon (drawn from pixels, no assets) ----------
const FONT = { 0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001', 5: '111100111001111', 6: '111100111101111', 7: '111001001001001', 8: '111101111101111', 9: '111101111001111' };
const COLORS = [[34, 197, 94], [250, 204, 21], [239, 68, 68]];
function makeIcon(pct, lvl) {
  const S = 32, buf = Buffer.alloc(S * S * 4), [r, g, b] = COLORS[lvl], R = 7;
  const fg = lvl === 2 ? 255 : 20;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = Math.max(R - x, x - (S - 1 - R), 0), dy = Math.max(R - y, y - (S - 1 - R), 0);
    if (dx * dx + dy * dy <= R * R) { const i = (y * S + x) * 4; buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = 255; }
  }
  const s = String(Math.min(99, Math.round(pct))), sc = 4, w = s.length * 3 * sc + (s.length - 1) * 2;
  let ox = Math.round((S - w) / 2); const oy = Math.round((S - 5 * sc) / 2);
  for (const ch of s) {
    for (let k = 0; k < 15; k++) if (FONT[ch][k] === '1') {
      const px = ox + (k % 3) * sc, py = oy + Math.floor(k / 3) * sc;
      for (let yy = 0; yy < sc; yy++) for (let xx = 0; xx < sc; xx++) { const i = ((py + yy) * S + px + xx) * 4; buf[i] = buf[i + 1] = buf[i + 2] = fg; buf[i + 3] = 255; }
    }
    ox += 3 * sc + 2;
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S, scaleFactor: 2 });
}

// ---------- metrics (cheap loop) ----------
const lvlOf = (v, w, c) => v >= c ? 2 : v >= w ? 1 : 0;
function evaluate() {
  const items = [
    { name: 'CPU', v: stats.cpu, l: lvlOf(stats.cpu, cfg.warn, cfg.crit) },
    { name: 'RAM', v: stats.ram, l: lvlOf(stats.ram, cfg.warn, cfg.crit) },
    { name: 'Диск', v: stats.disk, l: lvlOf(stats.disk, cfg.diskWarn, cfg.diskCrit) },
  ];
  if (stats.gpu != null) items.push({ name: 'GPU', v: stats.gpu, l: lvlOf(stats.gpu, cfg.warn, cfg.crit) });
  items.sort((a, b) => b.l - a.l || b.v - a.v);
  worst = items[0]; level = worst.l;
}
let lastIconKey = '';
function updateTray() {
  if (!tray) return;
  const key = Math.round(worst.v) + ':' + level;
  if (key !== lastIconKey) { lastIconKey = key; tray.setImage(makeIcon(worst.v, level)); }
  tray.setToolTip(`PC Monitor\nCPU ${stats.cpu.toFixed(0)}%  RAM ${stats.ram.toFixed(0)}%  Диск ${stats.disk.toFixed(0)}%` + (stats.gpu != null ? `  GPU ${stats.gpu.toFixed(0)}%` : ''));
}
function maybeNotify() {
  if (!cfg.notify || level < 2 || Date.now() - lastNotify < 10 * 60e3 || prevLevel === 2) return;
  lastNotify = Date.now();
  const t = analysis && analysis.top;
  new Notification({ title: `Перегрузка: ${worst.name} ${worst.v.toFixed(0)}%`, body: t ? `Больше всего памяти: ${t.name} (${t.memMB} МБ)${t.project ? ' — ' + t.project : ''}. Откройте PC Monitor.` : 'Откройте PC Monitor, чтобы увидеть детали.' }).show();
}
const visible = w => w && !w.isDestroyed() && w.isVisible();
const broadcast = () => { for (const w of [widget, panel]) if (visible(w)) w.webContents.send('stats', { stats, level, worst, analysis, cfg: { warn: cfg.warn, crit: cfg.crit } }); };

async function fastTick() {
  try {
    const [l, m, n] = await Promise.all([si.currentLoad(), si.mem(), si.networkStats()]);
    stats.cpu = l.currentLoad; stats.ram = (m.total - m.available) / m.total * 100;
    stats.ramUsedGB = (m.total - m.available) / 2 ** 30; stats.ramTotalGB = m.total / 2 ** 30;
    stats.rx = n.reduce((a, x) => a + (x.rx_sec || 0), 0); stats.tx = n.reduce((a, x) => a + (x.tx_sec || 0), 0);
    prevLevel = level; evaluate(); updateTray(); maybeNotify(); broadcast();
  } catch {}
  setTimeout(fastTick, visible(widget) || visible(panel) ? 2000 : 5000);
}
async function diskTick() {
  try { const d = await si.fsSize(); const sys = d.find(x => x.mount && x.mount.toUpperCase().startsWith((process.env.SystemDrive || 'C:').toUpperCase())) || d[0]; if (sys) stats.disk = sys.use; } catch {}
  setTimeout(diskTick, 60000);
}
function gpuTick() {
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', String.raw`(Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction Stop).CounterSamples | Where-Object {$_.InstanceName -match 'engtype_(3D|Compute|VideoDecode|VideoEncode)'} | Group-Object { $_.InstanceName -replace '^pid_\d+_','' } | ForEach-Object { ($_.Group | Measure-Object CookedValue -Sum).Sum } | Measure-Object -Maximum | ForEach-Object Maximum`],
    { windowsHide: true, timeout: 10000 }, (e, out) => {
      const v = parseFloat(String(out).replace(',', '.'));
      stats.gpu = !e && isFinite(v) ? Math.min(100, v) : null;
      setTimeout(gpuTick, visible(widget) || visible(panel) ? 5000 : 20000);
    });
}
async function scanTick() {
  if (scanning) return; scanning = true;
  try { analysis = await scan(cfg); lastScan = Date.now(); broadcast(); } catch (e) { console.error(e); }
  scanning = false;
}
function scanLoop() { // 6s while panel is open, otherwise once a minute
  if (Date.now() - lastScan > (visible(panel) ? 6000 : 60000)) scanTick();
  setTimeout(scanLoop, 3000);
}

// ---------- windows ----------
const webPrefs = { preload: path.join(__dirname, 'src', 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false };
function createWidget() {
  const pos = cfg.widgetPos || (() => { const a = screen.getPrimaryDisplay().workArea; return { x: a.x + a.width - 250, y: a.y + 20 }; })();
  widget = new BrowserWindow({ width: 230, height: 214, x: pos.x, y: pos.y, frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false, webPreferences: webPrefs });
  widget.setAlwaysOnTop(true, 'screen-saver');   // stay above the taskbar and other topmost windows
  widget.loadFile(path.join(__dirname, 'src', 'index.html'), { query: { view: 'widget' } });
  widget.webContents.on('render-process-gone', () => { if (widget && !widget.isDestroyed()) widget.reload(); });
  widget.once('ready-to-show', () => widget.showInactive());
  widget.on('moved', () => { const [x, y] = widget.getPosition(); cfg.widgetPos = { x, y }; saveCfg(); });
  widget.on('closed', () => { widget = null; });
}
function togglePanel() {
  if (panel && !panel.isDestroyed()) { panel.close(); return; }
  const W = 410, H = 600, b = tray.getBounds(), wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  const h = Math.min(H, wa.height - 16);
  const x = Math.max(wa.x + 4, Math.min(b.x + b.width / 2 - W / 2, wa.x + wa.width - W - 4)), y = wa.y + wa.height - h - 8;
  panel = new BrowserWindow({ width: W, height: h, x: Math.round(x), y: Math.round(y), frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false, webPreferences: webPrefs });
  panel.loadFile(path.join(__dirname, 'src', 'index.html'), { query: { view: 'panel' } });
  panel.once('ready-to-show', () => { panel.show(); panel.focus(); scanTick(); });
  panel.on('blur', () => { if (panel && !panel.isDestroyed() && !killing) panel.close(); });
  panel.on('closed', () => { panel = null; });   // renderer freed when closed
}
function setWidget(on) {
  cfg.widget = on; saveCfg();
  if (on) ensureWidget(true); else if (widget && !widget.isDestroyed()) widget.close();
}
// Windows can push the widget behind other windows or lose it after lock/sleep/monitor change: re-assert it.
function ensureWidget(force) {
  if (!cfg.widget && !force) return;
  if (!widget || widget.isDestroyed()) { createWidget(); return; }
  if (!widget.isVisible()) widget.showInactive();
  widget.setAlwaysOnTop(true, 'screen-saver'); widget.moveTop();
  const b = widget.getBounds(), wa = screen.getDisplayMatching(b).workArea;
  if (b.x + b.width < wa.x + 20 || b.x > wa.x + wa.width - 20 || b.y < wa.y - 5 || b.y > wa.y + wa.height - 20)
    widget.setPosition(wa.x + wa.width - b.width - 20, wa.y + 20);   // off-screen after display change
}
function buildMenu() {
  return Menu.buildFromTemplate([
    { label: 'Показать детали', click: togglePanel },
    { label: 'Показать виджет', click: () => setWidget(true) },
    { label: 'Скрыть виджет', click: () => setWidget(false) },
    { label: 'Уведомления о перегрузке', type: 'checkbox', checked: cfg.notify, click: i => { cfg.notify = i.checked; saveCfg(); } },
    { label: 'Автозапуск с Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: i => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { label: 'Открыть файл настроек (пороги)', click: () => shell.openPath(cfgFile) },
    { type: 'separator' },
    { label: 'Выход', click: () => app.quit() },
  ]);
}

// ---------- IPC ----------
const PROTECTED = /^(system|csrss|wininit|winlogon|services|lsass|smss|explorer|svchost|dwm|registry|fontdrvhost)(\.exe)?$/i;
ipcMain.handle('kill', async (_e, { pid, name, memMB, project }) => {
  if (!Number.isInteger(pid) || pid <= 4 || pid === process.pid || PROTECTED.test(String(name))) return { ok: false, msg: 'Системный процесс — защищён' };
  killing = true;
  const r = await dialog.showMessageBox({ type: 'warning', buttons: ['Завершить', 'Отмена'], defaultId: 1, cancelId: 1, title: 'Завершить процесс?',
    message: `${name} (PID ${pid})`, detail: `Память: ${memMB} МБ${project ? '\nПроект: ' + project : ''}\n\nПроцесс и его дочерние процессы будут принудительно закрыты. Несохранённые данные будут потеряны.` });
  killing = false;
  if (r.response !== 0) return { ok: false, msg: 'Отменено' };
  return new Promise(res => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, e => { setTimeout(scanTick, 800); res({ ok: !e, msg: e ? 'Не удалось завершить' : 'Завершён' }); }));
});
let dragOff = null;
ipcMain.on('widget-drag', (_e, { phase, x, y }) => {
  if (!widget || widget.isDestroyed()) return;
  const b = widget.getBounds();
  if (phase === 'start') { dragOff = { x: x - b.x, y: y - b.y, w: b.width, h: b.height }; return; }
  if (!dragOff) return;
  if (phase === 'move') {
    const wa = screen.getDisplayNearestPoint({ x, y }).workArea;
    const nx = Math.max(wa.x, Math.min(x - dragOff.x, wa.x + wa.width - dragOff.w));
    const ny = Math.max(wa.y, Math.min(y - dragOff.y, wa.y + wa.height - dragOff.h));
    widget.setBounds({ x: Math.round(nx), y: Math.round(ny), width: dragOff.w, height: dragOff.h });
  } else { const [px, py] = widget.getPosition(); cfg.widgetPos = { x: px, y: py }; saveCfg(); dragOff = null; }
});
ipcMain.handle('unload-model', async (_e, { runtime, model }) => {
  // only models the last scan actually reported as loaded can be unloaded
  const known = analysis && analysis.llm && analysis.llm.local.some(m => m.runtime === runtime && m.model === model);
  if (!known || runtime !== 'ollama') return { ok: false, msg: 'Выгрузка поддерживается только для Ollama' };
  const ok = await require('./src/llm').unloadOllama(model);
  setTimeout(scanTick, 800);
  return { ok, msg: ok ? 'Выгружено' : 'Не удалось выгрузить' };
});
ipcMain.on('open-panel', togglePanel);
ipcMain.on('close-panel', () => panel && !panel.isDestroyed() && panel.close());
ipcMain.on('widget-menu', () => Menu.buildFromTemplate([
  { label: 'Подробнее', click: togglePanel }, { label: 'Скрыть виджет', click: () => setWidget(false) }, { type: 'separator' }, { label: 'Выход', click: () => app.quit() },
]).popup());

app.whenReady().then(() => {
  cfgFile = path.join(app.getPath('userData'), 'settings.json');
  try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')) }; } catch { saveCfg(); }
  tray = new Tray(makeIcon(0, 0)); tray.setToolTip('PC Monitor');
  tray.on('click', togglePanel); tray.on('double-click', () => setWidget(true)); tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
  if (cfg.widget) createWidget();
  setInterval(ensureWidget, 20000);
  for (const ev of ['unlock-screen', 'resume']) powerMonitor.on(ev, () => setTimeout(ensureWidget, 1500));
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, () => setTimeout(ensureWidget, 1000));
  fastTick(); diskTick(); gpuTick(); scanTick(); setTimeout(scanLoop, 3000);
});
app.on('window-all-closed', e => e.preventDefault());   // live in the tray
app.on('second-instance', togglePanel);
