import fs from 'node:fs';
import path from 'node:path';

const root = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)`;

const trap = path.join(root, '.workbuddy', 'start-backend.mjs');
if (fs.existsSync(trap)) {
  fs.rmSync(trap);
  console.log('REMOVED start-backend.mjs（detached 会被沙箱杀掉，正确姿势在 serve-backend.mjs）');
} else {
  console.log('start-backend.mjs 不存在');
}

for (const p of [path.join(root, 'uploads'), path.join(root, 'campus-secondhand-backend', 'uploads')]) {
  console.log(`exists=${fs.existsSync(p)}  ${p}`);
}

console.log('--- .workbuddy 本轮新增脚本 ---');
for (const f of ['run-mvn.mjs', 'run-mvn-test.mjs', 'run-mvn-package.mjs', 'serve-backend.mjs', 'check-port.mjs', 'peek-log.mjs', 'patch-goods-tests.mjs', 'e2e-clear-b1.mjs']) {
  const p = path.join(root, '.workbuddy', f);
  console.log(`  ${fs.existsSync(p) ? 'OK ' : 'MISS'} ${f}`);
}
