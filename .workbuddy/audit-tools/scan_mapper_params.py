# -*- coding: utf-8 -*-
"""
扫描 MyBatis Mapper：找出 XML 里引用了「参数命名空间之外」的标识符。

背景：MyBatis 的规则是 ——
  · 方法参数上只要出现 >=1 个 @Param，参数就被整体「命名」，
    可用名 = 所有 @Param 的值 + param1..paramN；
    此时 XML 里 `#{foo}` 的 foo 必须是这些名字之一，否则抛
    BindingException: Parameter 'foo' not found.
  · 方法参数个数 == 1 且无 @Param 时，MyBatis 会把该参数直接展开
    （Map 展开成键、POJO 展开成属性），`#{任意名}` 都能取到 —— 这类放行。

本脚本交叉比对 Java 接口签名与 XML 引用，输出「必然取不到」的引用。
"""
import re
import os
import glob
import sys

BASE = r"C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)\campus-secondhand-backend\src\main"
XML_DIR = os.path.join(BASE, "resources", "mapper")
JAVA_DIR = os.path.join(BASE, "java", "com", "campus", "market", "mapper")


def split_params(params: str):
    """按顶层逗号切分参数列表（忽略泛型 <> 里的逗号）"""
    out, cur, depth = [], "", 0
    for ch in params:
        if ch == '<':
            depth += 1
        elif ch == '>':
            depth -= 1
        if ch == ',' and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        out.append(cur)
    return [p.strip() for p in out if p.strip()]


def parse_java():
    """接口名 -> {方法名: {'names': 可用参数名集合, 'expandable': 是否单参展开}}"""
    result = {}
    for f in glob.glob(os.path.join(JAVA_DIR, "*.java")):
        src = open(f, encoding="utf-8").read()
        cls = re.search(r"public\s+interface\s+(\w+)", src)
        if not cls:
            continue
        name = cls.group(1)
        methods = {}
        for m in re.finditer(r"([\w<>,\s\[\]\.]+?)\s+(\w+)\s*\(([^;{]*?)\)\s*;", src):
            ret, mname, params = m.group(1).strip(), m.group(2), m.group(3).strip()
            if mname in ("if", "for", "while", "return", "new"):
                continue
            plist = split_params(params)
            pnames, has_ann = [], False
            for p in plist:
                am = re.search(r'@Param\(\s*"([^"]+)"\s*\)', p)
                if am:
                    has_ann = True
                    pnames.append(am.group(1))
                else:
                    nm = re.findall(r"(\w+)\s*$", p)
                    pnames.append(nm[0] if nm else "?")
            names = set(pnames)
            for i in range(1, len(plist) + 1):
                names.add("param%d" % i)
            # ★ 单参数且无 @Param：MyBatis 直接展开该参数，任意名都可取
            expandable = (len(plist) == 1 and not has_ann)
            methods[mname] = {"names": names, "expandable": expandable, "raw": pnames}
        result[name] = methods
    return result


def scan():
    iface = parse_java()
    problems = []
    checked = 0
    for path in sorted(glob.glob(os.path.join(XML_DIR, "*.xml"))):
        text = open(path, encoding="utf-8").read()
        lines = text.split("\n")
        ns = re.search(r'namespace="([\w\.]+)"', text)
        if not ns:
            continue
        simple = ns.group(1).split(".")[-1]
        methods = iface.get(simple, {})

        # 记录每个 statement 所在行 & foreach 里的局部变量（这些是合法的作用域内变量）
        cur_id = None
        local_vars = set()
        for lineno, ln in enumerate(lines, 1):
            sm = re.search(r'<(select|insert|update|delete)\s+id="(\w+)"', ln)
            if sm:
                cur_id = sm.group(2)
                local_vars = set()
            # foreach 的 item / index 是局部变量
            for fm in re.finditer(r'<foreach[^>]*\bitem="(\w+)"', ln):
                local_vars.add(fm.group(1))
            for fm in re.finditer(r'<foreach[^>]*\bindex="(\w+)"', ln):
                local_vars.add(fm.group(1))
            # bind 也引入局部变量
            for bm in re.finditer(r'<bind[^>]*\bname="(\w+)"', ln):
                local_vars.add(bm.group(1))

            if not cur_id or cur_id not in methods:
                continue
            info = methods[cur_id]
            if info["expandable"]:
                continue  # 单参数展开，跳过

            refs = []
            for expr in re.findall(r"#\{([^}]*)\}", ln):
                refs.append(expr.split(",")[0].strip())
            for expr in re.findall(r"\$\{([^}]*)\}", ln):
                refs.append(expr.split(",")[0].strip())
            # <if test="..."> / <when test="..."> 里的 OGNL 变量同样受限。
            # ★ 必须先剔除引号内的字符串字面量（'price_asc' 是常量不是变量），
            #   再剔除后面紧跟 '(' 的方法名（statuses.size() 里的 size）。
            #   不剔除就会产生大量误报，掩盖真正的那一处。
            for tm in re.finditer(r'test="([^"]*)"', ln):
                expr = re.sub(r"'[^']*'", " ", tm.group(1))
                expr = re.sub(r'"[^"]*"', " ", expr)
                # 抓「完整的属性链」（query.sort 作为一个整体），
                # 否则属性名 sort 会被误当成独立变量，产生假阳性。
                for mm in re.finditer(r"[a-zA-Z_]\w*(?:\.\w+)*", expr):
                    if expr[mm.end():].lstrip().startswith("("):
                        continue  # 方法调用形态，如 statuses.size()
                    refs.append(mm.group(0))

            for ref in refs:
                if not ref:
                    continue
                root = ref.split(".")[0].split("(")[0].strip()
                if not root or not re.match(r"^[a-zA-Z_]\w*$", root):
                    continue
                if root in ("null", "true", "false", "and", "or", "not"):
                    continue
                if root in info["names"] or root in local_vars:
                    continue
                checked += 1
                problems.append((os.path.basename(path), lineno, cur_id, ref.strip(), sorted(info["names"]), info["raw"]))
    return problems, checked


if __name__ == "__main__":
    problems, checked = scan()
    print("=" * 78)
    print("扫描范围：%s" % XML_DIR)
    print("发现的非法引用：%d 处" % len(problems))
    print("=" * 78)
    for f, ln, sid, ref, names, raw in problems:
        print("\n[%s:%d]  statement id = %s" % (f, ln, sid))
        print("    引用  -> #{ %s }" % ref)
        print("    可用名 -> %s" % names)
        print("    方法签名参数 -> %s" % raw)
    if not problems:
        print("(无)")
    sys.exit(0)
