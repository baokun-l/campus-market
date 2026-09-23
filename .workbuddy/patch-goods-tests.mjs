import fs from 'node:fs';
import path from 'node:path';

const dir = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)\campus-secondhand-backend\src\test\java\com\campus\market\service`;
const files = [
  'GoodsServicePublishLimitTest.java',
  'GoodsServiceVisibilityTest.java',
  'GoodsServiceBatchStatusTest.java',
  'GoodsServiceViewCountTest.java',
  'GoodsServicePromoPricingTest.java',
];

for (const f of files) {
  const p = path.join(dir, f);
  let t = fs.readFileSync(p, 'utf8');
  if (t.includes('CommentMapper')) {
    console.log('SKIP (already patched): ' + f);
    continue;
  }
  const before = t;
  t = t.replace(
    'import com.campus.market.mapper.CategoryMapper;\n',
    'import com.campus.market.mapper.CategoryMapper;\nimport com.campus.market.mapper.CommentMapper;\n'
  );
  t = t.replace(
    'import com.campus.market.mapper.HistoryMapper;\n',
    'import com.campus.market.mapper.HistoryMapper;\nimport com.campus.market.mapper.ReviewMapper;\n'
  );
  t = t.replace(
    /( *)mock\(HistoryMapper\.class\),\r?\n/,
    '$1mock(HistoryMapper.class),\n$1mock(CommentMapper.class),\n$1mock(ReviewMapper.class),\n'
  );
  const okImport = t.includes('import com.campus.market.mapper.CommentMapper;')
    && t.includes('import com.campus.market.mapper.ReviewMapper;');
  const okArgs = t.includes('mock(CommentMapper.class),') && t.includes('mock(ReviewMapper.class),');
  if (!okImport || !okArgs) {
    console.log(`FAIL ${f}: import=${okImport} args=${okArgs}`);
    continue;
  }
  fs.writeFileSync(p, t, 'utf8');
  console.log(`PATCHED ${f}  (+${t.length - before.length} chars)`);
}
