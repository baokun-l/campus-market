import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)`;
const log = path.join(root, '.workbuddy', 'mvn-clear-test.log');
const cmd = `"D:/apache-maven-3.9.4/bin/mvn.cmd" -o -s "${path.join(root, '.workbuddy', 'mvn-aliyun-settings.xml')}" test -f "${path.join(root, 'campus-secondhand-backend', 'pom.xml')}"`;

let out = '';
let code = 0;
try {
  out = execSync(cmd, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '') + '\n' + (e.stderr || '');
  code = e.status ?? 1;
}
fs.writeFileSync(log, out, 'utf8');
console.log('EXIT=' + code);
console.log('LOGFILE=' + log);
