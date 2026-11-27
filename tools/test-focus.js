// Logic test for src/focus.js: node tools/test-focus.js (uses a temp dir, never touches real data)
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const focus = require('../src/focus');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-focus-'));
focus.init(dir);
const cfg = {};
const at = (d, h = 10) => new Date(2026, 0, d, h, 0, 0);
const act = (t, p, d = 5, h = 10) => focus.act(t, p, cfg, at(d, h));
const sum = (d = 5, h = 10) => focus.summary(cfg, at(d, h));

// frogs: limit 2 by default, configurable up to 5
assert(act('frogAdd', { t: 'A' }).ok && act('frogAdd', { t: 'B' }).ok);
assert(!act('frogAdd', { t: 'C' }).ok, 'third frog must be refused');
cfg.focus = { frogsMax: 3 }; assert(act('frogAdd', { t: 'C' }).ok); cfg.focus = { frogsMax: 1 };
assert(!act('frogAdd', { t: 'D' }).ok); cfg.focus = {};
assert(!act('frogAdd', { t: '   ' }).ok, 'empty text refused');
cfg.focus = { frogsMax: 3 };

// goals/subtasks, frog link, edit
assert(act('goalAdd', { t: 'Сдать A1' }).ok);
let g = sum().goals[0]; assert(act('subAdd', { goalId: g.id, t: 'Купить учебник' }).ok && act('subAdd', { goalId: g.id, t: 'Выучить 100 слов' }).ok);
g = sum().goals[0]; assert.strictEqual(g.total, 2); assert.strictEqual(g.next, g.subs[0].id);
act('frogRemove', { id: sum().frogs[2].id });   // free a slot
assert(act('subToFrog', { goalId: g.id, id: g.subs[0].id }).ok);
assert(!act('subToFrog', { goalId: g.id, id: g.subs[0].id }).ok, 'same subtask twice refused');
const fl = sum().frogs.find(f => f.t.startsWith('Купить'));
act('frogToggle', { id: fl.id }); assert(sum().goals[0].subs[0].done, 'done frog completes its subtask'); assert.strictEqual(sum().goals[0].pct, 50);
assert(act('edit', { kind: 'goal', id: g.id, t: 'Сдать A2' }).ok); assert.strictEqual(sum().goals[0].t, 'Сдать A2');
assert(act('edit', { kind: 'sub', goalId: g.id, id: g.subs[1].id, t: 'Выучить 200 слов' }).ok);
assert(act('edit', { kind: 'frog', id: sum().frogs[0].id, t: 'Новая A' }).ok);
assert(!act('edit', { kind: 'sub', goalId: g.id, id: 'nope', t: 'x' }).ok);
act('subMove', { goalId: g.id, id: g.subs[1].id, dir: -1 }); assert.strictEqual(sum().goals[0].subs[0].t, 'Выучить 200 слов');

// habits: streak, edit, add/remove
const de = sum().habits[0]; assert.strictEqual(de.t, 'Немецкий'); assert(de.word);
for (const d of [3, 4, 5]) act('habitToggle', { id: de.id }, d);
assert.strictEqual(sum(5).habits[0].streak, 3);
assert.strictEqual(sum(6).habits[0].streak, 3, 'streak survives until midnight of the missed day');
assert.strictEqual(sum(7).habits[0].streak, 0, 'streak breaks after a missed day');
act('habitToggle', { id: de.id }, 5); assert.strictEqual(sum(5).habits[0].streak, 2);
act('habitToggle', { id: de.id }, 5);
assert(act('edit', { kind: 'habit', id: de.id, t: 'Deutsch', min: 20 }).ok); assert.strictEqual(sum().habits[0].min, 20);
assert(act('habitAdd', { t: 'Английский', min: 10 }).ok && sum().habits.length === 2);
act('habitRemove', { id: sum().habits[1].id }); assert.strictEqual(sum().habits.length, 1);

// a «phrases» habit gets a German sentence that can be changed
act('habitAdd', { t: 'Немецкие фразы' }); assert(sum().habits[1].phrases && !sum().habits[0].phrases);
const s1 = sum().sentence.de; assert(sum().sentence.ru); act('sentenceNext', {}); assert.notStrictEqual(sum().sentence.de, s1);
act('habitRemove', { id: sum().habits[1].id });

// carry-over of unfinished frogs
const open = sum(5).frogs.find(f => !f.done);
const next = sum(6); assert(next.carry.some(c => c.id === open.id) && next.frogs.length === 0);
assert(act('frogCarry', { id: open.id }, 6).ok && sum(6).frogs.length === 1);

// phrases rotate; "skip" moves a word to the end of the queue without grading it
const p1 = sum().phrase.de; act('phraseNext', {}); assert.notStrictEqual(sum().phrase.de, p1); assert(sum().phrase.ru);
const w1 = sum().word.de; act('wordNext', {}); assert.notStrictEqual(sum().word.de, w1); assert.deepStrictEqual(sum().words, { due: 0, newLeft: 5 });

// pomodoro
const fp = sum(6).frogs[0]; assert.strictEqual(fp.est, 25);
act('frogEst', { id: fp.id }, 6); assert.strictEqual(sum(6).frogs[0].est, 30);
assert(act('frogStart', { id: fp.id }, 6).ok); assert(!act('frogStart', { id: fp.id }, 6).ok, 'one timer at a time');
assert.strictEqual(focus.tick(at(6, 10)), null, 'still running');
assert(/Помидор 30/.test(focus.tick(new Date(at(6).getTime() + 31 * 60e3)))); assert.strictEqual(sum(6).pomoToday, 1); assert.strictEqual(sum(6).frogs[0].pomo, 1); assert.strictEqual(sum(6).timer, null);
act('frogStart', { id: fp.id }, 6); assert.strictEqual(focus.tick(at(6, 15)), null, 'stale timer dropped'); assert.strictEqual(sum(6).pomoToday, 1);
act('frogStart', { id: fp.id }, 6); act('frogStop', {}, 6); assert.strictEqual(sum(6).timer, null);
act('frogStart', { id: fp.id }, 6); act('frogToggle', { id: fp.id }, 6); assert.strictEqual(sum(6).timer, null, 'eaten frog stops its timer');

// recommendations
const R = focus.recommend, o = focus.opts({});
const base = { frogs: [], carry: [], habits: [{ t: 'Немецкий', min: 15, doneToday: false, streak: 4 }], goals: [] };
assert(/Лягушки на сегодня не выбраны/.test(R(base, o, 9).text) && !R(base, o, 9).urgent && R(base, o, 15).urgent);
assert(/не съедена/.test(R({ ...base, frogs: [{ t: 'X', done: false }] }, o, 15).text));
assert(/серию из 4/.test(R({ ...base, frogs: [{ t: 'X', done: true }] }, o, 12).text));
assert(/нет шагов/.test(R({ frogs: [{ t: 'X', done: true }], carry: [], habits: [], goals: [{ t: 'Цель', total: 0, subs: [] }] }, o, 12).text));
assert(/сделано/.test(R({ frogs: [{ t: 'X', done: true }], carry: [], habits: [], goals: [] }, o, 12).text));

// reminder: once per day, only when urgent, respects switches
focus.reset(); focus.init(fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-focus-')));
assert.strictEqual(focus.reminder({}, at(5, 9)), null, 'before remindHour');
assert(focus.reminder({}, at(5, 15))); assert.strictEqual(focus.reminder({}, at(5, 16)), null, 'only once a day');
assert.strictEqual(focus.reminder({ focus: { notify: false } }, at(6, 15)), null);
assert.strictEqual(focus.reminder({ focus: { enabled: false } }, at(6, 15)), null);

// persistence
focus.act('frogAdd', { t: 'persist' }, {}, at(5)); focus.reset(); const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-focus-'));
focus.init(d2); focus.act('frogAdd', { t: 'persist' }, {}, at(5)); focus.reset(); focus.init(d2);
assert.strictEqual(focus.summary({}, at(5)).frogs[0].t, 'persist');
// spaced repetition
const fresh = () => { focus.reset(); focus.init(fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-focus-'))); };
const day = n => new Date(2026, 0, n, 10, 0, 0);   // n may run past the end of January
const s = (n, c = {}) => focus.summary(c, day(n));
const w = (type, n, c = {}) => focus.act(type, {}, c, day(n));

// intervals 1, 3, 7, 14, 30 days, then the word counts as learned
fresh(); const one = { focus: { newPerDay: 1 } };
const first = s(1, one).word.de; assert(s(1, one).word.isNew);
w('wordKnown', 1, one); assert.strictEqual(s(1, one).word, null, 'one new word a day, nothing else due');
const card = () => Object.entries(focus._db().cards).find(([k]) => k.startsWith(first + '|'))[1];
let n = 1;
for (const gap of focus.STEPS) {
  assert.strictEqual(card().due, new Date(Date.UTC(2026, 0, n + gap)).toISOString().slice(0, 10), 'interval ' + gap);
  n += gap;
  assert.strictEqual(s(n, one).word.de, first, 'a due review comes before new words'); assert.strictEqual(s(n, one).words.due >= 1, true);
  assert.strictEqual(s(n, one).learned.month, 0);
  if (gap !== 30) w('wordKnown', n, one);
}
w('wordKnown', n, one); assert(card().done, 'learned after the 30-day review'); assert.strictEqual(s(n, one).learned.day, 1);
assert.notStrictEqual((s(n + 60, one).word || {}).de, first, 'a learned word never returns');

// daily limit of new words, "don't know" returns the same day after the others
fresh(); const two = { focus: { newPerDay: 2 } };
const a = s(1, two).word.de; w('wordAgain', 1, two);
const b = s(1, two).word.de; assert.notStrictEqual(b, a, 'the others go first'); assert.deepStrictEqual(s(1, two).words, { due: 1, newLeft: 1 });
w('wordKnown', 1, two);
assert.strictEqual(s(1, two).word.de, a, 'the unknown word comes back'); assert.strictEqual(s(1, two).words.newLeft, 0);
w('wordAgain', 1, two); assert.strictEqual(s(1, two).word.de, a, 'and stays until known');
w('wordKnown', 1, two); assert.strictEqual(s(1, two).word, null);
assert.strictEqual(s(2, two).words.due, 2); assert.strictEqual(s(2, two).words.newLeft, 2);
focus.act('wordKnown', { id: 'stale card' }, two, day(2)); assert.strictEqual(s(2, two).words.due, 2, 'a click on an old card changes nothing');
assert.strictEqual(focus.opts({ focus: { newPerDay: 99 } }).newPerDay, 20);

// data from 0.11: ticked words continue at the 7-day step, 5 a day; counters survive
const old = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-focus-'));
const { WORDS } = require('../src/focus-data');
fs.writeFileSync(path.join(old, 'focus.json'), JSON.stringify({ known: WORDS.slice(0, 12), shift: { day: '2026-01-01', word: 3, phrase: 1 }, learned: { '2026-01-01': 12 } }));
focus.reset(); focus.init(old);
assert.strictEqual(s(1).words.due, 5); assert.strictEqual(s(2).words.due, 10); assert.strictEqual(s(3).words.due, 12); assert.strictEqual(s(3).learned.month, 12);
w('wordKnown', 3); assert.strictEqual(focus._db().cards[WORDS[0]].due, '2026-01-17', 'next interval after 7 days is 14');
focus.reset(); focus.init(old); assert.strictEqual(s(3).words.due, 11, 'progress survives a restart');
console.log('focus: all checks passed');
