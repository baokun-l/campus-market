/**
 * 红绿验证（B3-b 接口文档 · 顺带撞出来的 500 缺陷）：
 * 临时把 GlobalExceptionHandler 改回「错的行为」，确认新写的用例真的会红。
 *
 * ★ 关于这次红绿的证据强度，要说清楚（别把话说满）★
 * 这个缺陷（HttpRequestMethodNotSupportedException 落到兜底 → 500）**真机红绿已经拿到了**：
 * e2e-swagger 的 C1 在修复前实测返回 code=500，补上两个 @ExceptionHandler 后返回 1001 ——
 * 同一条探针、同一台机器、先红后绿，这是级别最高的一条证据。
 * 本脚本补的是**单测层面**的判别力：证明 GlobalExceptionHandlerTest 里的断言不是「永远为真」。
 *
 * 为什么单测没法直接复现「没有处理器」这个原始形态：
 * 「没写 @ExceptionHandler → 落入兜底」是 Spring MVC 的 advice 解析行为，
 * 纯单测（不启容器）根本走不到那一步。所以这里用「把返回值改成 SERVER_ERROR」
 * 来等价模拟当时的可观测结果（500），并如实标注这个等价关系 —— 不假装它是原始形态。
 *
 * 四个红色变体：
 *   RED-A 方法不对 → 改回 SERVER_ERROR（等价复现「落到兜底」的后果）
 *   RED-B 提示里的「该用哪个方法」抹掉 → 提示形同虚设，但错误码仍对（最容易漏的一种坏）
 *   RED-C Content-Type 不对 → 改回 SERVER_ERROR
 *   RED-D 兜底分支把 e.getMessage() 回吐 → 内部细节（表名/SQL/类名）泄露回归
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)`;
const HANDLER = path.join(root,
  'campus-secondhand-backend/src/main/java/com/campus/market/common/GlobalExceptionHandler.java');
const POM = path.join(root, 'campus-secondhand-backend/pom.xml');

const orig = fs.readFileSync(HANDLER, 'utf8');

function mvnTest(testClass, logName) {
  const log = path.join(root, '.workbuddy', logName);
  const cmd = `"D:/apache-maven-3.9.4/bin/mvn.cmd" -o -s "${path.join(root, '.workbuddy', 'mvn-aliyun-settings.xml')}"`
    + ` test -Dtest=${testClass} -f "${POM}"`;
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
    .filter(l => /Tests run:.*(Failures|Errors)|BUILD|\[ERROR\].*Test|<<< (FAILURE|ERROR)|expected:/.test(l))
    .slice(-18).join('\n');
  return { code, summary, log };
}

const variants = [
  {
    tag: 'a',
    name: 'RED-A 方法不对 → 改回 SERVER_ERROR（等价复现「落到兜底」的 500）',
    expect: '「方法不对 → 1001」与「无支持方法列表仍是 1001」两条应红',
    apply: s => s.replace(
      `        return Result.error(BusinessCode.PARAM_ERROR,
                "请求方法 " + e.getMethod() + " 不被支持" + hint);`,
      `        return Result.error(BusinessCode.SERVER_ERROR,
                "请求方法 " + e.getMethod() + " 不被支持" + hint);`),
  },
  {
    tag: 'b',
    name: 'RED-B 抹掉「该用哪个方法」的提示（错误码还对，但提示形同虚设）',
    expect: '「要告诉他该用哪个方法」一条应红（错误码断言仍绿 —— 说明这条断言确实在守提示本身）',
    apply: s => s.replace(
      `                ? "" : "，该接口只支持 " + String.join(" / ", supported);`,
      `                ? "" : "";  // RED-PROBE-B`),
  },
  {
    tag: 'c',
    name: 'RED-C Content-Type 不对 → 改回 SERVER_ERROR',
    expect: '「Content-Type 不对 → 1001」一条应红',
    apply: s => s.replace(
      `        return Result.error(BusinessCode.PARAM_ERROR,
                "请求 Content-Type 不支持，请使用 application/json");`,
      `        return Result.error(BusinessCode.SERVER_ERROR,
                "请求 Content-Type 不支持，请使用 application/json");`),
  },
  {
    tag: 'd',
    name: 'RED-D 兜底分支回吐 e.getMessage()（内部细节泄露回归）',
    expect: '「兜底不泄露内部细节」一条应红（表名 t_goods / 类名 IllegalState 都不该出现）',
    apply: s => s.replace(
      `        return Result.error(BusinessCode.SERVER_ERROR, "服务器内部错误，请稍后再试");`,
      `        return Result.error(BusinessCode.SERVER_ERROR, e.getMessage());`),
  },
];

try {
  for (const v of variants) {
    const mutated = v.apply(orig);
    if (mutated === orig) {
      console.log('\n!! 变体未生效（锚点没匹配到）：' + v.name);
      continue;
    }
    fs.writeFileSync(HANDLER, mutated, 'utf8');
    console.log('\n==================== ' + v.name + ' ====================');
    console.log('期望：' + v.expect);
    const r = mvnTest('GlobalExceptionHandlerTest', 'b3b-red-' + v.tag + '.log');
    console.log(r.summary);
    console.log('EXIT=' + r.code + '（非 0 = 用例变红，符合预期）');
    fs.writeFileSync(HANDLER, orig, 'utf8');
  }
} finally {
  // 逐字节写回，绝不让探针把源码留在改坏的状态
  fs.writeFileSync(HANDLER, orig, 'utf8');
  console.log('\n已还原 GlobalExceptionHandler.java（原始内容逐字节写回）');
}
