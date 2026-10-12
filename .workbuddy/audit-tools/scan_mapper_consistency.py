# -*- coding: utf-8 -*-
"""
Mapper 接口 ↔ XML 双向一致性扫描。

上一轮只查了「XML 里的 #{} 引用了参数命名空间外的名字」（BindingException）；
本脚本查其余的同类缺口：

  A. 接口有方法、XML 无对应语句  → 调用时 Invalid bound statement (not found)
     ★ 与 BindingException 一样：只在走到那条语句时才炸，
       同样被 GlobalExceptionHandler 兜底脱敏成「服务器内部错误」，同样与 SQL 无关。
  B. XML 有语句、接口无对应方法  → 死语句；若 id 拼错则方向反过来变成 A
  C. <include refid="X"/> 指向不存在的片段 → XML 解析期就失败（启动即炸，风险低但仍报）
  D. resultMap / resultType / parameterType 指向不存在的类或未定义的 resultMap

误报控制（本项目实际形态）：
  · 接口继承 BaseMapper<T> ⇒ MP 内置方法（selectById/insert/updateById…）不需要 XML
  · 方法带 @Select/@Insert/@Update/@Delete 注解 ⇒ 走注解，不需要 XML
  · default 方法 ⇒ 自带实现，不需要 XML
"""
import glob
import os
import re
import sys

BASE = r"C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)\campus-secondhand-backend\src\main"
JAVA_DIR = os.path.join(BASE, "java", "com", "campus", "market", "mapper")
XML_DIR = os.path.join(BASE, "resources", "mapper")
JAVA_ROOT = os.path.join(BASE, "java")

# MyBatis-Plus BaseMapper 提供的方法：不需要 XML
MP_BUILTIN = {
    "insert", "deleteById", "deleteByMap", "delete", "deleteBatchIds",
    "updateById", "update", "selectById", "selectBatchIds", "selectByMap",
    "selectOne", "selectCount", "selectList", "selectMaps", "selectObjs",
    "selectPage", "selectMapsPage", "exists",
}
ANNOTATION_SQL = ("@Select", "@Insert", "@Update", "@Delete", "@SelectProvider",
                  "@InsertProvider", "@UpdateProvider", "@DeleteProvider")


def split_params(params: str):
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


def parse_interfaces():
    """接口名 -> {'methods': {名: 是否 default}, 'extends_base': bool}"""
    result = {}
    for f in glob.glob(os.path.join(JAVA_DIR, "*.java")):
        src = open(f, encoding="utf-8").read()
        cls = re.search(r"public\s+interface\s+(\w+)([^{]*)\{", src)
        if not cls:
            continue
        name, header = cls.group(1), cls.group(2)
        extends_base = "BaseMapper" in header

        body = src[cls.end():]
        methods = {}
        # 逐条抓方法声明（含其前面的注解块）
        for m in re.finditer(r"((?:@\w+(?:\([^)]*\))?\s*)*)([\w<>,\s\[\]\.]+?)\s+(\w+)\s*\(([^;{]*?)\)\s*(;|\{)", body):
            anns, mname, tail = m.group(1) or "", m.group(3), m.group(5)
            if mname in ("if", "for", "while", "return", "new", "public"):
                continue
            annotated = any(a in anns for a in ANNOTATION_SQL)
            is_default = tail == "{" or "default" in m.group(2)
            methods[mname] = {"annotated": annotated, "default": is_default}
        result[name] = {"methods": methods, "extends_base": extends_base}
    return result


def java_types_exist():
    """收集所有已定义的类名（含内部类），用于校验 resultType / parameterType"""
    names = set()
    for f in glob.glob(os.path.join(JAVA_ROOT, "**", "*.java"), recursive=True):
        src = open(f, encoding="utf-8").read()
        for m in re.finditer(r"\b(?:class|interface|enum|record)\s+(\w+)", src):
            names.add(m.group(1))
    return names


def main():
    ifaces = parse_interfaces()
    types = java_types_exist()
    problems = []
    stats = {"ifs": 0, "xml_ifaces": 0, "stmts": 0, "custom_methods": 0}

    xml_by_ns = {}
    for path in sorted(glob.glob(os.path.join(XML_DIR, "*.xml"))):
        text = open(path, encoding="utf-8").read()
        ns = re.search(r'namespace="([\w.]+)"', text)
        if not ns:
            problems.append(("C", os.path.basename(path), "XML 缺少 namespace 属性"))
            continue
        ns = ns.group(1)
        simple = ns.split(".")[-1]
        xml_by_ns[simple] = (os.path.basename(path), text)
        stats["xml_ifaces"] += 1

        # 片段定义
        fragments = set(re.findall(r'<sql\s+id="(\w+)"', text))
        # resultMap 定义
        result_maps = set(re.findall(r'<resultMap\s+[^>]*id="(\w+)"', text))
        # 语句 id
        stmts = dict(re.findall(r'<(select|insert|update|delete)\s+id="(\w+)"', text))
        # 同一文件内 id 重复（MyBatis 解析期即失败）
        all_ids = re.findall(r'<(?:select|insert|update|delete)\s+id="(\w+)"', text)
        for dup in sorted({i for i in all_ids if all_ids.count(i) > 1}):
            problems.append(("C", os.path.basename(path), "语句 id=\"%s\" 在同一文件中重复定义" % dup))

        # C. include 悬空
        for ref in re.findall(r'<include\s+refid="(\w+)"', text):
            if ref not in fragments:
                problems.append(("C", os.path.basename(path),
                                 "<include refid=\"%s\"/> 指向不存在的 <sql> 片段" % ref))

        # D. resultMap / resultType
        for rm in re.findall(r'\bresultMap="(\w+)"', text):
            if rm not in result_maps and not rm.startswith("mybatis-plus_"):
                problems.append(("D", os.path.basename(path),
                                 "resultMap=\"%s\" 未在本文件定义" % rm))
        for rt in re.findall(r'\b(?:resultType|parameterType)="([\w.$]+)"', text):
            if rt.startswith("java.") or rt.startswith("map") or rt.startswith("int") \
               or rt.startswith("long") or rt.startswith("string") or rt.startswith("boolean"):
                continue
            if rt.startswith("com.") and rt.split(".")[-1] not in types:
                problems.append(("D", os.path.basename(path),
                                 "resultType/parameterType=\"%s\" 指向不存在的类" % rt))

    # A / B：接口 ↔ XML 语句双向
    for iname, info in ifaces.items():
        stats["ifs"] += 1
        if iname not in xml_by_ns:
            # ★ 不能直接跳过：没有 XML 的接口必须**确实**只用了 MP 内置方法，
            #   否则同样会 Invalid bound statement。这才是真正的盲区。
            orphans = [
                m for m, mi in info["methods"].items()
                if not mi["annotated"] and not mi["default"]
                and not (info["extends_base"] and m in MP_BUILTIN)
            ]
            if orphans:
                problems.append(("A", iname + ".java",
                                 "接口没有 XML 文件，但这些方法既无 @Select 等注解、又不是 MP 内置方法：%s"
                                 % ", ".join(sorted(orphans))))
            else:
                stats["no_xml_ok"] = stats.get("no_xml_ok", 0) + 1
            continue
        fname, text = xml_by_ns[iname]
        stmt_ids = set(m.group(2) for m in re.finditer(r'<(select|insert|update|delete)\s+id="(\w+)"', text))
        stats["stmts"] += len(stmt_ids)

        for mname, minfo in info["methods"].items():
            if minfo["annotated"] or minfo["default"]:
                continue
            if info["extends_base"] and mname in MP_BUILTIN:
                continue
            stats["custom_methods"] += 1
            if mname not in stmt_ids:
                problems.append(("A", fname,
                                 "接口方法 %s() 在 XML 里没有对应语句 → 调用时 Invalid bound statement (not found)" % mname))

        iface_methods = set(info["methods"].keys())
        for sid in sorted(stmt_ids):
            if sid not in iface_methods:
                problems.append(("B", fname, "XML 语句 id=\"%s\" 在接口 %s 里没有对应方法" % (sid, iname)))

    print("=" * 80)
    print("扫描统计：接口 %d 个，带 XML 的接口 %d 个，XML 语句 %d 条，需 XML 的自定义方法 %d 个"
          % (stats["ifs"], stats["xml_ifaces"], stats["stmts"], stats["custom_methods"]))
    print("=" * 80)
    if not problems:
        print("\n未发现 A/B/C/D 四类缺口。")
        return 0

    print("\n发现 %d 处问题：" % len(problems))
    for kind, where, msg in problems:
        print("\n  [%s] %s" % (kind, where))
        print("      %s" % msg)
    return 1


if __name__ == "__main__":
    sys.exit(main())
