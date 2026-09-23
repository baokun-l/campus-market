/**
 * 比对两个 jar 里同名条目的**解压后内容**，定位差异到底在哪儿。
 * 用法: node diff-two-jars.mjs <jarA> <jarB> [entry]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const [ja, jb, only] = process.argv.slice(2);

function load(p) {
    const buf = fs.readFileSync(p);
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) { console.error('[FATAL] ' + p + ' 不是 zip'); process.exit(2); }
    const total = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    const map = new Map();
    for (let n = 0; n < total; n++) {
        const method = buf.readUInt16LE(off + 10);
        const cs = buf.readUInt32LE(off + 20);
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const cmtLen = buf.readUInt16LE(off + 32);
        const localOff = buf.readUInt32LE(off + 42);
        const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
        const lnl = buf.readUInt16LE(localOff + 26);
        const lel = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + lnl + lel;
        const raw = buf.subarray(dataStart, dataStart + cs);
        map.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
        off += 46 + nameLen + extraLen + cmtLen;
    }
    return map;
}

const A = load(ja), B = load(jb);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

if (only) {
    const a = A.get(only), b = B.get(only);
    if (!a || !b) { console.error('[FATAL] 条目不存在于两边'); process.exit(2); }
    console.log(`${only}`);
    console.log(`  A len=${a.length} sha=${sha(a).slice(0, 16)}`);
    console.log(`  B len=${b.length} sha=${sha(b).slice(0, 16)}`);
    let first = -1, cnt = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) { if (first < 0) first = i; cnt++; }
    console.log(`  首个不同偏移=${first} 不同字节数=${cnt}（长度差 ${b.length - a.length}）`);
    if (first >= 0) {
        const s = Math.max(0, first - 4);
        console.log(`  A 上下文: ${a.subarray(s, first + 12).toString('hex')}`);
        console.log(`  B 上下文: ${b.subarray(s, first + 12).toString('hex')}`);
        // class 文件：首个不同点若落在常量池/属性区，通常只是顺序差异
        console.log(`  A 头部: ${a.subarray(0, 10).toString('hex')}  B 头部: ${b.subarray(0, 10).toString('hex')}`);
    }
    process.exit(0);
}

const diff = [];
for (const [n, a] of A) {
    const b = B.get(n);
    if (!b) { diff.push([n, 'only-in-A']); continue; }
    if (sha(a) !== sha(b)) diff.push([n, 'content', a.length, b.length]);
}
console.log(`A 条目 ${A.size} / B 条目 ${B.size}｜内容不同 ${diff.length} 条`);
const buckets = {};
for (const [n] of diff) {
    const k = n.split('/').slice(0, 2).join('/');
    buckets[k] = (buckets[k] || 0) + 1;
}
console.log('归类:', JSON.stringify(buckets));
// ★ 只报"N 条不同"是不够的 ★：定位时还得再跑一遍才知道是哪几条，
//   而审计结论必须能直接指向文件。所以把条目名打出来（超过 30 条才截断）。
for (const d of diff.slice(0, 30)) {
    const [n, kind, la, lb] = d;
    console.log(`    · ${n}${kind === 'content' ? `  (${la}B → ${lb}B)` : '  ' + kind}`);
}
if (diff.length > 30) console.log(`    … 另有 ${diff.length - 30} 条`);
// 只在 A 里有的条目也值得单独说一句（B 里新增的 diff 循环覆盖不到）
for (const [n] of B) if (!A.has(n)) console.log(`    + 仅 B 有: ${n}`);
