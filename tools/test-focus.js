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

// words / phrases rotate and "known" removes a word from rotation
const w1 = sum().word.de; act('wordNext', {}); assert.notStrictEqual(sum().word.de, w1);
const w2 = sum().word.de; act('wordKnown', {}); assert.notStrictEqual(sum().word.de, w2);
const p1 = sum().phrase.de; act('phraseNext', {}); assert.notStrictEqual(sum().phrase.de, p1); assert(sum().phrase.ru);
assert.deepStrictEqual(sum().learned, { day: 1, month: 1 }); act('wordKnown', {}, 6); assert.deepStrictEqual(sum(6).learned, { day: 1, month: 2 });

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
console.log('focus: all checks passed');
