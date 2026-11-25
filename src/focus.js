// Focus block: frogs of the day, daily habits (German by default), goals with subtasks, motivation.
// Local only: state lives in focus.json next to settings.json. All input is validated here (main process).
const fs = require('fs'), path = require('path');
const { WORDS, PHRASES } = require('./focus-data');

const LIM = { goals: 20, subs: 50, habits: 8, text: 120, keepDays: 60 };
const OPT_DEFAULTS = { enabled: true, frogs: true, habits: true, goals: true, phrase: true, frogsMax: 2, remindHour: 14, notify: true };
const opts = cfg => {
  const o = { ...OPT_DEFAULTS, ...((cfg && cfg.focus) || {}) };
  o.frogsMax = Math.max(1, Math.min(5, Math.round(+o.frogsMax) || 2));
  o.remindHour = Math.max(0, Math.min(23, Math.round(+o.remindHour) || 14));
  return o;
};

let file = null, db = null;
const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayNum = d => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const str = (s, n = LIM.text) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const minutes = v => Math.max(1, Math.min(240, Math.round(+v) || 15));
const fresh = () => ({ frogs: [], goals: [], habits: [{ id: 'de', t: 'Немецкий', min: 15, word: true, days: {} }], known: [], shift: { day: '', word: 0, phrase: 0 }, notified: '' });

function init(dir) {
  file = path.join(dir, 'focus.json'); db = fresh();
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const k of ['frogs', 'goals', 'habits', 'known']) if (Array.isArray(j[k])) db[k] = j[k];
    if (j.shift && typeof j.shift === 'object') db.shift = { day: '', word: 0, phrase: 0, ...j.shift };
    if (typeof j.notified === 'string') db.notified = j.notified;
    for (const h of db.habits) if (!h.days || typeof h.days !== 'object') h.days = {};
  } catch {}
}
function save() { if (file) try { fs.writeFileSync(file, JSON.stringify(db, null, 1)); } catch {} }
const reset = () => { db = fresh(); };   // tests

const shiftFor = now => { const k = dayKey(now); if (db.shift.day !== k) db.shift = { day: k, word: 0, phrase: 0 }; return db.shift; };
const streakOf = (h, now) => {
  let n = 0; const d = new Date(now);
  if (!h.days[dayKey(d)]) d.setDate(d.getDate() - 1);   // today not done yet: the streak is still alive until midnight
  while (h.days[dayKey(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
};
const weekOf = (h, now) => { const a = []; const d = new Date(now); d.setDate(d.getDate() - 6); for (let i = 0; i < 7; i++) { a.push(!!h.days[dayKey(d)]); d.setDate(d.getDate() + 1); } return a; };
const wordsLeft = () => { const k = new Set(db.known); const l = WORDS.filter(w => !k.has(w)); return l.length ? l : WORDS; };
const wordRaw = now => { const c = wordsLeft(); return c[(dayNum(now) + shiftFor(now).word) % c.length]; };

// Pure: one most important direct recommendation. st = { frogs, carry, habits, goals }, o = options, hour = 0..23
function recommend(st, o, hour) {
  const late = hour >= o.remindHour;
  if (o.frogs) {
    if (st.carry.length) return { text: `Вчерашняя лягушка «${st.carry[0].t}» не съедена. Перенеси на сегодня или убери.`, urgent: late };
    const open = st.frogs.filter(f => !f.done);
    if (!st.frogs.length) return { text: `Лягушки на сегодня не выбраны. Выбери 1–${o.frogsMax} самые неприятные задачи.`, urgent: late };
    if (open.length && late) return { text: `Уже ${hour}:00, а лягушка «${open[0].t}» не съедена. Сделай её сейчас: 25 минут без отвлечений.`, urgent: true };
    if (open.length) return { text: `Начни с лягушки «${open[0].t}» — до почты и чатов.`, urgent: false };
  }
  if (o.habits) {
    const h = st.habits.find(x => !x.doneToday);
    if (h) return { text: `${h.t} сегодня не отмечен. Хватит ${h.min} минут${h.streak ? ` — не прерывай серию из ${h.streak} дн.` : '.'}`, urgent: hour >= 18 };
  }
  if (o.goals) {
    const g = st.goals.find(x => x.total === 0);
    if (g) return { text: `У цели «${g.t}» нет шагов. Разбей её на подзадачи — первая должна быть смешно простой.`, urgent: false };
    const n = st.goals.find(x => x.next);
    if (n && !st.frogs.length) return { text: `Следующий шаг по цели «${n.t}»: ${n.subs.find(s => s.id === n.next).t}.`, urgent: false };
  }
  const best = st.habits.reduce((m, h) => Math.max(m, h.streak), 0);
  return { text: best > 1 ? `Главное на сегодня сделано. Серия ${best} дн. — так держать.` : 'Главное на сегодня сделано. Можно отдохнуть.', urgent: false };
}

function summary(cfg, now = new Date()) {
  const o = opts(cfg); if (!db) return { opts: o, enabled: false };
  const key = dayKey(now), weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 6);
  const frogs = db.frogs.filter(f => f.day === key);
  const carry = db.frogs.filter(f => f.day < key && !f.done);
  const habits = db.habits.map(h => ({ id: h.id, t: h.t, min: h.min, word: !!h.word, doneToday: !!h.days[key], streak: streakOf(h, now), total: Object.keys(h.days).length, week: weekOf(h, now) }));
  const active = new Set(frogs.filter(f => !f.done).map(f => f.subId).filter(Boolean));
  const goals = db.goals.map(g => {
    const done = g.subs.filter(s => s.done).length, nx = g.subs.find(s => !s.done);
    return { id: g.id, t: g.t, subs: g.subs.map(s => ({ id: s.id, t: s.t, done: !!s.done, frog: active.has(s.id) })), done, total: g.subs.length, pct: g.subs.length ? Math.round(done / g.subs.length * 100) : 0, next: nx ? nx.id : null };
  });
  const raw = wordRaw(now).split('|');
  const rec = recommend({ frogs, carry, habits, goals }, o, now.getHours());
  return {
    opts: o, enabled: o.enabled, day: key,
    frogs: frogs.map(f => ({ id: f.id, t: f.t, done: !!f.done })), carry: carry.map(f => ({ id: f.id, t: f.t })),
    frogsWeek: db.frogs.filter(f => f.done && f.doneDay >= dayKey(weekAgo)).length,
    habits, goals, word: { de: raw[0], ru: raw[1] }, phrase: PHRASES[(dayNum(now) + shiftFor(now).phrase) % PHRASES.length], rec,
  };
}

// Returns a reminder text at most once a day (only when something is urgent), or null.
function reminder(cfg, now = new Date()) {
  const o = opts(cfg); if (!db || !o.enabled || !o.notify || db.notified === dayKey(now)) return null;
  const s = summary(cfg, now); if (!s.rec.urgent) return null;
  db.notified = dayKey(now); save(); return s.rec.text;
}

const NO = msg => ({ ok: false, msg });
const OK = { ok: true };
const goalOf = id => db.goals.find(g => g.id === id);
function frogAdd(t, o, now, link) {
  t = str(t); if (!t) return NO('Пустая задача');
  const key = dayKey(now);
  if (db.frogs.filter(f => f.day === key).length >= o.frogsMax) return NO(`Лимит: ${o.frogsMax} на день. Убери одну или увеличь лимит в настройках.`);
  db.frogs.push({ id: uid(), t, day: key, done: false, ...(link || {}) });
  return OK;
}
function act(type, p, cfg, now = new Date()) {
  if (!db) return NO('Фокус не инициализирован'); p = p || {};
  const o = opts(cfg), key = dayKey(now);
  let r = OK;
  switch (type) {
    case 'frogAdd': r = frogAdd(p.t, o, now); break;
    case 'frogToggle': {
      const f = db.frogs.find(x => x.id === p.id); if (!f) return NO('Не найдено');
      f.done = !f.done; if (f.done) f.doneDay = key; else delete f.doneDay;
      const g = f.goalId && goalOf(f.goalId), s = g && g.subs.find(x => x.id === f.subId); if (s) s.done = f.done;
      break;
    }
    case 'frogRemove': db.frogs = db.frogs.filter(x => x.id !== p.id); break;
    case 'frogCarry': {
      const f = db.frogs.find(x => x.id === p.id && x.day < key && !x.done); if (!f) return NO('Не найдено');
      if (db.frogs.filter(x => x.day === key).length >= o.frogsMax) return NO(`Лимит: ${o.frogsMax} на день`);
      f.day = key; break;
    }
    case 'goalAdd': {
      const t = str(p.t); if (!t) return NO('Пустое название'); if (db.goals.length >= LIM.goals) return NO('Слишком много целей');
      db.goals.push({ id: uid(), t, subs: [] }); break;
    }
    case 'goalRemove': db.goals = db.goals.filter(g => g.id !== p.id); break;
    case 'subAdd': {
      const g = goalOf(p.goalId), t = str(p.t); if (!g) return NO('Цель не найдена'); if (!t) return NO('Пустая подзадача'); if (g.subs.length >= LIM.subs) return NO('Слишком много подзадач');
      g.subs.push({ id: uid(), t, done: false }); break;
    }
    case 'subToggle': { const g = goalOf(p.goalId), s = g && g.subs.find(x => x.id === p.id); if (!s) return NO('Не найдено'); s.done = !s.done; break; }
    case 'subRemove': { const g = goalOf(p.goalId); if (!g) return NO('Не найдено'); g.subs = g.subs.filter(x => x.id !== p.id); break; }
    case 'subMove': {
      const g = goalOf(p.goalId), i = g ? g.subs.findIndex(x => x.id === p.id) : -1, j = i + (p.dir < 0 ? -1 : 1);
      if (i < 0 || j < 0 || j >= g.subs.length) return NO('Некуда двигать');
      [g.subs[i], g.subs[j]] = [g.subs[j], g.subs[i]]; break;
    }
    case 'subToFrog': {
      const g = goalOf(p.goalId), s = g && g.subs.find(x => x.id === p.id); if (!s) return NO('Не найдено');
      if (db.frogs.some(f => f.day === key && f.subId === s.id)) return NO('Уже в лягушках на сегодня');
      r = frogAdd(`${s.t} — ${g.t}`, o, now, { goalId: g.id, subId: s.id }); break;
    }
    case 'edit': {   // rename a frog / goal / subtask / habit (habit: also minutes per day)
      const t = str(p.t, p.kind === 'habit' ? 40 : LIM.text); if (!t) return NO('Пустой текст');
      const g = goalOf(p.goalId);
      const x = p.kind === 'frog' ? db.frogs.find(v => v.id === p.id) : p.kind === 'goal' ? goalOf(p.id) : p.kind === 'sub' ? g && g.subs.find(v => v.id === p.id) : p.kind === 'habit' ? db.habits.find(v => v.id === p.id) : null;
      if (!x) return NO('Не найдено');
      x.t = t; if (p.kind === 'habit' && p.min != null) x.min = minutes(p.min);
      break;
    }
    case 'habitAdd': {
      const t = str(p.t, 40); if (!t) return NO('Пустое название'); if (db.habits.length >= LIM.habits) return NO('Слишком много привычек');
      db.habits.push({ id: uid(), t, min: minutes(p.min), days: {} }); break;
    }
    case 'habitRemove': db.habits = db.habits.filter(h => h.id !== p.id); break;
    case 'habitToggle': { const h = db.habits.find(x => x.id === p.id); if (!h) return NO('Не найдено'); if (h.days[key]) delete h.days[key]; else h.days[key] = true; break; }
    case 'wordKnown': { const w = wordRaw(now); if (!db.known.includes(w)) db.known.push(w); break; }
    case 'wordNext': shiftFor(now).word++; break;
    case 'phraseNext': shiftFor(now).phrase++; break;
    default: return NO('Неизвестное действие');
  }
  const cut = dayKey(new Date(now.getTime() - LIM.keepDays * 864e5));
  db.frogs = db.frogs.filter(f => !f.done || (f.doneDay || f.day) >= cut);
  save(); return r;
}

module.exports = { init, summary, act, reminder, recommend, opts, OPT_DEFAULTS, reset, _db: () => db };
