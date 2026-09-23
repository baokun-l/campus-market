// 给「构造 UserService」的单测补上新增的 LoginAttemptGuard 参数 + import
// 背景：UserService 用 @RequiredArgsConstructor，加字段 = 改构造器签名，
//       所有 new UserService(...) 的用例都会编译不过，必须同步补参。
import fs from 'node:fs';

const dir = 'C:/Users/刘宝杰/Desktop/软件开发项目实践/软件开发/实践任务3：后端开发(前后端分离)'
  + '/campus-secondhand-backend/src/test/java/com/campus/market/service';

const files = [
  'RegisterAndDeleteCascadeTest.java',
  'UserServiceFavoriteTest.java',
  'UserServiceGuardTest.java',
  'UserServiceOnlineTest.java',
  'UserServiceProfileTest.java',
];

const IMPORT = 'import com.campus.market.security.LoginAttemptGuard;';

for (const f of files) {
  const p = dir + '/' + f;
  let src = fs.readFileSync(p, 'utf8');
  const before = src;

  // 1) 补 import（插在第一条「非 com.campus.market.*」的 import 之前，保持同组相邻）
  if (!src.includes(IMPORT)) {
    const lines = src.split(/\r?\n/);
    const idx = lines.findIndex(l => /^import\s/.test(l) && !/^import com\.campus\.market\./.test(l));
    if (idx < 0) { console.log('SKIP(no import anchor) ' + f); continue; }
    lines.splice(idx, 0, IMPORT);
    src = lines.join('\n');
  }

  // 2) 只在 new UserService( 之后的第一处 JwtConfig 实参后面追加一个实参
  const anchor = src.indexOf('new UserService(');
  if (anchor < 0) { console.log('SKIP(no ctor) ' + f); continue; }
  const head = src.slice(0, anchor);
  let tail = src.slice(anchor);
  const re = /(\n\s*)mock\(((?:com\.campus\.market\.config\.)?JwtConfig)\.class\)\);/;
  if (!re.test(tail)) { console.log('SKIP(no jwt arg) ' + f); continue; }
  tail = tail.replace(re, (m, indent, jc) =>
    `${indent}mock(${jc}.class),\n${indent}mock(LoginAttemptGuard.class));`);
  src = head + tail;

  if (src === before) {
    console.log('UNCHANGED ' + f);
    continue;
  }
  fs.writeFileSync(p, src, 'utf8');
  console.log('PATCHED   ' + f + '  (+import:' + (before.includes(IMPORT) ? 'already' : 'yes') + ')');
}
