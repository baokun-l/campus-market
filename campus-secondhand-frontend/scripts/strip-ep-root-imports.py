"""清理 element-plus 根入口的冗余运行时导入。

背景
----
element-plus 的 es/index.mjs 默认导出一个「安装全部组件的 installer」，
因此只要从根入口 import 任何东西（哪怕只是 ElMessage），
整个组件库都会被拉进依赖图且无法被 tree-shaking 删除。

项目已在 vite.config.ts 配置 unplugin-auto-import + ElementPlusResolver，
这些运行时 API 会被自动按需注入，手写导入纯属冗余。

处理规则
--------
1) 纯运行时导入  → 整行删除，交给自动导入
2) 运行时 + 类型混写 → 保留为 `import type { ... }`（类型在编译后消失，零打包开销）
"""
import io
import os
import re
import sys

PATTERN = re.compile(
    r"^(\s*)import\s*\{([^}]*)\}\s*from\s*['\"]element-plus['\"]\s*$"
)

changed = []

for root, _dirs, files in os.walk('src'):
    for name in files:
        if not name.endswith(('.ts', '.vue')):
            continue
        path = os.path.join(root, name)
        src = io.open(path, encoding='utf-8').read()
        out = []
        hit = False
        for line in src.split('\n'):
            m = PATTERN.match(line)
            if not m:
                out.append(line)
                continue
            indent, body = m.group(1), m.group(2)
            parts = [x.strip() for x in body.split(',') if x.strip()]
            types = [x[len('type '):].strip() for x in parts if x.startswith('type ')]
            hit = True
            if types:
                out.append("%simport type { %s } from 'element-plus'" % (indent, ', '.join(types)))
        if hit:
            io.open(path, 'w', encoding='utf-8').write('\n'.join(out))
            changed.append(path)

print('已清理文件数: %d' % len(changed))
for c in sorted(changed):
    print('   ' + c.replace(os.sep, '/'))
