// 台账卫生修复（2026-09-23）：三处「文档自己撒谎」
//  D-A 缺陷清单逐条核对报告.md：§二十三 整节被逐字节复制了一遍，且编号与主表「详见 §十八」不符
//  D-B 同文件头部导航仍写「§十一 ~ §十六 / 最近一次更新：§十六」
//  D-C campus-secondhand-backend/README.md §8 附录范围仍写「附一～附二十四」（实际已到附二十五）
// 纪律：① 先自证（先断言现状、再改）② 幂等 ③ 异常退出码 2
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const RPT = path.join(ROOT, '缺陷清单逐条核对报告.md');
const README = path.join(ROOT, 'campus-secondhand-backend', 'README.md');

let problems = 0;
const fail = (m) => { console.log('  ✗ ' + m); problems++; };
const ok = (m) => console.log('  ✓ ' + m);

// ---------- D-A / D-B：核对报告 ----------
console.log('== D-A 核对报告：去重 + 编号改 十八 ==');
{
  const lines = fs.readFileSync(RPT, 'utf8').split('\n');
  const headIdx = [];
  lines.forEach((l, i) => { if (/^## 二十三、/.test(l)) headIdx.push(i); });

  if (headIdx.length === 0) {
    ok('已无「## 二十三」，跳过（幂等）');
  } else if (headIdx.length === 1) {
    fail('只剩 1 处「## 二十三」——状态异常，人工确认后再跑');
  } else if (headIdx.length > 2) {
    fail(`出现 ${headIdx.length} 处「## 二十三」，超出本脚本处理范围`);
  } else {
    const [a, b] = headIdx;                      // 两处 0-based
    // 自证：两块内容必须逐字节相同（否则不是复制，是两节不同内容，不能删）
    const blkA = lines.slice(a, b - 2).join('\n').trimEnd();   // 第一块（到 --- 之前）
    const blkB = lines.slice(b).join('\n').trimEnd();          // 第二块（到文件里下一节之前）
    const segB = blkB.split(/\n---\n/)[0].trimEnd();
    if (blkA !== segB) {
      fail('两块内容不一致 ⇒ 不是重复复制，拒绝删除！');
    } else {
      ok(`两块逐字节相同（${blkA.split('\n').length} 行）⇒ 确认是复制`);
      const before = lines.length;
      // 删除第二块：b 起，到其后第一条 "---" 的下一行为止（含分隔线），保留一处 --- 
      let end = b;
      while (end < lines.length && lines[end].trim() !== '---') end++;
      if (end >= lines.length || lines[b - 1].trim() !== '') {
        fail('自证失败：找不到第二块末尾的 "---" 或其前一行为空行，拒绝删除！');
      } else {
        // 删「空行 + 重复块 + 空行 + ---」⇒ 只留第一处 --- 作分隔
        const start = b - 1;
        const removed = lines.splice(start, end - start + 1);
        ok(`删除重复块 ${removed.length} 行（${before} → ${lines.length}）`);
        fs.writeFileSync(RPT, lines.join('\n'), 'utf8');
      }
    }
  }
}
// 编号订正（幂等：已是 十八 就跳过）
{
  let txt = fs.readFileSync(RPT, 'utf8');
  const nHead = (txt.match(/^## 二十三、/gm) || []).length;
  const nSub = (txt.match(/^### 23\.\d/gm) || []).length;
  if (nHead === 0 && nSub === 0) {
    ok('编号已是「十八 / 18.x」，跳过（幂等）');
  } else if (nHead !== 1 || nSub !== 7) {
    fail(`自证失败：期望 1 个主标题 + 7 个小节，实得 ${nHead} / ${nSub}`);
  } else {
    txt = txt.replace(/^## 二十三、/m, '## 十八、').replace(/^### 23\.(\d)/gm, '### 18.$1');
    fs.writeFileSync(RPT, txt, 'utf8');
    // 回读自证
    const t2 = fs.readFileSync(RPT, 'utf8');
    const bad = (/^## 二十三、/m.test(t2) ? 1 : 0) + (/^### 23\./m.test(t2) ? 1 : 0);
    if (bad !== 0 || !/^## 十八、/m.test(t2) || (t2.match(/^### 18\.\d/gm) || []).length !== 7) {
      fail('回读自证失败：编号替换不完整');
    } else {
      ok('编号已订正：二十三 → 十八（1 主 + 7 子），与主表「详见 §十八」对齐');
    }
  }
}
console.log('== D-B 核对报告：头部导航 ==');
{
  let txt = fs.readFileSync(RPT, 'utf8');
  const before = txt;
  txt = txt.replace(/> 要判断「现在还剩什么没修」，请看 \*\*§十一 ~ §十六\*\*/, '> 要判断「现在还剩什么没修」，请看 **§十一 ~ §二十**');
  txt = txt.replace(/> 最近一次更新：\*\*§十六 = B3-d「游客能力」（M7）已修\*\*，`❌ 问题仍存在` 相应少 1 条。/,
    '> 最近一次更新：**§二十 = B6 批「P1-5 健康检查 + P1-6 请求上下文」已修**（另：§十一~§二十 逐节订正过历史判定）。');
  if (txt === before) { ok('头部导航已是最新，跳过（幂等）'); }
  else { fs.writeFileSync(RPT, txt, 'utf8'); ok('头部导航已更新为 §十一 ~ §二十 / 最新 = §二十'); }
}

// ---------- D-C：README 附录范围 ----------
console.log('== D-C README §8 附录范围 ==');
{
  let txt = fs.readFileSync(README, 'utf8');
  const n = (txt.match(/「附一」～「附二十四」/g) || []).length;
  if (n === 0) { ok('已是「附二十五」或已无该表述，跳过（幂等）'); }
  else if (n !== 1) { fail(`期望 1 处，实得 ${n} 处`); }
  else {
    txt = txt.replace('「附一」～「附二十四」', '「附一」～「附二十五」');
    fs.writeFileSync(README, txt, 'utf8');
    ok('「附一」～「附二十四」→「附一」～「附二十五」');
  }
}

console.log(problems === 0 ? '\n结果：0 处异常' : `\n结果：${problems} 处异常`);
process.exit(problems === 0 ? 0 : 2);
