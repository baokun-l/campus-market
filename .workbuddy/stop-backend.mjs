/**
 * 停掉监听 8080 的后端进程。
 *
 * ★ 为什么按 PID 杀、而不是 `taskkill /IM java.exe` ★
 * 本机同时开着 IDEA 等 Java 进程，按映像名杀会把它们一起带走（工作丢失、索引重来）。
 * 这里只杀「真的占着 8080 的那个进程及其子进程」。
 */
import { execSync } from 'node:child_process';

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'latin1', maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    return (e.stdout || '') + '\n' + (e.stderr || '');
  }
}

const lines = sh('netstat -ano').split(/\r?\n/)
  .filter(l => /:8080\s/.test(l) && /LISTENING/i.test(l));

const pids = new Set();
for (const l of lines) {
  const pid = l.trim().split(/\s+/).pop();
  if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
}

if (pids.size === 0) {
  console.log('8080 上没有监听进程，无需操作');
  process.exit(0);
}

for (const pid of pids) {
  console.log(`kill PID ${pid} (/T 连带子进程, /F 强制)`);
  console.log(sh(`taskkill /PID ${pid} /T /F`).trim());
}

// 复核
const after = sh('netstat -ano').split(/\r?\n/)
  .filter(l => /:8080\s/.test(l) && /LISTENING/i.test(l));
console.log(after.length === 0 ? 'OK 8080 已释放' : 'WARN 8080 仍被占用:\n' + after.join('\n'));
