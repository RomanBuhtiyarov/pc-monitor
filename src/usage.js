// Local token accounting: reads Claude Code and Codex session logs incrementally (only new bytes each time).
// No API keys, no network. Message text is never stored - only token counts, timestamps, model and project name.
const fs = require('fs'), os = require('os'), path = require('path');

const RETAIN_MS = 8 * 86400e3;
const CLAUDE_BASE = path.join(os.homedir(), '.claude', 'projects');
const CODEX_BASE = path.join(os.homedir(), '.codex', 'sessions');

let cacheFile = null, st = { v: 1, files: {}, events: [], codexRL: null };
let idx = new Map(), summaryCache = null, running = false, ready = false, dirty = false, lastSave = 0;

// USD per 1M tokens (input, output) - API list prices, used only for an approximate "API-equivalent" figure.
const PRICES = [
  [/^claude-(fable|mythos)-5-2/, 8, 40], [/^claude-(fable|mythos)-5/, 10, 50],
  [/^claude-opus-5-5/, 4, 20], [/^claude-opus-/, 5, 25],
  [/^claude-sonnet-5/, 2, 10], [/^claude-sonnet-4/, 3, 15],
  [/^claude-haiku-5/, 0.1, 0.5], [/^claude-haiku-4/, 1, 5],
];
const price = model => { for (const [re, i, o] of PRICES) if (re.test(model || '')) return { i, o }; return null; };

function init(dir) {
  cacheFile = path.join(dir, 'usage-cache.json');
  try { const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (j && j.v === 1) st = j; } catch {}
  rebuildIdx();
}
function rebuildIdx() { idx = new Map(); st.events.forEach((e, i) => { if (e.id) idx.set(e.id, i); }); }
function save(force) {
  if (!cacheFile || !dirty || (!force && Date.now() - lastSave < 120000)) return;
  try { fs.writeFileSync(cacheFile, JSON.stringify(st)); dirty = false; lastSave = Date.now(); } catch {}
}

function walk(dir, depth, out, cutoff, tool) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1, out, cutoff, tool); }
    else if (e.name.endsWith('.jsonl')) { try { const s = fs.statSync(p); if (s.mtimeMs >= cutoff) out.push({ p, size: s.size, tool }); } catch {} }
  }
}
const lastSeg = s => String(s).replace(/[\\/]+$/, '').split(/[\\/]/).pop();

function parseClaude(line, f, cutoff) {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
  let j; try { j = JSON.parse(line); } catch { return; }
  const m = j.message;
  if (j.type !== 'assistant' || !m || !m.usage || m.model === '<synthetic>') return;
  if (j.cwd) f.proj = lastSeg(j.cwd);
  const t = Date.parse(j.timestamp); if (!(t > cutoff)) return;
  const u = m.usage, cc = u.cache_creation_input_tokens || 0;
  const cc1 = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
  const ev = { id: m.id || null, t, tool: 'claude', proj: f.proj || 'без проекта', model: m.model, in: u.input_tokens || 0, out: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0, cc5: Math.max(0, cc - cc1), cc1 };
  if (!ev.in && !ev.out && !ev.cr && !cc) return;
  if (ev.id && idx.has(ev.id)) {            // one API response is logged as several lines (one per content block)
    const old = st.events[idx.get(ev.id)];
    if (ev.out > old.out) { Object.assign(old, ev); dirty = true; }
    return;
  }
  if (ev.id) idx.set(ev.id, st.events.length);
  st.events.push(ev); dirty = true;
}

function parseCodex(line, f, cutoff) {
  const tc = line.includes('"token_count"'), sm = line.includes('"session_meta"'), cx = line.includes('"turn_context"');
  if (!tc && !sm && !cx) return;
  let j; try { j = JSON.parse(line); } catch { return; }
  const p = j.payload; if (!p) return;
  if (sm && p.cwd) f.proj = lastSeg(p.cwd);
  if (cx && p.model) f.model = p.model;
  if (!(tc && j.type === 'event_msg' && p.type === 'token_count')) return;
  const t = Date.parse(j.timestamp);
  const rl = p.rate_limits;
  if (rl && (rl.primary || rl.secondary) && (!st.codexRL || t >= st.codexRL.t)) {
    const w = x => x ? { used: x.used_percent, win: x.window_minutes, reset: x.resets_at } : null;
    st.codexRL = { t, plan: rl.plan_type || null, primary: w(rl.primary), secondary: w(rl.secondary) }; dirty = true;
  }
  const info = p.info; if (!info || !info.last_token_usage || !(t > cutoff)) return;
  const total = info.total_token_usage && info.total_token_usage.total_tokens;
  if (total != null && total === f.lastTotal) return;   // the same record is written twice
  f.lastTotal = total;
  const l = info.last_token_usage, cached = l.cached_input_tokens || 0;
  st.events.push({ id: null, t, tool: 'codex', proj: f.proj || 'без проекта', model: f.model || 'codex', in: Math.max(0, (l.input_tokens || 0) - cached), out: l.output_tokens || 0, cr: cached, cc5: 0, cc1: 0 });
  dirty = true;
}

async function readNew(file, f, cutoff) {
  if (file.size < f.off) { f.off = 0; f.lastTotal = null; }
  const parse = file.tool === 'claude' ? parseClaude : parseCodex;
  const fh = await fs.promises.open(file.p, 'r');
  try {
    let pos = f.off, carry = Buffer.alloc(0);
    while (pos < file.size) {
      const len = Math.min(8 * 1024 * 1024, file.size - pos), buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const data = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
      const nl = data.lastIndexOf(10);
      if (nl < 0) { carry = data; continue; }
      carry = data.subarray(nl + 1);
      for (const line of data.subarray(0, nl).toString('utf8').split('\n')) if (line) parse(line, f, cutoff);
      f.off = pos - carry.length;
      await new Promise(r => setImmediate(r));   // let the app breathe between chunks
    }
  } finally { await fh.close(); }
}

async function refresh() {
  if (running) return; running = true;
  try {
    const cutoff = Date.now() - RETAIN_MS, files = [];
    walk(CLAUDE_BASE, 0, files, cutoff, 'claude'); walk(CODEX_BASE, 0, files, cutoff, 'codex');
    for (const file of files) {
      const f = st.files[file.p] || (st.files[file.p] = { off: 0, tool: file.tool });
      if (file.size === f.off) continue;
      try { await readNew(file, f, cutoff); } catch {}
    }
    const keep = new Set(files.map(x => x.p));
    for (const k of Object.keys(st.files)) if (!keep.has(k)) { delete st.files[k]; dirty = true; }
    const n = st.events.length;
    st.events = st.events.filter(e => e.t > cutoff);
    if (st.events.length !== n) { rebuildIdx(); dirty = true; }
    summaryCache = build(); ready = true; save(false);
  } finally { running = false; }
}

function agg(list) {
  const a = { msgs: list.length, newTok: 0, in: 0, out: 0, cc: 0, cr: 0, cost: 0, unpriced: 0 };
  for (const e of list) {
    const cc = e.cc5 + e.cc1;
    a.in += e.in; a.out += e.out; a.cc += cc; a.cr += e.cr; a.newTok += e.in + e.out + cc;
    const p = e.tool === 'claude' ? price(e.model) : null;
    if (p) a.cost += (e.in * p.i + e.cc5 * p.i * 1.25 + e.cc1 * p.i * 2 + e.cr * p.i * 0.1 + e.out * p.o) / 1e6; else if (e.tool === 'claude') a.unpriced++;
  }
  a.cost = +a.cost.toFixed(2);
  return a;
}
function top(list, key, n) {
  const m = new Map();
  for (const e of list) { const o = m.get(e[key]) || { name: e[key], newTok: 0, out: 0, msgs: 0 }; o.newTok += e.in + e.out + e.cc5 + e.cc1; o.out += e.out; o.msgs++; m.set(e[key], o); }
  return [...m.values()].sort((a, b) => b.newTok - a.newTok).slice(0, n);
}
function build() {
  const now = Date.now(), day0 = new Date().setHours(0, 0, 0, 0), h5 = now - 5 * 3600e3, d7 = now - 7 * 86400e3;
  const out = { at: now };
  for (const tool of ['claude', 'codex']) {
    const ev = st.events.filter(e => e.tool === tool), today = ev.filter(e => e.t >= day0);
    out[tool] = { today: agg(today), h5: agg(ev.filter(e => e.t >= h5)), d7: agg(ev.filter(e => e.t >= d7)), projects: top(today, 'proj', 5), models: top(today, 'model', 4) };
  }
  const rl = st.codexRL;
  out.codex.limits = rl ? { plan: rl.plan, asOf: rl.t, windows: [rl.primary, rl.secondary].filter(Boolean).map(w => ({ usedPct: w.reset * 1000 < now ? 0 : w.used, windowMin: w.win, resetsAt: w.reset * 1000, expired: w.reset * 1000 < now })) } : null;
  return out;
}

module.exports = { init, refresh, save: () => save(true), summary: () => summaryCache, isReady: () => ready };
