// Logic test for the port list and the disk counters: node tools/test-monitor.js
const assert = require('assert');
const ports = require('../src/ports');
const disk = require('../src/disk');
const { portList } = require('../src/procs');

const out = [
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       100',
  '  TCP    [::]:5173              [::]:0                 LISTENING       100',
  '  TCP    127.0.0.1:3000         0.0.0.0:0              ПРОСЛУШИВАНИЕ   200',
  '  TCP    [::1]:9000             [::]:0                 LISTENING       300',
  '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4',
  '  TCP    127.0.0.1:50000        127.0.0.1:3000         ESTABLISHED     999',
].join('\r\n');
const found = ports.parse(out);
assert.deepStrictEqual(found.map(p => [p.port, p.pid, p.public]), [[445, 4, true], [3000, 200, false], [5173, 100, true], [9000, 300, false]]);

const proc = (pid, name, parentPid = 1) => ({ pid, parentPid, name, cmd: '', memRss: 2048, started: Date.now() - 600000 });
const list = [proc(100, 'node.exe'), proc(200, 'com.docker.backend.exe'), proc(300, 'spooler.exe'), proc(process.pid, 'electron.exe'), proc(777, 'node.exe', process.pid)];
const rows = portList([...found, { port: 8000, pid: 777, public: false }], list, [], [], []);
const by = port => rows.find(r => r.port === port);
assert(by(5173).dev && !by(5173).lock && by(5173).ageMin === 10);
assert.strictEqual(by(3000).lock, 'Docker / WSL'); assert(by(3000).dev, 'popular port is shown by default');
assert.strictEqual(by(445).lock, 'системный'); assert(!by(445).dev);
assert(!by(9000).dev && !by(9000).lock);
assert.strictEqual(by(8000).lock, 'PC Monitor', 'own processes are never offered');

// typeperf writes a row in pieces and ends it only when the next one starts
const head = '"(PDH-CSV 4.0)","\\\\PC\\PhysicalDisk(_Total)\\Disk Read Bytes/sec","\\\\PC\\PhysicalDisk(_Total)\\Disk Write Bytes/sec"';
let r = disk.parse(head + '\r\n"11/27/2026 12:03:04.575"'); assert.strictEqual(r.rows.length, 0);
r = disk.parse(r.rest + ',"0.000000"'); assert.strictEqual(r.rows.length, 0);
r = disk.parse(r.rest + ',"288821.290777"'); assert.deepStrictEqual(r.rows, [{ read: 0, write: 288821.290777 }]);
r = disk.parse(r.rest + '\r\n"11/27/2026 12:03:06.584","22421,5","467275"'); assert.deepStrictEqual(r.rows, [{ read: 22421.5, write: 467275 }]);
console.log('monitor: all checks passed');
