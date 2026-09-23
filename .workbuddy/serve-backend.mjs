import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)`;
const cwd = path.join(root, 'campus-secondhand-backend');
const JAVA = String.raw`C:\Program Files\Java\jdk-17\bin\java.exe`;

console.log('CWD=' + cwd);
const r = spawnSync(JAVA, [
  '-jar', 'target/campus-secondhand-backend-1.0.0.jar',
  '--server.port=8080',
], { cwd, stdio: 'inherit' });
console.log('JAVA_EXIT=' + r.status);
