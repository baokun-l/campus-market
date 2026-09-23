/**
 * 从 jar 里解出指定条目（Node 内置，不依赖 jar/unzip 命令）。
 * 用法: node jar-extract.mjs <jar> <entryName> [outFile]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const [jar, want, out] = process.argv.slice(2);
if (!jar || !want) { console.error('用法: node jar-extract.mjs <jar> <entry> [outFile]'); process.exit(2); }
const buf = fs.readFileSync(jar);

let eocd = -1;
for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) { console.error('[FATAL] 不是 zip'); process.exit(2); }
const total = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);
let found = null;
for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) { console.error('[FATAL] 中央目录损坏'); process.exit(2); }
    const method = buf.readUInt16LE(off + 10);
    const cs = buf.readUInt32LE(off + 20);
    const us = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === want) { found = { method, cs, us, localOff }; break; }
    off += 46 + nameLen + extraLen + cmtLen;
}
if (!found) { console.error(`[FATAL] 条目不存在: ${want}`); process.exit(2); }

// 本地文件头：0 sig(4) ... 26 nameLen(2) 28 extraLen(2) 30 name ...
const lnl = buf.readUInt16LE(found.localOff + 26);
const lel = buf.readUInt16LE(found.localOff + 28);
const dataStart = found.localOff + 30 + lnl + lel;
const raw = buf.subarray(dataStart, dataStart + found.cs);
const data = found.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);

if (out) { fs.writeFileSync(out, data); console.log(`written ${out}  (${data.length} bytes, method=${found.method})`); }
else {
    const c = await import('node:crypto');
    console.log(`${want}  method=${found.method} size=${data.length} sha256=${c.createHash('sha256').update(data).digest('hex').slice(0, 16)}`);
}
