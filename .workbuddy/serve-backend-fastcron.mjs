/**
 * 以「快跑 cron」启动后端，专供 e2e-auto-offline-job.mjs 验证定时触发路径。
 *
 * 为什么单独一个脚本而不是改 serve-backend.mjs：
 * 默认 cron 是每天 03:30（生产/演示要的就该是这个值），
 * 若把快跑 cron 写进通用启动脚本，所有人日常跑起来的后端都会每 10 秒扫一次全表改状态。
 * 覆盖只应该发生在「为了验证定时器真的会跑」这一刻，所以单开一个入口。
 *
 * ★ 沙箱行为提醒 ★ 不能 spawn detached 后让 launcher 退出 —— 调用结束时子进程树会被杀掉。
 *   必须由 run_in_background 里的 spawnSync 阻塞保活。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)`;
const cwd = path.join(root, 'campus-secondhand-backend');
const JAVA = String.raw`C:\Program Files\Java\jdk-17\bin\java.exe`;

console.log('CWD=' + cwd);
console.log('CRON=*/10 * * * * ?（每 10 秒一轮，仅本次验证用）');
/*
 * 走环境变量而不是命令行参数：application.yml 里写的是
 *   offline-cron: ${GOODS_AUTO_OFFLINE_CRON:0 30 3 * * ?}
 * 环境变量名与占位符同名，Spring 能直接解析。也可用 --app.goods-maintenance.offline-cron=...，
 * 但那条参数**本身含空格**，在 Windows 下要穿过 spawnSync → CreateProcess 的引号处理，
 * 少一层可变因素就少一类「明明传了却没生效」的排查。
 * （注：本段注释刻意不写出「星号斜杠」那种 cron 写法，否则会提前闭合块注释。）
 */
const r = spawnSync(JAVA, [
  '-jar', 'target/campus-secondhand-backend-1.0.0.jar',
  '--server.port=8080',
], {
  cwd,
  stdio: 'inherit',
  env: { ...process.env, GOODS_AUTO_OFFLINE_CRON: '*/10 * * * * ?' },
});
console.log('JAVA_EXIT=' + r.status);
