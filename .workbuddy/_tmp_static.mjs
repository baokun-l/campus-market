const fs = require('fs');
const P = 'C:/Users/刘宝杰/Desktop/软件开发项目实践/软件开发/实践任务3：后端开发(前后端分离)/.workbuddy/_tmp_static.out';
const base = 'C:/Users/刘宝杰/Desktop/软件开发项目实践/软件开发/实践任务3：后端开发(前后端分离)/campus-secondhand-backend/';
const log = s => fs.appendFileSync(P, s + '\n');
fs.writeFileSync(P, '');
const classF = base + 'target/classes/com/campus/market/service/GoodsService.class';
const srcF = base + 'src/main/java/com/campus/market/service/GoodsService.java';
const jarF = base + 'target/campus-secondhand-backend-1.0.0.jar';
try { log('src mtime   = ' + fs.statSync(srcF).mtimeMs); } catch(e){ log('src MISSING'); }
try { log('class mtime = ' + fs.statSync(classF).mtimeMs); } catch(e){ log('class MISSING ' + e.message); }
try { log('jar mtime   = ' + fs.statSync(jarF).mtimeMs); } catch(e){ log('jar MISSING'); }
// static check: does compiled class contain the fix string?
try {
  const buf = fs.readFileSync(classF);
  const needle = Buffer.from('选中的商品中有', 'utf8');
  const idx = buf.indexOf(needle);
  log('class contains fix-string "选中的商品中有": ' + (idx >= 0 ? 'YES (offset ' + idx + ')' : 'NO'));
  const needle2 = Buffer.from('批量修改商品状态', 'utf8');
  log('class contains "批量修改商品状态": ' + (buf.indexOf(needle2) >= 0 ? 'YES' : 'NO'));
} catch(e){ log('read class ERR ' + e.message); }
// jar main class
try {
  const { execFileSync } = require('child_process');
  const out = execFileSync('C:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe', ['--version'], {encoding:'utf8'}).toString();
  // not needed; just probe jar manifest via node unzip-free: read last bytes? skip.
} catch(e){}
log('end');
