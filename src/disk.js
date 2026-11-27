// Disk read / write speed of all physical disks: one long-running typeperf (no PowerShell, no admin rights),
// started only while the widget shows the disk indicator.
const { spawn } = require('child_process');

const EVERY = 2, STALE_MS = 10000, RETRY_MS = 30000;
// String.raw keeps the backslashes of the counter path
const COUNTERS = [String.raw`\PhysicalDisk(_Total)\Disk Read Bytes/sec`, String.raw`\PhysicalDisk(_Total)\Disk Write Bytes/sec`];
const state = { status: 'wait', read: null, write: null, seq: 0 };   // status: wait | ok | error
let child = null, buf = '', lastAt = 0, failedAt = 0;

// Pure: takes the complete CSV rows ("time","read","write") out of the buffer. typeperf ends a row only
// when the next one starts, so a row counts as complete as soon as its second value is closed.
function parse(text) {
  const re = /"\d\d[^"\r\n]*","\s*(\d+(?:[.,]\d+)?)","\s*(\d+(?:[.,]\d+)?)"/g, rows = [];
  let m, end = 0;
  while ((m = re.exec(text))) { rows.push({ read: +m[1].replace(',', '.'), write: +m[2].replace(',', '.') }); end = re.lastIndex; }
  return { rows, rest: text.slice(end).slice(-2000) };
}

function stop() {
  const c = child; child = null; buf = '';
  if (c) c.kill();
}
function fail() { stop(); failedAt = Date.now(); Object.assign(state, { status: 'error', read: null, write: null }); }
function start() {
  const c = spawn('typeperf', [...COUNTERS, '-si', String(EVERY)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  child = c; buf = ''; lastAt = Date.now();
  c.stdout.on('data', d => {
    if (c !== child) return;
    const r = parse(buf + d); buf = r.rest;
    for (const x of r.rows) { lastAt = Date.now(); Object.assign(state, { status: 'ok', read: x.read, write: x.write }); state.seq++; }
  });
  const gone = () => { if (c === child) fail(); };   // not found, no such counter (localized names), killed from outside
  c.on('error', gone); c.on('exit', gone);
}
// Call often: starts, stops, restarts a silent process and retries after a failure.
function sync(wanted) {
  if (!wanted) { if (child) stop(); failedAt = 0; Object.assign(state, { status: 'wait', read: null, write: null }); return; }
  if (child) { if (Date.now() - lastAt > STALE_MS) fail(); return; }
  if (Date.now() - failedAt >= RETRY_MS) start();
}

module.exports = { state, sync, stop, parse };
