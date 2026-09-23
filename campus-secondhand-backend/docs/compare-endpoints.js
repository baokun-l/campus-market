/**
 * 前后端接口比对脚本（v3）
 *
 * 相对 v1 修正的三处漏抓/误判：
 *   1. 后端数组形式映射 @GetMapping({"/a", "/b"}) —— v1 的 `"[^"]*"` 完全匹配不上，
 *      会把别名路由当成没实现（且路径里带 `{id}` 时 `[^}]*` 也会当场断掉）；
 *   2. 前端 url 用三元表达式（url: cond ? `/a/${id}` : '/a'）—— v1 只抓第一个字面量；
 *   3. 前端 method 用三元表达式时 v1 直接回退成 GET，凭空造出 "GET /xxx" 这种
 *      后端不存在的端点，再报成 MISSING。
 *
 * 这里改为：以每个 `request(` 调用为边界（括号配平），在该调用内部收集
 * 全部 / 开头的 url 字面量与全部 method 字面量（取笛卡尔积）。
 *
 * 用法：node cmp3.js <前端api目录> <后端controller目录> <输出txt>
 */
const fs = require('fs');
const path = require('path');

const apiDir = process.argv[2];
const ctrlDir = process.argv[3];
const outFile = process.argv[4];

function walk(dir, filter, cb) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p, filter, cb));
    else if (filter(e.name)) out = out.concat(cb(p) || []);
  }
  return out;
}

function norm(p) {
  return p
    .split('/')
    .map((s) => (/\$\{[^}]+\}/.test(s) || /^\{[^}]+\}$/.test(s) ? '{}' : s))
    .join('/')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');
}

/** 从 openIdx（'(' 的下标）出发做括号配平，返回闭合 ')' 的下标 */
function matchParen(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length - 1;
}

/** 取出一段字面量里的字符串（去掉引号） */
function lits(seg) {
  const out = [];
  const re = /(`[^`]*`|'[^']*'|"[^"]*")/g;
  let x;
  while ((x = re.exec(seg))) out.push(x[1].slice(1, -1));
  return out;
}

/**
 * 三元表达式拆分支：`cond ? A : B` -> [A, B]，不是三元返回 null。
 * url 与 method 都写成三元时（url: cond ? `/a/${id}` : '/a'，
 * method: cond ? 'PUT' : 'POST'），必须按分支顺序配对，
 * 否则取笛卡尔积会凭空造出 "PUT /a"、"POST /a/{}" 这种不存在的组合再报成缺口。
 */
function ternaryBranches(seg) {
  const q = seg.indexOf('?');
  if (q < 0) return null;
  const colon = seg.indexOf(':', q + 1);
  if (colon < 0) return null;
  return [lits(seg.slice(q + 1, colon)), lits(seg.slice(colon + 1))];
}

/* ---------------- 前端 ---------------- */
const feMap = new Map();
const addFe = (key, file) => {
  if (!feMap.has(key)) feMap.set(key, new Set());
  feMap.get(key).add(file);
};

walk(
  apiDir,
  (n) => n.endsWith('.ts') && !n.endsWith('.spec.ts'),
  (f) => {
    const src = fs.readFileSync(f, 'utf8');
    const file = path.basename(f);
    const reCall = /request\s*(?:<[^>]*>)?\s*\(/g;
    let m;
    while ((m = reCall.exec(src))) {
      const open = src.indexOf('(', m.index);
      const body = src.slice(open, matchParen(src, open) + 1);

      const urlSeg = (/url\s*:\s*([^,\n]*)/.exec(body) || [])[1] || '';
      const methodSeg = (/method\s*:\s*([^,\n}]*)/.exec(body) || [])[1] || '';

      const urls = lits(urlSeg).filter((u) => u.startsWith('/'));
      if (!urls.length) continue;

      const methods = new Set();
      for (const x of lits(methodSeg)) {
        if (/^[A-Za-z]+$/.test(x)) methods.add(x.toUpperCase());
      }
      if (!methods.size) methods.add('GET');

      // 三元对齐优先
      const bu = ternaryBranches(urlSeg);
      const bm = ternaryBranches(methodSeg);
      const pairs = [];
      if (bu && bm && bu[0].length && bu[1].length && bm[0].length && bm[1].length) {
        pairs.push([bu[0][bu[0].length - 1], bm[0][0]]);
        pairs.push([bu[1][0], bm[1][0]]);
      } else {
        for (const method of methods) {
          for (const raw of urls) pairs.push([raw, method]);
        }
      }

      for (const [raw, method] of pairs) {
        if (!raw.startsWith('/')) continue;
        addFe(method + ' ' + norm(raw), file);
      }
    }
  }
);

/* ---------------- 后端 ---------------- */
const beMap = new Map();
walk(
  ctrlDir,
  (n) => n.endsWith('Controller.java'),
  (f) => {
    const src = fs.readFileSync(f, 'utf8');
    const file = path.basename(f);
    const cls = /@RequestMapping\(\s*"([^"]*)"\s*\)/.exec(src);
    const prefix = cls ? cls[1] : '';
    // 用 [^)]* 取到注解的参数部分（数组里没有 ')'），再抽出全部路径字面量
    const re = /@(Get|Post|Put|Delete|Patch)Mapping\(\s*([^)]*)\)/g;
    let m;
    while ((m = re.exec(src))) {
      const method = m[1].toUpperCase();
      const subs = [];
      const reS = /"([^"]*)"/g;
      let s;
      while ((s = reS.exec(m[2]))) subs.push(s[1]);
      if (!subs.length) subs.push('');
      for (const sub of subs) beMap.set(method + ' ' + norm(prefix + sub), file);
    }
  }
);

/* ---------------- 比对 ---------------- */
const missing = [];
for (const [k, files] of [...feMap.entries()].sort()) {
  if (!beMap.has(k)) missing.push([k, [...files].join(',')]);
}

const unused = [];
for (const [k, f] of [...beMap.entries()].sort()) {
  if (!feMap.has(k)) unused.push([k, f]);
}

const lines = [];
lines.push('前端调用端点数(去重): ' + feMap.size);
lines.push('后端实现端点数(去重): ' + beMap.size);
lines.push('');
lines.push('########## 前端调用但后端【未实现】 ##########');
lines.push('count = ' + missing.length);
missing.forEach(([k, f]) => lines.push('  [MISSING] ' + k + '   <- ' + f));
lines.push('');
lines.push('########## 后端实现但前端【未调用】（仅供参考） ##########');
lines.push('count = ' + unused.length);
unused.forEach(([k, f]) => lines.push('  [UNUSED ] ' + k + '   <- ' + f));
lines.push('');
lines.push('########## 后端全部端点 ##########');
[...beMap.entries()].sort().forEach(([k, f]) => lines.push('  ' + k + '   <- ' + f));

fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
console.log('done');
