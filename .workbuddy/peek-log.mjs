import fs from 'node:fs';
const p = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)\.workbuddy\mvn-clear-test.log`;
const t = fs.readFileSync(p, 'utf8');
const lines = t.split(/\r?\n/);
const keep = lines.filter(l => /ERROR|BUILD|Tests run|FAIL|Compil|\.java:\[/.test(l));
console.log(keep.slice(0, 150).join('\n'));
console.log('---TOTAL LINES---', lines.length);
if (keep.length === 0) {
  console.log('---HEAD 40---');
  console.log(lines.slice(0, 40).join('\n'));
}
