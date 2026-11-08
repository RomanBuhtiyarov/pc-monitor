// Process scan: categorize, group by project, flag suspicious ones. Kept lightweight on purpose.
const { execFile } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');

const BROWSER = /^(chrome|msedge|firefox|brave|opera|vivaldi)\.exe$/i;
const IDE = /^(code|cursor|windsurf|idea64|pycharm64|webstorm64|rider64|devenv|studio64|zed)\.exe$/i;
const LLM = /^(claude|codex|gemini|aider|ollama|opencode|ollama app|codebase-memory-mcp)(\.exe)?$/i;
const DEV = /^(node|python|pythonw|java|javaw|dotnet|deno|bun|go|cargo|rustc|electron|npm|npx|tsc|vite|esbuild|uvicorn|gradle|adb|msbuild|vbcscompiler|docker|wsl|wslhost)\.exe$/i;
const TERM = /^(cmd|powershell|pwsh|bash|conhost|windowsterminal|wt|openconsole)\.exe$/i;
const CMD_NAMES = ['node.exe', 'python.exe', 'pythonw.exe', 'java.exe', 'dotnet.exe', 'deno.exe', 'bun.exe', 'electron.exe', 'claude.exe', 'codex.exe'];

const prevCpu = new Map(); // pid -> {t, at}
let lastAt = 0;
const CORES = os.cpus().length;

function run(cmd, args, timeout = 12000) {
  return new Promise(res => execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 32e6, encoding: 'utf8' }, (e, out) => res(e ? '' : out)));
}

// One CIM call gives pid, parent, name, command line, memory, CPU time and start time for every process.
async function listProcesses() {
  const ps = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,@{n='T';e={[int64]($_.KernelModeTime+$_.UserModeTime)}},@{n='S';e={[DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress";
  const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  let arr = []; try { arr = JSON.parse(out || '[]'); } catch {}
  const now = Date.now(), dt = (now - lastAt) * 1e4 * CORES; // 100ns units across all cores
  const list = arr.map(r => {
    const prev = prevCpu.get(r.ProcessId);
    const cpu = prev && lastAt && dt > 0 ? Math.max(0, Math.min(100, (r.T - prev) / dt * 100)) : 0;
    return { pid: r.ProcessId, parentPid: r.ParentProcessId, name: r.Name || '', cmd: r.CommandLine || '', memRss: (r.WorkingSetSize || 0) / 1024, started: r.S, cpu, T: r.T };
  });
  prevCpu.clear(); for (const p of list) prevCpu.set(p.pid, p.T); lastAt = now;
  return list;
}

async function notResponding() {
  const out = await run('tasklist', ['/fi', 'STATUS eq NOT RESPONDING', '/fo', 'csv', '/nh']);
  const set = new Set();
  for (const line of out.split(/\r?\n/)) { const m = line.match(/^"[^"]*","(\d+)"/); if (m) set.add(+m[1]); }
  return set;
}

// ---- Claude Code sessions (reads only the tail of the newest log per project) ----
function claudeSessions() {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const res = [];
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch { return res; }
  for (const d of dirs) {
    try {
      const dir = path.join(base, d);
      let newest = null; const births = [];
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const st = fs.statSync(path.join(dir, f));
        births.push(st.birthtimeMs);
        if (!newest || st.mtimeMs > newest.m) newest = { f, m: st.mtimeMs, size: st.size };
      }
      if (!newest || Date.now() - newest.m > 48 * 3600e3) continue;
      const fd = fs.openSync(path.join(dir, newest.f), 'r');
      const len = Math.min(newest.size, 16384), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, newest.size - len); fs.closeSync(fd);
      const m = buf.toString('utf8').match(/"cwd":"(?:[^"\\]|\\.)*"/g);
      let cwd = m ? JSON.parse('{' + m[m.length - 1] + '}').cwd : null;
      if (!cwd) continue;
      res.push({ cwd, births, name: path.basename(cwd), last: newest.m, active: Date.now() - newest.m < 5 * 60e3 });
    } catch {}
  }
  return res.sort((a, b) => b.last - a.last).slice(0, 12);
}

function category(name, cmd) {
  if (BROWSER.test(name)) return 'browser';
  if (LLM.test(name) || /(@anthropic-ai|claude-code|codex|gemini-cli|@google[\\/]gemini|aider|\bmcp\b|-mcp)/i.test(cmd)) return 'llm';
  if (IDE.test(name)) return 'ide';
  if (DEV.test(name)) return 'dev';
  if (TERM.test(name)) return 'term';
  return 'other';
}

function projectOf(cmd, roots, sessions) {
  const BS = String.fromCharCode(92);
  const low = cmd.toLowerCase().split('/').join(BS);
  for (const s of sessions) if (low.includes(s.cwd.toLowerCase().split('/').join(BS))) return { key: s.cwd, name: s.name };
  for (const r of roots) {
    let rl = r.toLowerCase().split('/').join(BS);
    if (rl.endsWith(BS)) rl = rl.slice(0, -1);
    const i = low.indexOf(rl + BS);
    if (i >= 0) {
      const seg = cmd.slice(i + rl.length + 1).split(/[\\/"' ]/)[0];
      if (seg) return { key: r.split('/').join(BS).replace(/\\+$/, '') + BS + seg, name: seg };
    }
  }
  return null;
}

const cpuStreak = new Map();

async function scan(cfg) {
  const [list, nr] = await Promise.all([listProcesses(), notResponding()]);
  const pids = new Set(list.map(p => p.pid));
  const sessions = claudeSessions();
  const roots = cfg.projectRoots || [];

  const procs = [], byPid = new Map(), seen = new Set();
  for (const p of list) {
    const cat = category(p.name, p.cmd);
    const memMB = p.memRss / 1024;
    if (cat === 'other' && memMB < 300) continue;
    if (cat === 'term' && memMB < 30) continue;
    const ageMin = p.started ? (Date.now() - p.started) / 60000 : 0;
    const flags = [];
    if (nr.has(p.pid)) flags.push('не отвечает');
    if (cat === 'dev' || cat === 'llm') {
      if (!pids.has(p.parentPid) && ageMin > 30 && p.cpu < 1 && memMB > 150) flags.push('осиротевший?');
      if (p.cpu < 0.5 && memMB > 1000 && ageMin > 120) flags.push('простаивает, но держит память');
    }
    seen.add(p.pid);
    if (p.cpu > 80) { const n = (cpuStreak.get(p.pid) || 0) + 1; cpuStreak.set(p.pid, n); if (n >= 3) flags.push('держит CPU'); } else cpuStreak.delete(p.pid);
    const proj = p.cmd ? projectOf(p.cmd, roots, sessions) : null;
    const o = { pid: p.pid, ppid: p.parentPid, name: p.name, cat, memMB: Math.round(memMB), cpu: +p.cpu.toFixed(1), ageMin: Math.round(ageMin), flags, project: proj && proj.name, projectKey: proj && proj.key, cmd: p.cmd.slice(0, 200) };
    procs.push(o); byPid.set(o.pid, o);
  }
  for (const k of cpuStreak.keys()) if (!seen.has(k)) cpuStreak.delete(k);
  // claude.exe has no cwd in its command line: match its start time to a session log creation time
  for (const p of procs) {
    if (p.projectKey || !/^claude(\.exe)?$/i.test(p.name)) continue;
    const st = Date.now() - p.ageMin * 60000;
    const hit = sessions.find(x => x.births.some(b => Math.abs(b - st) < 90e3));
    if (hit) { p.project = hit.name; p.projectKey = hit.cwd; }
  }
  // project inheritance through the process tree: children -> parents, then parents -> children
  for (let pass = 0; pass < 3; pass++) {
    for (const p of procs) { const par = byPid.get(p.ppid); if (p.projectKey && par && !par.projectKey && par.cat !== 'term') { par.project = p.project; par.projectKey = p.projectKey; } }
    for (const p of procs) { const par = byPid.get(p.ppid); if (par && par.projectKey && !p.projectKey) { p.project = par.project; p.projectKey = par.projectKey; } }
  }

  // group
  const groups = new Map();
  const browsers = {};
  for (const p of procs) {
    if (p.cat === 'browser') { const b = browsers[p.name] || (browsers[p.name] = { name: p.name, count: 0, memMB: 0, cpu: 0 }); b.count++; b.memMB += p.memMB; b.cpu += p.cpu; continue; }
    const key = p.projectKey || '~' + (p.cat === 'ide' ? 'IDE' : p.cat === 'llm' ? 'LLM-инструменты (проект не определён)' : p.cat === 'dev' ? 'Dev-процессы (проект не определён)' : 'Прочее');
    const g = groups.get(key) || { key, name: p.project || key.slice(1), memMB: 0, cpu: 0, procs: [] };
    g.memMB += p.memMB; g.cpu += p.cpu; g.procs.push(p); groups.set(key, g);
  }
  const gl = [...groups.values()].sort((a, b) => b.memMB - a.memMB);
  gl.forEach(g => { g.procs.sort((a, b) => b.memMB - a.memMB); g.cpu = +g.cpu.toFixed(1); });
  const suspects = procs.filter(p => p.flags.length).sort((a, b) => b.memMB - a.memMB);
  const top = procs.slice().sort((a, b) => b.memMB - a.memMB)[0] || null;
  return { groups: gl, suspects, sessions, browsers: Object.values(browsers), top, at: Date.now() };
}

module.exports = { scan };
