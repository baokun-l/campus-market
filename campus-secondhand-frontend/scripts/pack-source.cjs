// 打包前端源码到 提交物/实践任务2-（班号待填）-162-刘宝坤.zip
// 走 .NET ZipFile API，逐文件过滤（避免 robocopy /XD 转义与 PowerShell + 号转义坑）

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务2：Web前端开发(Vue3+Element Plus+ECharts)\campus-secondhand-frontend`;
const submitDir = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务2：Web前端开发(Vue3+Element Plus+ECharts)\提交物`;

const zipName = '实践任务2-计算机科学与技术2302班-162-刘宝坤.zip';
const zipPath = path.join(submitDir, zipName);

// 排除的目录（精确名）
const EXCLUDE_DIRS = new Set([
  'node_modules',
  'coverage',
  '.git',
  '.idea',
  '.vscode',
  '.workbuddy',
  '.cache',
  '.pack-staging',
]);

// 排除的目录名前缀 —— 覆盖 dist / dist_v2 / dist2 / dist-opt / dist-ssr 等所有构建产物变体
const EXCLUDE_DIR_PREFIXES = ['dist', '.pack-'];

const EXCLUDE_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
]);

function isTimestampFile(name) {
  return /\.timestamp-\d+-[a-f0-9]+\.mjs$/i.test(name);
}

function shouldExcludeDir(name) {
  if (EXCLUDE_DIRS.has(name)) return true;
  return EXCLUDE_DIR_PREFIXES.some((p) => name.startsWith(p));
}

function shouldExcludeFile(name) {
  if (EXCLUDE_FILES.has(name)) return true;
  if (isTimestampFile(name)) return true;
  return false;
}

function walk(dir, base, list = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (shouldExcludeDir(e.name)) continue;
      walk(path.join(dir, e.name), base, list);
    } else if (e.isFile()) {
      if (shouldExcludeFile(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(base, abs).split(path.sep).join('/');
      list.push({ abs, rel });
    }
  }
  return list;
}

console.log('🚀 开始打包前端源码...');
console.log('   项目根:', projectRoot);
console.log('   排除目录:', [...EXCLUDE_DIRS].join(', '));
console.log('   排除规则: timestamp-*.mjs / .DS_Store / Thumbs.db');
console.log();

const t0 = Date.now();
const files = walk(projectRoot, projectRoot);

// 统计
const exts = {};
let totalSize = 0;
for (const f of files) {
  const ext = path.extname(f.abs) || '(no-ext)';
  exts[ext] = (exts[ext] || 0) + 1;
  totalSize += fs.statSync(f.abs).size;
}
console.log(`📦 共 ${files.length} 个文件，原始大小 ${(totalSize / 1024).toFixed(1)} KB`);
console.log('   文件类型分布:');
const sorted = Object.entries(exts).sort((a, b) => b[1] - a[1]);
for (const [ext, n] of sorted.slice(0, 15)) {
  console.log(`     ${ext.padEnd(10)} ${n}`);
}
console.log();

// 确保提交物目录存在
fs.mkdirSync(submitDir, { recursive: true });
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

// 用 .NET ZipFile 创建压缩包 — 通过 -EncodedCommand 传 Base64(UTF-16LE) 编码的命令，
// 完全绕开 PowerShell 5.1 默认 GBK 解析中文路径的坑
const listFile = path.join(submitDir, '.zip-files.txt');
fs.writeFileSync(listFile, files.map(f => f.abs).join('\n'), 'utf-8');

const psCmdText = [
  `Add-Type -AssemblyName System.IO.Compression`,
  `Add-Type -AssemblyName System.IO.Compression.FileSystem`,
  `$ErrorActionPreference = 'Stop'`,
  `$zipPath = '${zipPath.replace(/'/g, "''")}'`,
  `$root = '${projectRoot.replace(/'/g, "''")}'`,
  `$listFile = '${listFile.replace(/'/g, "''")}'`,
  `if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }`,
  // ZipArchiveMode::Create = 1
  `$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)`,
  `$count = 0`,
  `$rootLen = $root.Length + 1`,
  `foreach ($f in [System.IO.File]::ReadAllLines($listFile, [System.Text.Encoding]::UTF8)) {`,
  `    if ([string]::IsNullOrWhiteSpace($f)) { continue }`,
  `    $rel = $f.Substring($rootLen) -replace '\\\\', '/'`,
  `    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f, $rel, [System.IO.Compression.CompressionLevel]::Optimal)`,
  `    $count++`,
  `}`,
  `$zip.Dispose()`,
  `Write-Host ("Entries=" + $count)`,
  `Write-Host ("SizeKB=" + [Math]::Round((Get-Item -LiteralPath $zipPath).Length / 1KB, 1))`,
].join('\n');

// base64 编码（UTF-16LE）
const buf = Buffer.from(psCmdText, 'utf16le');
const b64 = buf.toString('base64');

console.log('⏳ 调用 PowerShell (-EncodedCommand) 压缩...');
try {
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], {
    stdio: 'inherit',
  });
} catch (e) {
  console.error('❌ 压缩失败:', e.message);
  fs.unlinkSync(listFile);
  process.exit(1);
}

fs.unlinkSync(listFile);

const elapsed = Date.now() - t0;
const zipSize = fs.statSync(zipPath).size;
console.log();
console.log('✅ 打包完成！');
console.log(`   📦 ${zipName}`);
console.log(`   路径: ${zipPath}`);
console.log(`   大小: ${(zipSize / 1024).toFixed(1)} KB (${(zipSize / 1024 / 1024).toFixed(2)} MB)`);
console.log(`   文件数: ${files.length}`);
console.log(`   压缩比: ${((1 - zipSize / totalSize) * 100).toFixed(1)}%`);
console.log(`   耗时: ${elapsed} ms`);