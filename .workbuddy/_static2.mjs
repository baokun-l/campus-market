const fs = require('fs');
const { execFileSync } = require('child_process');
const backend = 'C:/Users/刘宝杰/Desktop/软件开发项目实践/软件开发/实践任务3：后端开发(前后端分离)/campus-secondhand-backend/';
const rel = 'target/classes/com/campus/market/service/GoodsService.class';
const jar = backend + 'target/campus-secondhand-backend-1.0.0.jar';
const cls = backend + rel;

console.log('SRC_MTIME   ', fs.statSync(backend + 'src/main/java/com/campus/market/service/GoodsService.java').mtimeMs);
console.log('CLASS_MTIME ', fs.statSync(cls).mtimeMs);
console.log('JAR_MTIME   ', fs.statSync(jar).mtimeMs);

const buf = fs.readFileSync(cls);
console.log('CLASS_LEN  ', buf.length);
console.log('FIX_PENDING_GUARD ', buf.indexOf(Buffer.from('选中的商品中有', 'utf8')) >= 0);
console.log('FIX_WHITELIST     ', buf.indexOf(Buffer.from('商品状态', 'utf8')) >= 0);

// extract jar's embedded class and compare
const tmp = backend + 'target/_gs_jar.class';
try {
  execFileSync('jar', ['xf', jar, 'BOOT-INF/classes/com/campus/market/service/GoodsService.class'], { cwd: backend + 'target' });
  const jb = fs.readFileSync(tmp);
  console.log('JAR_CLASS_LEN', jb.length);
  console.log('JAR_FIX_PENDING_GUARD', jb.indexOf(Buffer.from('选中的商品中有', 'utf8')) >= 0);
  console.log('JAR_CLASS_MATCHES_TARGETCLASS', jb.length === buf.length);
} catch (e) {
  console.log('JAR_EXTRACT_ERR', e.message);
}
