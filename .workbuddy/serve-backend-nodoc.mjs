/**
 * 以「接口文档关闭」启动后端，专供 e2e-swagger.mjs off 验证生产兜底开关。
 *
 * 为什么单独一个脚本而不是改 serve-backend.mjs：
 * 默认必须是「文档开着」（开发/演示要的就是能用 Swagger 点接口），
 * 若把关闭写进通用启动脚本，所有人日常跑起来都没有文档了。
 * 关闭只应该发生在「为了验证开关真的关得掉」这一刻，所以单开一个入口。
 *
 * 走环境变量而不是命令行参数：application.yml 里写的是
 *   api-docs.enabled: ${SPRINGDOC_API_DOCS_ENABLED:true}
 *   swagger-ui.enabled: ${SPRINGDOC_SWAGGER_UI_ENABLED:true}
 * 环境变量名与占位符同名，Spring 能直接解析（同 serve-backend-fastcron.mjs 的理由）。
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
console.log('SPRINGDOC_API_DOCS_ENABLED=false / SPRINGDOC_SWAGGER_UI_ENABLED=false（仅本次验证用）');

const r = spawnSync(JAVA, [
  '-jar', 'target/campus-secondhand-backend-1.0.0.jar',
  '--server.port=8080',
], {
  cwd,
  stdio: 'inherit',
  env: {
    ...process.env,
    SPRINGDOC_API_DOCS_ENABLED: 'false',
    SPRINGDOC_SWAGGER_UI_ENABLED: 'false',
  },
});
console.log('JAVA_EXIT=' + r.status);
