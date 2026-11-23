// Internet speed test against Cloudflare's public speed-test endpoints (speed.cloudflare.com).
// Measures latency + jitter, download and upload. Traffic is capped (about 150 MB down, 60 MB up per run).
const crypto = require('crypto');

const BASE = 'https://speed.cloudflare.com';
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function latency(n = 8) {
  const t = [];
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    const r = await fetch(`${BASE}/__down?bytes=0&r=${Math.random()}`, { signal: AbortSignal.timeout(6000), cache: 'no-store' });
    await r.arrayBuffer();
    if (i > 0) t.push(performance.now() - s);   // the first request pays DNS + TLS, skip it
  }
  let j = 0; for (let i = 1; i < t.length; i++) j += Math.abs(t[i] - t[i - 1]);
  return { pingMs: Math.round(median(t)), jitterMs: Math.round(j / Math.max(1, t.length - 1)) };
}

async function download(onLive, { seconds = 8, conns = 4, capBytes = 150e6 } = {}) {
  const start = performance.now(), ctrl = new AbortController();
  let total = 0, mark = null, stop = false;
  const timer = setTimeout(() => ctrl.abort(), seconds * 1000);
  const worker = async () => {
    while (!stop && performance.now() - start < seconds * 1000) {
      try {
        const r = await fetch(`${BASE}/__down?bytes=25000000&r=${Math.random()}`, { signal: ctrl.signal, cache: 'no-store' });
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total >= capBytes) { stop = true; ctrl.abort(); break; }
        }
      } catch { break; }
    }
  };
  const iv = setInterval(() => {      // live value ignores the first second (TCP ramp-up)
    const t = (performance.now() - start) / 1000;
    if (t >= 1 && !mark) mark = { t, b: total };
    if (mark && t - mark.t > 0.3) onLive((total - mark.b) * 8 / 1e6 / (t - mark.t));
  }, 400);
  await Promise.all(Array.from({ length: conns }, worker));
  clearTimeout(timer); clearInterval(iv);
  const t = (performance.now() - start) / 1000;
  if (!total) throw new Error('no data');
  return mark && t - mark.t > 0.5 ? (total - mark.b) * 8 / 1e6 / (t - mark.t) : total * 8 / 1e6 / t;
}

async function upload(onLive, { seconds = 6, conns = 3, chunk = 2e6, capBytes = 60e6 } = {}) {
  const body = crypto.randomBytes(chunk), start = performance.now(), ctrl = new AbortController();
  let total = 0, last = start, stop = false;
  const timer = setTimeout(() => ctrl.abort(), (seconds + 6) * 1000);
  const worker = async () => {
    while (!stop && performance.now() - start < seconds * 1000) {
      try {
        const r = await fetch(`${BASE}/__up`, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' }, signal: ctrl.signal });
        await r.arrayBuffer();
        if (!r.ok) break;
        total += chunk; last = performance.now();
        if (total >= capBytes) stop = true;
        const t = (last - start) / 1000; if (t > 0.5) onLive(total * 8 / 1e6 / t);
      } catch { break; }
    }
  };
  await Promise.all(Array.from({ length: conns }, worker));
  clearTimeout(timer);
  if (!total) throw new Error('no data');
  return total * 8 / 1e6 / ((last - start) / 1000);
}

// onProgress({ phase: 'ping' | 'down' | 'up', live?: Mbit/s })
async function run(onProgress) {
  onProgress({ phase: 'ping' });
  const lat = await latency();                       // throws when offline -> caller reports the error
  onProgress({ phase: 'down', live: null, pingMs: lat.pingMs, jitterMs: lat.jitterMs });
  const down = await download(v => onProgress({ phase: 'down', live: v }));
  onProgress({ phase: 'up', live: null, down: +down.toFixed(1) });
  const up = await upload(v => onProgress({ phase: 'up', live: v })).catch(() => null);
  return { at: Date.now(), ...lat, down: +down.toFixed(1), up: up == null ? null : +up.toFixed(1), server: 'Cloudflare' };
}

module.exports = { run };
