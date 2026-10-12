# -*- coding: utf-8 -*-
"""
列表 vs 导出：同口径校验（筛选 + 排序都要一致）。

「导出当前筛选」的语义是「导出我正在看的那批数据」，
所以导出结果的**顺序**必须与列表页一致 —— 否则管理员选了「金额降序」，
拿到的 CSV 却是时间降序，数据一条没少但看着像导错了。
"""
import json
import sys
import urllib.request

API = "http://127.0.0.1:8080/api"

# ★ 必须用无代理 opener：本机系统代理指向 Nano 的 127.0.0.1:65532，
#   Nano 没运行时连 127.0.0.1 都会被拒（WinError 10061）。
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Cookie", "c2c-token=" + token)
    with opener.open(req, timeout=15) as r:
        return json.loads(r.read().decode())


def main():
    tok = call("POST", "/user/login", {"username": "admin", "password": "admin123"})["data"]["token"]
    fails = 0
    total = 0

    print("=" * 74)
    print("A. 排序一致性（列表前 5 条 vs 导出前 5 条，金额序列必须一致）")
    print("=" * 74)
    for sort in ("amount_desc", "amount_asc", "time_asc", ""):
        qs = ("&sort=" + sort) if sort else ""
        rows_l = call("GET", "/admin/orders?page=1&pageSize=5" + qs, token=tok)["data"]["list"]
        rows_e = call("GET", "/admin/orders/export" + (("?sort=" + sort) if sort else ""), token=tok)["data"]
        a = [float(r.get("amount") or 0) for r in rows_l]
        b = [float(r.get("amount") or 0) for r in rows_e[:5]]
        total += 1
        ok = a == b
        if not ok:
            fails += 1
        print("  sort=%-12s 列表 %s" % (sort or "(默认)", " ".join("%9.2f" % x for x in a)))
        print("  %-17s 导出 %s   %s" % ("", " ".join("%9.2f" % x for x in b), "一致 ✓" if ok else "!! 不一致"))

    print()
    print("=" * 74)
    print("B. 行数口径（导出行数 == 列表 total，多值筛选 + 金额区间）")
    print("=" * 74)
    filters = "statusIn%5B%5D=completed&statusIn%5B%5D=shipped&minAmount=1&maxAmount=99999"
    lst = call("GET", "/admin/orders?page=1&pageSize=200&" + filters, token=tok)["data"]
    exp = call("GET", "/admin/orders/export?" + filters, token=tok)["data"]
    total += 1
    ok = lst["total"] == len(exp)
    if not ok:
        fails += 1
    print("  列表 total = %s，导出行数 = %s   %s" % (lst["total"], len(exp), "一致 ✓" if ok else "!! 不一致"))

    print()
    print("=" * 74)
    print("不一致项 = %d / 检查项 = %d" % (fails, total))
    print("=" * 74)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
