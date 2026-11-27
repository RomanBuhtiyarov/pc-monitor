// Focus block: frogs of the day, daily habits (German by default), goals with subtasks, motivation.
// Local only: state lives in focus.json next to settings.json. All input is validated here (main process).
const fs = require('fs'), path = require('path');
const { WORDS, PHRASES, SENTENCES } = require('./focus-data');
const isPhraseHabit = h => /фраз|phrase|satz|sätze/i.test(h.t);   // such a habit button opens a German sentence

const EST = [15, 20, 25, 30, 40];   // pomodoro length choices for a frog, minutes
const LIM = { goals: 20, subs: 50, habits: 8, text: 120, keepDays: 60 };
const OPT_DEFAULTS = { enabled: true, frogs: true, lang: true, habits: true, goals: true, phrase: true, frogsMax: 2, remindHour: 14, notify: true, newPerDay: 5 };
const STEPS = [1, 3, 7, 14, 30];   // spaced repetition: days until the next review after the 1st..5th "know"
const MIGRATED_STEP = 3;           // words ticked before 0.12 continue from the 7-day interval
const opts = cfg => {
  const o = { ...OPT_DEFAULTS, ...((cfg && cfg.focus) || {}) };
  o.frogsMax = Math.max(1, Math.min(5, Math.round(+o.frogsMax) || 2));
  o.remindHour = Math.max(0, Math.min(23, Math.round(+o.remindHour) || 14));
  o.newPerDay = Math.max(1, Math.min(20, Math.round(+o.newPerDay) || 5));
  return o;
};

let file = null, db = null;
const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayNum = d => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const str = (s, n = LIM.text) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const minutes = v => Math.max(1, Math.min(240, Math.round(+v) || 15));
const fresh = () => ({ frogs: [], goals: [], habits: [{ id: 'de', t: 'Немецкий', min: 15, word: true, days: {} }], known: [], cards: null, intro: {}, lapses: 0, shift: { day: '', phrase: 0, sentence: 0, skip: [] }, notified: '', learned: {}, pomo: {}, timer: null });

function init(dir) {
  file = path.join(dir, 'focus.json'); db = fresh();
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const k of ['frogs', 'goals', 'habits', 'known']) if (Array.isArray(j[k])) db[k] = j[k];
    if (j.shift && typeof j.shift === 'object') db.shift = { ...db.shift, ...j.shift, skip: Array.isArray(j.shift.skip) ? j.shift.skip : [] };
    if (j.cards && typeof j.cards === 'object') db.cards = j.cards;
    if (j.intro && typeof j.intro === 'object') db.intro = j.intro;
    if (Number.isFinite(j.lapses)) db.lapses = j.lapses;
    if (typeof j.notified === 'string') db.notified = j.notified;
    for (const k of ['learned', 'pomo']) if (j[k] && typeof j[k] === 'object') db[k] = j[k];
    if (j.timer && Number.isFinite(j.timer.end)) db.timer = j.timer;
    for (const h of db.habits) if (!h.days || typeof h.days !== 'object') h.days = {};
  } catch {}
}
function save() { if (file) try { fs.writeFileSync(file, JSON.stringify(db, null, 1)); } catch {} }
const reset = () => { db = fresh(); };   // tests

const shiftFor = now => { const k = dayKey(now); if (db.shift.day !== k) db.shift = { day: k, phrase: 0, sentence: 0, skip: [] }; return db.shift; };
const streakOf = (h, now) => {
  let n = 0; const d = new Date(now);
  if (!h.days[dayKey(d)]) d.setDate(d.getDate() - 1);   // today not done yet: the streak is still alive until midnight
  while (h.days[dayKey(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
};
const weekOf = (h, now) => { const a = []; const d = new Date(now); d.setDate(d.getDate() - 6); for (let i = 0; i < 7; i++) { a.push(!!h.days[dayKey(d)]); d.setDate(d.getDate() + 1); } return a; };
const addDays = (now, n) => { const d = new Date(now); d.setDate(d.getDate() + n); return dayKey(d); };

// cards: word -> { step, due, again } (step = successful reviews so far; done = learned; again = order of "don't know")
function ensureCards(now) {
  if (db.cards) return;
  db.cards = {};
  db.known.forEach((w, i) => { db.cards[w] = { step: MIGRATED_STEP, due: addDays(now, Math.floor(i / 5)) }; });   // 5 a day, not all at once
  if (db.known.length) save();
}

// Today's queue: reviews that are due, then new words (daily limit), then today's "don't know" ones;
// skipped words go to the end. -> { word | null, isNew, due: reviews waiting, newLeft }
function wordQueue(o, now) {
  ensureCards(now);
  const key = dayKey(now), skip = shiftFor(now).skip;
  const mine = WORDS.filter(w => { const c = db.cards[w]; return c && !c.done && c.due <= key; });
  const today = w => !!db.cards[w].again && db.cards[w].due === key;   // "don't know" from an earlier day is an ordinary review
  const due = mine.filter(w => !today(w)).sort((a, b) => db.cards[a].due.localeCompare(db.cards[b].due));
  const again = mine.filter(today).sort((a, b) => db.cards[a].again - db.cards[b].again);
  const unseen = WORDS.filter(w => !db.cards[w]);
  const newLeft = Math.max(0, Math.min(unseen.length, o.newPerDay - (db.intro[key] || 0)));
  const all = [...due, ...(newLeft ? unseen : []), ...again];
  const q = all.filter(w => !skip.includes(w)).concat(skip.filter(w => all.includes(w)));
  const word = q[0] || null;
  return { word, isNew: !!word && !db.cards[word], due: mine.length, newLeft };
}

function grade(know, p, o, now) {
  const q = wordQueue(o, now), w = q.word, key = dayKey(now);
  if (!w || (p.id && p.id !== w.split('|')[0])) return;   // a second click on a card that is already graded
  if (!db.cards[w]) db.intro[key] = (db.intro[key] || 0) + 1;
  const c = db.cards[w] || { step: 0, due: key };
  if (!know) db.cards[w] = { step: 0, due: key, again: ++db.lapses };
  else if (c.step >= STEPS.length) { db.cards[w] = { step: c.step, due: c.due, done: key }; db.learned[key] = (db.learned[key] || 0) + 1; }
  else db.cards[w] = { step: c.step + 1, due: addDays(now, STEPS[c.step]) };
  const sh = shiftFor(now); sh.skip = sh.skip.filter(x => x !== w);
}

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
  const habits = db.habits.map(h => ({ id: h.id, t: h.t, min: h.min, word: !!h.word, phrases: isPhraseHabit(h), doneToday: !!h.days[key], streak: streakOf(h, now), total: Object.keys(h.days).length, week: weekOf(h, now) }));
  const active = new Set(frogs.filter(f => !f.done).map(f => f.subId).filter(Boolean));
  const goals = db.goals.map(g => {
    const done = g.subs.filter(s => s.done).length, nx = g.subs.find(s => !s.done);
    return { id: g.id, t: g.t, subs: g.subs.map(s => ({ id: s.id, t: s.t, done: !!s.done, frog: active.has(s.id) })), done, total: g.subs.length, pct: g.subs.length ? Math.round(done / g.subs.length * 100) : 0, next: nx ? nx.id : null };
  });
  const wq = wordQueue(o, now), raw = wq.word && wq.word.split('|');
  const ph = PHRASES[(dayNum(now) + shiftFor(now).phrase) % PHRASES.length].split('|');
  const sn = SENTENCES[(dayNum(now) + (shiftFor(now).sentence || 0)) % SENTENCES.length].split('|');
  const rec = recommend({ frogs, carry, habits, goals }, o, now.getHours());
  return {
    opts: o, enabled: o.enabled, day: key,
    frogs: frogs.map(f => ({ id: f.id, t: f.t, done: !!f.done, est: f.est || 25, pomo: f.pomo || 0 })),
    timer: db.timer, pomoToday: db.pomo[key] || 0,
    learned: { day: db.learned[key] || 0, month: Object.entries(db.learned).reduce((a, [k, n]) => a + (k.startsWith(key.slice(0, 7)) ? n : 0), 0) }, carry: carry.map(f => ({ id: f.id, t: f.t })),
    frogsWeek: db.frogs.filter(f => f.done && f.doneDay >= dayKey(weekAgo)).length,
    habits, goals, word: raw ? { de: raw[0], ru: raw[1], isNew: wq.isNew } : null, words: { due: wq.due, newLeft: wq.newLeft }, phrase: { de: ph[0], ru: ph[1] }, sentence: { de: sn[0], ru: sn[1] }, rec,
  };
}

// Returns a reminder text at most once a day (only when something is urgent), or null.
function reminder(cfg, now = new Date()) {
  const o = opts(cfg); if (!db || !o.enabled || !o.notify || db.notified === dayKey(now)) return null;
  const s = summary(cfg, now); if (!s.rec.urgent) return null;
  db.notified = dayKey(now); save(); return s.rec.text;
}

// Pomodoro finished? Returns a notification text (once), or null. A timer that ran out long ago (PC asleep, app closed) is dropped.
function tick(now = new Date()) {
  const tm = db && db.timer; if (!tm || now.getTime() < tm.end) return null;
  db.timer = null; let msg = null;
  const f = db.frogs.find(x => x.id === tm.id);
  if (f && now.getTime() - tm.end < 10 * 60e3) {
    const key = dayKey(now); db.pomo[key] = (db.pomo[key] || 0) + 1; f.pomo = (f.pomo || 0) + 1;
    msg = `Помидор ${tm.min} мин готов: «${f.t}». Сделай перерыв 5 минут. Если лягушка съедена — отметь ✓.`;
  }
  save(); return msg;
}
const stopTimer = id => { if (db.timer && db.timer.id === id) db.timer = null; };

const NO = msg => ({ ok: false, msg });
const OK = { ok: true };
const goalOf = id => db.goals.find(g => g.id === id);
function frogAdd(t, o, now, link, est) {
  t = str(t); if (!t) return NO('Пустая задача');
  const key = dayKey(now);
  if (db.frogs.filter(f => f.day === key).length >= o.frogsMax) return NO(`Лимит: ${o.frogsMax} на день. Убери одну или увеличь лимит в настройках.`);
  db.frogs.push({ id: uid(), t, day: key, done: false, est: EST.includes(+est) ? +est : 25, ...(link || {}) });
  return OK;
}
function act(type, p, cfg, now = new Date()) {
  if (!db) return NO('Фокус не инициализирован'); p = p || {};
  const o = opts(cfg), key = dayKey(now);
  let r = OK;
  switch (type) {
    case 'frogAdd': r = frogAdd(p.t, o, now, null, p.est); break;
    case 'frogEst': { const f = db.frogs.find(x => x.id === p.id); if (!f) return NO('Не найдено'); f.est = EST[(EST.indexOf(f.est || 25) + 1) % EST.length]; break; }
    case 'frogStart': {
      const f = db.frogs.find(x => x.id === p.id && x.day === key && !x.done); if (!f) return NO('Не найдено');
      if (db.timer && db.timer.end > now.getTime()) return NO('Помидор уже идёт — дождись конца или останови его');
      const min = f.est || 25; db.timer = { id: f.id, min, end: now.getTime() + min * 60e3 }; break;
    }
    case 'frogStop': db.timer = null; break;
    case 'frogToggle': {
      const f = db.frogs.find(x => x.id === p.id); if (!f) return NO('Не найдено');
      f.done = !f.done; if (f.done) stopTimer(f.id); if (f.done) f.doneDay = key; else delete f.doneDay;
      const g = f.goalId && goalOf(f.goalId), s = g && g.subs.find(x => x.id === f.subId); if (s) s.done = f.done;
      break;
    }
    case 'frogRemove': stopTimer(p.id); db.frogs = db.frogs.filter(x => x.id !== p.id); break;
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
    case 'wordKnown': grade(true, p, o, now); break;
    case 'wordAgain': grade(false, p, o, now); break;
    case 'wordNext': { const w = wordQueue(o, now).word; if (w) { const sh = shiftFor(now); sh.skip = sh.skip.filter(x => x !== w).concat(w); } break; }
    case 'sentenceNext': { const sh = shiftFor(now); sh.sentence = (sh.sentence || 0) + 1; break; }
    case 'phraseNext': shiftFor(now).phrase++; break;
    default: return NO('Неизвестное действие');
  }
  const cut = dayKey(new Date(now.getTime() - LIM.keepDays * 864e5));
  db.frogs = db.frogs.filter(f => !f.done || (f.doneDay || f.day) >= cut);
  save(); return r;
}

module.exports = { init, summary, act, tick, reminder, recommend, opts, OPT_DEFAULTS, STEPS, reset, _db: () => db };
