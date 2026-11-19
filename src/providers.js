// Organization-level spend from the Anthropic and OpenAI usage/cost APIs.
// Keys are entered in the app, encrypted with Windows DPAPI (Electron safeStorage) and never leave the main process:
// the renderer only learns whether a key is set and its last 4 characters.
const { safeStorage } = require('electron');
const fs = require('fs'), path = require('path');

let keyFile = null;
const keys = {};            // decrypted keys, main process memory only
const state = {};           // provider -> last result
const lastTry = {};

const NAMES = { anthropic: 'Anthropic', openai: 'OpenAI' };
const VALID = {
  anthropic: k => /^sk-ant-admin[A-Za-z0-9_-]{10,}$/.test(k),
  openai: k => /^sk-[A-Za-z0-9_-]{20,}$/.test(k),
};
const WRONG_KEY = {
  anthropic: 'Нужен Admin-ключ организации (начинается с sk-ant-admin). Обычный API-ключ не подходит.',
  openai: 'Нужен Admin-ключ организации (создаётся в настройках организации OpenAI, начинается с sk-admin- или sk-).',
};

function init(dir) {
  keyFile = path.join(dir, 'api-keys.json');
  if (!safeStorage.isEncryptionAvailable()) return;
  try {
    const j = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    for (const p of Object.keys(NAMES)) if (j[p]) { try { keys[p] = safeStorage.decryptString(Buffer.from(j[p], 'base64')); } catch {} }
  } catch {}
}
function persist() {
  const out = {};
  for (const p of Object.keys(keys)) out[p] = safeStorage.encryptString(keys[p]).toString('base64');
  fs.writeFileSync(keyFile, JSON.stringify(out));
}
function setKey(provider, key) {
  if (!NAMES[provider]) return { ok: false, msg: 'Неизвестный сервис' };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, msg: 'Шифрование Windows недоступно — ключ не сохранён' };
  key = String(key || '').trim();
  if (!VALID[provider](key)) return { ok: false, msg: WRONG_KEY[provider] };
  keys[provider] = key; persist(); delete state[provider]; lastTry[provider] = 0;
  return { ok: true, msg: 'Ключ сохранён (зашифрован средствами Windows)' };
}
function clearKey(provider) {
  if (!NAMES[provider]) return { ok: false };
  delete keys[provider]; delete state[provider]; persist();
  return { ok: true, msg: 'Ключ удалён' };
}
const status = () => Object.fromEntries(Object.keys(NAMES).map(p => [p, { name: NAMES[p], configured: !!keys[p], hint: keys[p] ? '…' + keys[p].slice(-4) : null }]));

async function getJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  return r.json();
}
const iso = d => new Date(d).toISOString().replace(/\.\d+Z$/, 'Z');
const monthStartUTC = () => { const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1); };

// ---------- Anthropic: /v1/organizations/analytics/{cost,usage} (cost amounts are decimal strings in cents) ----------
async function anthPages(endpoint, params) {
  const headers = { 'x-api-key': keys.anthropic, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'analytics-usage-cost-2026-08-24' };
  const rows = []; let page = null, refreshed = null;
  for (let i = 0; i < 10; i++) {
    const q = new URLSearchParams(params); if (page) q.set('page', page);
    const r = await getJson('https://api.anthropic.com/v1/organizations/analytics/' + endpoint + '?' + q, headers);
    rows.push(...(r.data || [])); refreshed = r.data_refreshed_at || refreshed;
    if (!r.has_more || !r.next_page) break;
    page = r.next_page;
  }
  return { rows, refreshed };
}
async function fetchAnthropic() {
  const start = iso(monthStartUTC()), d7 = iso(Date.now() - 7 * 86400e3);
  const [cost, usage, cost7] = await Promise.all([
    anthPages('cost', { starting_at: start, 'group_by[]': 'model', limit: '1000' }),
    anthPages('usage', { starting_at: start, 'group_by[]': 'model', limit: '1000' }),
    anthPages('cost', { starting_at: d7, limit: '1000' }),
  ]);
  const usd = rows => rows.reduce((a, r) => a + (parseFloat(r.cost && r.cost.amount) || 0), 0) / 100;
  const models = new Map();
  const m = name => { const k = name || 'прочее'; if (!models.has(k)) models.set(k, { model: k, cost: 0, in: 0, out: 0, cache: 0, reqs: 0 }); return models.get(k); };
  for (const r of cost.rows) m(r.group && r.group.model).cost += (parseFloat(r.cost && r.cost.amount) || 0) / 100;
  const tot = { in: 0, out: 0, cache: 0, reqs: 0 };
  for (const r of usage.rows) {
    const u = r.usage || {}, cc = u.cache_creation || {};
    const inp = (u.uncached_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0) + (cc.ephemeral_5m_input_tokens || 0);
    const o = m(r.group && r.group.model);
    o.in += inp; o.out += u.output_tokens || 0; o.cache += u.cache_read_input_tokens || 0; o.reqs += u.requests || 0;
    tot.in += inp; tot.out += u.output_tokens || 0; tot.cache += u.cache_read_input_tokens || 0; tot.reqs += u.requests || 0;
  }
  return { month: { cost: +usd(cost.rows).toFixed(2), ...tot }, d7: { cost: +usd(cost7.rows).toFixed(2) }, models: [...models.values()].sort((a, b) => b.cost - a.cost).slice(0, 5), dataAsOf: cost.refreshed || usage.refreshed };
}

// ---------- OpenAI: /v1/organization/{costs,usage/completions} (amounts in USD) ----------
async function oaiPages(endpoint, params) {
  const headers = { Authorization: 'Bearer ' + keys.openai };
  const buckets = []; let page = null;
  for (let i = 0; i < 10; i++) {
    const q = new URLSearchParams(params); if (page) q.set('page', page);
    const r = await getJson('https://api.openai.com/v1/organization/' + endpoint + '?' + q, headers);
    buckets.push(...(r.data || []));
    if (!r.has_more || !r.next_page) break;
    page = r.next_page;
  }
  return buckets;
}
async function fetchOpenAI() {
  const start = Math.floor(monthStartUTC() / 1000), now = Math.floor(Date.now() / 1000);
  const base = { start_time: String(start), bucket_width: '1d', limit: '31' };
  const costB = await oaiPages('costs', base);
  let useB;
  try { useB = await oaiPages('usage/completions', { ...base, 'group_by[]': 'model' }); }
  catch { useB = await oaiPages('usage/completions', base).catch(() => []); }   // token details are optional
  const sum = (bs, from) => bs.filter(b => b.start_time >= from).reduce((a, b) => a + (b.results || []).reduce((s, r) => s + (r.amount && r.amount.value || 0), 0), 0);
  const day0 = now - (now % 86400);
  const models = new Map(), tot = { in: 0, out: 0, cache: 0, reqs: 0 };
  for (const b of useB) for (const r of b.results || []) {
    const k = r.model || 'все модели'; const o = models.get(k) || { model: k, in: 0, out: 0, cache: 0, reqs: 0 };
    o.in += r.input_tokens || 0; o.out += r.output_tokens || 0; o.cache += r.input_cached_tokens || 0; o.reqs += r.num_model_requests || 0; models.set(k, o);
    tot.in += r.input_tokens || 0; tot.out += r.output_tokens || 0; tot.cache += r.input_cached_tokens || 0; tot.reqs += r.num_model_requests || 0;
  }
  return { month: { cost: +sum(costB, 0).toFixed(2), ...tot }, d7: { cost: +sum(costB, now - 7 * 86400).toFixed(2) }, today: { cost: +sum(costB, day0).toFixed(2) }, models: [...models.values()].sort((a, b) => (b.in + b.out) - (a.in + a.out)).slice(0, 5), dataAsOf: null };
}

function explain(provider, e) {
  if (e.status === 401 || e.status === 403) return 'Ключ отклонён (' + e.status + '). ' + WRONG_KEY[provider];
  if (e.status === 404) return 'Сервис ответил 404 — у организации может не быть доступа к API расходов.';
  if (e.status === 429) return 'Слишком много запросов (429), повторю позже.';
  return 'Не удалось получить данные: ' + (e.message || 'ошибка сети');
}

// Refresh providers that have a key. `force` ignores the minimum interval.
async function refresh(force) {
  const jobs = [];
  for (const p of Object.keys(keys)) {
    if (!force && Date.now() - (lastTry[p] || 0) < 120000) continue;
    lastTry[p] = Date.now();
    jobs.push((async () => {
      try { state[p] = { ok: true, at: Date.now(), ...(await (p === 'anthropic' ? fetchAnthropic() : fetchOpenAI())) }; }
      catch (e) { state[p] = { ...(state[p] && state[p].ok ? state[p] : {}), ok: false, error: explain(p, e), failedAt: Date.now() }; }
    })());
  }
  await Promise.all(jobs);
}
const summary = () => JSON.parse(JSON.stringify(state));

module.exports = { init, setKey, clearKey, status, refresh, summary };
