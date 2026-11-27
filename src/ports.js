// Listening TCP ports: parsed from netstat (no admin rights, no PowerShell) and joined with the process scan.
const { execFile } = require('child_process');

const POPULAR = new Set([3000, 3001, 4200, 5000, 5173, 8000, 8080]);
// Docker / WSL port relays: ending one of them takes down every container, so the app never offers it.
const DOCKER = /^(com\.docker\.[\w.-]+|docker( desktop)?|dockerd|vpnkit[\w.-]*|wslrelay|wslhost|vmmem(wsl)?|vmcompute)(\.exe)?$/i;

// Pure: netstat -ano output -> [{port, pid, public}]. A listener is a row with an empty foreign address
// (the state column is not used, so a localized Windows works too). IPv4 and IPv6 rows of one port are merged.
function parse(out) {
  const map = new Map();
  for (const line of String(out).split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+(?:0\.0\.0\.0|\[::\]):0\s+\S+\s+(\d+)\s*$/);
    if (!m) continue;
    const port = +m[2], pid = +m[3], open = !/^(127\.|\[::1\]|\[::ffff:127\.)/.test(m[1]), key = port + ':' + pid;
    const e = map.get(key);
    if (e) e.public = e.public || open; else map.set(key, { port, pid, public: open });
  }
  return [...map.values()].sort((a, b) => a.port - b.port || a.pid - b.pid);
}

const netstat = proto => new Promise(res => execFile('netstat', ['-ano', '-p', proto], { windowsHide: true, timeout: 5000, maxBuffer: 8e6 }, (e, out) => res(e ? '' : String(out))));
const listening = async () => parse((await Promise.all([netstat('TCP'), netstat('TCPv6')])).join('\n'));

module.exports = { parse, listening, POPULAR, DOCKER };
