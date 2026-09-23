/**
 * 列出 jar（zip）里的条目，用于验证「demo 资源有没有被打进包」。
 *
 * 为什么不用 `jar tf`：本项目在 PowerShell 下取不到 stdout（已知问题），
 * 而重定向到文件会得到 UTF-16LE，还要再转一次编码；直接在 Node 里解 zip 中央目录
 * 更短、更可控，也不依赖 JDK 的 bin 在 PATH 上。
 *
 * 自证：解不出「以 PK\x05\x06 结尾记录」或条目数为 0 ⇒ 退出码 2，
 *       绝不把「解析失败」伪装成「没有 demo 文件」。
 */
import fs from 'node:fs';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
    console.error('[FATAL] 用法: node jar-entries.mjs <jar路径>');
    process.exit(2);
}
const buf = fs.readFileSync(file);

// 从尾部往前找 EOCD（End Of Central Directory，签名 0x06054b50）
let eocd = -1;
for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) { console.error('[FATAL] 找不到 EOCD，可能不是 zip/jar'); process.exit(2); }

const total = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);

const entries = [];
for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) {
        console.error(`[FATAL] 第 ${n} 条中央目录记录签名不对，解析失败`);
        process.exit(2);
    }
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const compSize = buf.readUInt32LE(off + 20);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, compSize });
    off += 46 + nameLen + extraLen + cmtLen;
}

if (entries.length === 0) { console.error('[FATAL] 条目数为 0'); process.exit(2); }

const mode = process.argv[3] || 'demo';
const hit = entries.filter((e) => {
    if (mode === 'demo') return /demo/i.test(e.name);
    return e.name.includes(mode);
});

console.log(`jar: ${file}`);
console.log(`总条目 ${entries.length}`);
console.log(`匹配 "${mode}" 的条目 ${hit.length} 条：`);
for (const e of hit) console.log(`  ${e.name}  (${e.compSize}B)`);
