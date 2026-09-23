/**
 * 红绿验证（B3-a 自动下架）：临时把实现改回「错的写法」，确认用例真的会红。
 *
 * 为什么必须做：单测全绿只证明「代码做了它现在做的事」。
 * 只有当把实现改坏、用例真的变红，才证明这些用例**真的在守那件事** ——
 * 否则很容易写出一堆「永远为真」的断言。
 *
 * 三个红色变体，每个对应一种**不报错、单线程也复现不了**的静默失效：
 *   RED-A 交换 set/eq 的状态值 → 变成「把已下架的商品重新上架」或「一件都不动」，数据看不出坏
 *   RED-B 去掉 days<=0 的闸门 → 0/NULL（本意"关闭"）被当成「立刻下架所有在售商品」
 *   RED-C 把 NULL/负数当默认 30 → 上面那条的另一种写法：配置缺失反而变严（会真的丢数据）
 *
 * 跑完自动还原（try/finally 保证即使 maven 抛异常也还原）。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)`;
const SVC = path.join(root, 'campus-secondhand-backend/src/main/java/com/campus/market/service/GoodsMaintenanceService.java');
const ANALYTICS = path.join(root, 'campus-secondhand-backend/src/main/java/com/campus/market/service/AnalyticsService.java');
const POM = path.join(root, 'campus-secondhand-backend/pom.xml');

const origSvc = fs.readFileSync(SVC, 'utf8');
const origAnalytics = fs.readFileSync(ANALYTICS, 'utf8');

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
    .filter(l => /Tests run:.*(Failures|Errors)|BUILD|^\[ERROR\].*Test|<<< (FAILURE|ERROR)/.test(l))
    .slice(-16).join('\n');
  return { code, summary, log };
}

const guardCall = `        if (days <= 0) {\n            // 0 / NULL = 关闭自动下架。配置缺失时放宽，绝不收紧（理由见 AnalyticsService#autoOfflineDays）\n            return 0;\n        }\n`;
const guardPreview = `        if (days <= 0) {\n            return 0;\n        }\n`;

const variants = [
  {
    tag: 'a',
    file: SVC,
    name: 'RED-A 交换状态值：set → on_sale / eq → off_shelf（方向反了）',
    expect: '「方向不能反」一条应红（写 out 的是 off_shelf、筛的是 on_sale）',
    // ★ 锚点必须连 .set(...) 一起给：单独锚 .eq(Goods::getStatus,"on_sale") 会命中
    //   countStaleGoods（预览方法）里那一处，而被测的是 offlineCreatedBefore ——
    //   改错了地方 → 用例不红 → 会误判成「用例没有判别力」。
    apply: s => s.replace(
      `                .set(Goods::getStatus, "off_shelf")   // 写成什么\n                .eq(Goods::getStatus, "on_sale")      // 只碰在售（sold / pending / 已下架的都不动）`,
      `                .set(Goods::getStatus, "on_sale")   // RED-PROBE-A\n                .eq(Goods::getStatus, "off_shelf")  // RED-PROBE-A`),
    test: 'GoodsMaintenanceServiceOfflineTest',
  },
  {
    tag: 'b',
    file: SVC,
    name: 'RED-B 去掉 days<=0 闸门：把「关闭」当成「立刻全量下架」',
    expect: '「0 表示关闭」两条应红（一条都不改 / 预览返回 0）',
    apply: s => s.replace(guardCall, '').replace(guardPreview, ''),
    test: 'GoodsMaintenanceServiceOfflineTest',
  },
  {
    tag: 'c',
    file: ANALYTICS,
    name: 'RED-C 把 NULL/负数当默认 30（配置缺失反而变严）',
    expect: 'NULL / 显式 0 / 负数 三条应红',
    apply: s => s.replace('return (days == null || days <= 0) ? 0 : days;',
                          'return (days == null || days <= 0) ? 30 : days;'),
    test: 'AnalyticsServiceAutoOfflineTest',
  },
];

try {
  for (const v of variants) {
    const orig = fs.readFileSync(v.file, 'utf8');
    const mutated = v.apply(orig);
    if (mutated === orig) {
      console.log('\n!! 变体未生效（锚点没匹配到）：' + v.name);
      continue;
    }
    fs.writeFileSync(v.file, mutated, 'utf8');
    console.log('\n==================== ' + v.name + ' ====================');
    console.log('期望：' + v.expect);
    const r = mvnTest(v.test, 'b3a-red-' + v.tag + '.log');
    console.log(r.summary);
    console.log('EXIT=' + r.code + '（非 0 = 用例变红，符合预期）');
    fs.writeFileSync(v.file, orig, 'utf8');
  }
} finally {
  // 逐字节写回，绝对不让探针把源码留在改坏的状态
  fs.writeFileSync(SVC, origSvc, 'utf8');
  fs.writeFileSync(ANALYTICS, origAnalytics, 'utf8');
  console.log('\n已还原 GoodsMaintenanceService.java / AnalyticsService.java（原始内容逐字节写回）');
}
