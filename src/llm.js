// LLM-related monitoring: CLI/desktop tools (from the process list), Codex session logs, local model runtimes (Ollama, LM Studio).
const fs = require('fs'), os = require('os'), path = require('path');

const TOOLS = [
  { id: 'claude', label: 'Claude', kind: 'CLI / приложение', name: /^claude\.exe$/i },
  { id: 'codex', label: 'Codex CLI', kind: 'CLI', name: /^codex\.exe$/i, cmd: /@openai[\\/]codex|codex-cli/i },
  { id: 'gemini', label: 'Gemini CLI', kind: 'CLI', name: /^gemini\.exe$/i, cmd: /gemini-cli/i },
  { id: 'aider', label: 'aider', kind: 'CLI', name: /^aider\.exe$/i, cmd: /\baider\b/i },
  { id: 'opencode', label: 'opencode', kind: 'CLI', name: /^opencode\.exe$/i },
  { id: 'chatgpt', label: 'ChatGPT Desktop', kind: 'приложение', name: /^chatgpt\.exe$/i },
  { id: 'ollama', label: 'Ollama', kind: 'локально', name: /^(ollama|ollama app|ollama_llama_server)\.exe$/i },
  { id: 'lmstudio', label: 'LM Studio', kind: 'локально', name: /^(lm studio|lms)\.exe$/i },
];

// Aggregate processes per tool: count, memory, cpu, oldest start.
function summarizeTools(list) {
  const out = new Map();
  for (const p of list) {
    const t = TOOLS.find(t => (t.name && t.name.test(p.name)) || (t.cmd && p.cmd && t.cmd.test(p.cmd)));
    if (!t) continue;
    const o = out.get(t.id) || { id: t.id, label: t.label, kind: t.kind, procs: 0, memMB: 0, cpu: 0, ageMin: 0, pids: [] };
    o.procs++; o.memMB += Math.round(p.memRss / 1024); o.cpu += p.cpu;
    const age = p.started ? (Date.now() - p.started) / 60000 : 0;
    if (age > o.ageMin) o.ageMin = Math.round(age);
    out.set(t.id, o);
  }
  return [...out.values()].map(o => ({ ...o, cpu: +o.cpu.toFixed(1) })).sort((a, b) => b.memMB - a.memMB);
}

// Codex CLI keeps sessions in ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl; the first record contains the cwd.
function codexSessions() {
  const base = path.join(os.homedir(), '.codex', 'sessions');
  const res = [];
  const cutoff = Date.now() - 48 * 3600e3;
  const walk = (dir, depth) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) { walk(p, depth + 1); continue; }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs < cutoff) continue;
        const fd = fs.openSync(p, 'r'); const buf = Buffer.alloc(16384);
        const n = fs.readSync(fd, buf, 0, 16384, 0); fs.closeSync(fd);
        const m = buf.toString('utf8', 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
        if (!m) continue;
        const cwd = JSON.parse('"' + m[1] + '"');
        res.push({ tool: 'Codex', cwd, births: [], name: path.basename(cwd), last: st.mtimeMs, active: Date.now() - st.mtimeMs < 5 * 60e3 });
      } catch {}
    }
  };
  walk(base, 0);
  // one entry per project: the newest session
  const byCwd = new Map();
  for (const s of res.sort((a, b) => b.last - a.last)) if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, s);
  return [...byCwd.values()];
}

async function getJson(url, ms = 700) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; }
}

// Models currently loaded by local runtimes. Both calls fail instantly if the runtime is not running.
async function localModels() {
  const [oll, lms] = await Promise.all([getJson('http://127.0.0.1:11434/api/ps'), getJson('http://127.0.0.1:1234/api/v0/models')]);
  const res = [];
  if (oll && Array.isArray(oll.models)) for (const m of oll.models) {
    const exp = m.expires_at ? Date.parse(m.expires_at) : 0;
    res.push({ runtime: 'ollama', model: m.name || m.model, sizeMB: Math.round((m.size || 0) / 2 ** 20), vramMB: Math.round((m.size_vram || 0) / 2 ** 20), expiresInMin: exp > Date.now() && exp - Date.now() < 3650 * 24 * 3600e3 ? Math.round((exp - Date.now()) / 60000) : null });
  }
  if (lms && Array.isArray(lms.data)) for (const m of lms.data) if (m.state === 'loaded') res.push({ runtime: 'lmstudio', model: m.id, sizeMB: 0, vramMB: 0, expiresInMin: null });
  return res;
}

async function unloadOllama(model) {
  try {
    const r = await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }), signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch { return false; }
}

module.exports = { summarizeTools, codexSessions, localModels, unloadOllama };
