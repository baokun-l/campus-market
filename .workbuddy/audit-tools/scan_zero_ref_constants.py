# -*- coding: utf-8 -*-
"""
扫描「有定义、零调用方」的常量（TYPE_RECHARGE 的同类）。

真实案例：WalletLog.TYPE_RECHARGE = "recharge" 定义了、注释也写了、
t_wallet_log.type 列注释里也提到了，但**全仓零调用方** ——
于是「充值」这件事在界面上根本不存在（用户问「校园币在哪充值，为什么找不到」）。

这类「声明了但没实现」的判据很直接：常量名在整个 main/java 里只出现 1 次（就是定义那一行）。
"""
import glob
import os
import re
import sys
from collections import defaultdict

BASE = r"C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)\campus-secondhand-backend\src\main\java"

files = glob.glob(os.path.join(BASE, "**", "*.java"), recursive=True)
texts = {}
for f in files:
    texts[f] = open(f, encoding="utf-8").read()


def short(path):
    return os.path.relpath(path, BASE).replace("\\", "/")


# 只关心「语义常量」：字符串/整数型的 TYPE_ / STATUS_ / ACTION_ / ROLE_ 等
PAT = re.compile(
    r'(?:public\s+)?static\s+final\s+(String|int|Integer)\s+'
    r'((?:TYPE|STATUS|ACTION|ROLE|LEVEL|CHANNEL|KIND|STATE|MODE)_\w+)\s*=\s*([^;]+);'
)

defined = []
for f, t in texts.items():
    for m in PAT.finditer(t):
        line_no = t[:m.start()].count("\n") + 1
        defined.append((f, line_no, m.group(2), m.group(3).strip()))

zero = []
one = []
for f, line_no, name, value in defined:
    uses = []
    for g, t in texts.items():
        for i, ln in enumerate(t.split("\n"), 1):
            if name in ln:
                uses.append((g, i, ln.strip()))
    # 定义行本身算一次
    if len(uses) <= 1:
        zero.append((f, line_no, name, value))
    elif len(uses) == 2:
        one.append((f, line_no, name, value, uses))

print("=" * 80)
print("扫描 %d 个 Java 文件，找到 %d 个语义常量定义" % (len(files), len(defined)))
print("=" * 80)

print("\n### 零调用方（只有定义这一行）—— %d 处\n" % len(zero))
if not zero:
    print("  (无)")
for f, line_no, name, value in zero:
    print("  %s:%d" % (short(f), line_no))
    print("      %s = %s" % (name, value))

print("\n### 仅 1 处使用（定义 + 1 次引用，需人工看是不是自引用）—— %d 处\n" % len(one))
for f, line_no, name, value, uses in one:
    print("  %s = %s" % (name, value))
    for g, i, ln in uses:
        print("      %s:%d  %s" % (short(g), i, ln[:88]))

sys.exit(0)
