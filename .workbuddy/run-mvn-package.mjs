import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)`;
const log = path.join(root, '.workbuddy', 'mvn-package.log');
const cmd = `"D:/apache-maven-3.9.4/bin/mvn.cmd" -o -s "${path.join(root, '.workbuddy', 'mvn-aliyun-settings.xml')}" -DskipTests package -f "${path.join(root, 'campus-secondhand-backend', 'pom.xml')}"`;

let out = '';
let code = 0;
try {
  out = execSync(cmd, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '') + '\n' + (e.stderr || '');
  code = e.status ?? 1;
}
fs.writeFileSync(log, out, 'utf8');
const keys = out.split(/\r?\n/).filter(l => /BUILD|ERROR|Unable to rename|Building jar|Replacing/.test(l));
console.log(keys.slice(-25).join('\n'));
console.log('EXIT=' + code);

const jarDir = path.join(root, 'campus-secondhand-backend', 'target');
const jars = fs.readdirSync(jarDir).filter(f => f.endsWith('.jar') && !f.endsWith('-sources.jar'));
for (const j of jars) {
  const st = fs.statSync(path.join(jarDir, j));
  console.log(`JAR ${j}  ${(st.size / 1024 / 1024).toFixed(1)} MB  ${st.mtime.toISOString()}`);
}
