/**
 * 红绿验证（B2 登录闸门）：临时把实现改回「错的写法」，确认用例会红。
 *
 * 为什么必须做：单测全绿只能证明「代码做了它现在做的事」。
 * 只有当把实现改坏、用例真的变红，才证明这些用例**真的在守那件事**——
 * 否则很容易写出一堆「永远为真」的断言（例如断言里自己算了一遍期望值）。
 *
 * 两个红色变体各针对一类静默失效：
 *   RED-A 闸门完全没接线（三处调用全去掉）→ 等于没装，应大面积红
 *   RED-B 把「账号被封禁」也计入失败 → 被封用户额外收到「尝试次数过多」，应红
 * 跑完自动还原（try/finally 保证即使 maven 抛异常也还原）。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)`;
const SVC = path.join(root, 'campus-secondhand-backend/src/main/java/com/campus/market/service/UserService.java');
const POM = path.join(root, 'campus-secondhand-backend/pom.xml');

const orig = fs.readFileSync(SVC, 'utf8');

function mvnThrottleTest(logName) {
  const log = path.join(root, '.workbuddy', logName);
  const cmd = `"D:/apache-maven-3.9.4/bin/mvn.cmd" -o -s "${path.join(root, '.workbuddy', 'mvn-aliyun-settings.xml')}"`
    + ` test -Dtest=UserServiceLoginThrottleTest -f "${POM}"`;
  let out = '';
  let code = 0;
  try {
    out = execSync(cmd, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = (e.stdout || '') + '\n' + (e.stderr || '');
    code = e.status ?? 1;
  }
  fs.writeFileSync(log, out, 'utf8');
  const summary = out.split(/\r?\n/)
    .filter(l => /Tests run:.*(Failures|Errors)|BUILD|^\[ERROR\].*Test|<<< (FAILURE|ERROR)/.test(l))
    .slice(-14).join('\n');
  return { code, summary, log };
}

const variants = [
  {
    name: 'RED-A 闸门完全未接线（三处调用全去掉）',
    expect: '第 6 次被拦 / 锁到期恢复 / 不存在用户名计数 三条应红',
    apply: s => s
      .replace('loginAttemptGuard.assertNotLocked(username, clientIp);', '// RED-PROBE-A')
      .replace('loginAttemptGuard.onFailure(username, clientIp);', '// RED-PROBE-A')
      .replace('loginAttemptGuard.onSuccess(username);', '// RED-PROBE-A'),
  },
  {
    name: 'RED-B 把「账号被封禁」也当成一次失败计数',
    expect: '被封禁账号不计数 一条应红',
    apply: s => s.replace(
      `        if ("banned".equals(user.getStatus())) {\n            throw BusinessException.forbidden("账号「" + user.getNickname() + "」已被封禁，无法继续使用");`,
      `        loginAttemptGuard.onFailure(username, clientIp); // RED-PROBE-B\n        if ("banned".equals(user.getStatus())) {\n            throw BusinessException.forbidden("账号「" + user.getNickname() + "」已被封禁，无法继续使用");`),
  },
];

let mutated = false;
try {
  for (const v of variants) {
    const mutatedSrc = v.apply(orig);
    mutated = mutatedSrc !== orig;
    if (!mutated) {
      console.log('!! 变体未生效（锚点没匹配到）：' + v.name);
      continue;
    }
    fs.writeFileSync(SVC, mutatedSrc, 'utf8');
    console.log('\n==================== ' + v.name + ' ====================');
    console.log('期望：' + v.expect);
    const r = mvnThrottleTest('b2-red-' + (v.name.startsWith('RED-A') ? 'a' : 'b') + '.log');
    console.log(r.summary);
    console.log('EXIT=' + r.code + '（非 0 = 用例变红，符合预期）');
  }
} finally {
  fs.writeFileSync(SVC, orig, 'utf8');
  console.log('\n已还原 UserService.java（原始内容逐字节写回）');
}
