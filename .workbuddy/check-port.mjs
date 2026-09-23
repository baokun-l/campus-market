import { execSync } from 'node:child_process';

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'latin1', maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    return (e.stdout || '') + '\n' + (e.stderr || '');
  }
}

// 8080 占用情况
const netstat = sh('netstat -ano');
const lines = netstat.split(/\r?\n/).filter(l => /:8080\s/.test(l) && /LISTENING/i.test(l));
console.log('== LISTENING on 8080 ==');
console.log(lines.join('\n') || '(none)');

const pids = new Set();
for (const l of lines) {
  const m = l.trim().split(/\s+/);
  const pid = m[m.length - 1];
  if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
}
console.log('PIDS=' + [...pids].join(','));

for (const pid of pids) {
  const t = sh(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`);
  console.log(`PID ${pid}: ${t.trim().split(/\r?\n/)[0]}`);
}
