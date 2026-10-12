"""
并发验证：证明唯一索引真的在并发下兜住了重复入账

★ 为什么必须单独测这一条 ★
业务层的「先查后写」在**顺序**重放下有效（见 verify_wallet_recharge.py 的 B 组），
但它在并发下是无效的：两个请求几乎同时进入，各自都查不到对方，于是都会加钱。
如果只测顺序重放就宣布"幂等做好了"，那是在用一个必然通过的用例
掩盖一个必然发生的缺陷 —— 用户连点两下余额翻倍，且对账链上看不出异常。
所以这里用真并发，并且刻意让 N 个请求带**同一个** requestId。

判定标准必须是「余额只增加 1 次」，而不是"没有报错"：
  · 允许部分请求以「重复提交」被拒（那是正确行为）
  · 但不允许余额增加超过 1 次（那是错账）
"""
import json
import threading
import urllib.request
import urllib.error
import uuid

BASE = "http://127.0.0.1:8080/api"
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

PASS, FAIL = [], []


def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json;charset=UTF-8")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with _opener.open(req, timeout=30) as r:
            raw = r.read().decode("utf-8")
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  [PASS] " if cond else "  [FAIL] ") + name + (("  -> " + detail) if detail else ""))


def login(u, p):
    st, b = call("POST", "/user/login", {"username": u, "password": p})
    assert b.get("code") == 0, b
    return b["data"]["token"]


def balance_of(token):
    st, b = call("GET", "/wallet", token=token)
    return float(b["data"]["balance"]), b["data"]["logs"]


print("=" * 66)
print("F. 并发重复提交（同一 requestId，N 个线程同时打）")
print("=" * 66)
token = login("lisi", "123456")
bal0, logs0 = balance_of(token)
n_recharge0 = sum(1 for l in logs0 if l.get("type") == "recharge")
print(f"  起始：余额 {bal0:.2f}，充值流水 {n_recharge0} 条")

N = 8
AMOUNT = 10.00
rid = str(uuid.uuid4())
results = [None] * N
barrier = threading.Barrier(N)


def worker(i):
    # 用屏障让 N 个请求尽可能同时发出，最大化竞争窗口
    barrier.wait()
    results[i] = call("POST", "/wallet/recharge", {"amount": AMOUNT, "requestId": rid}, token)


threads = [threading.Thread(target=worker, args=(i,)) for i in range(N)]
for t in threads:
    t.start()
for t in threads:
    t.join()

ok_cnt = sum(1 for r in results if r and r[1].get("code") == 0)
replay_cnt = sum(1 for r in results
                 if r and r[1].get("code") == 0
                 and "已处理" in (r[1].get("data") or {}).get("message", ""))
reject_cnt = sum(1 for r in results if r and r[1].get("code") != 0)
codes = sorted({(r[1].get("code") if r else "no-response") for r in results})
print(f"  发出 {N} 个并发请求（同一 requestId）")
print(f"  返回码集合：{codes}")
print(f"  成功 {ok_cnt}（其中幂等回放 {replay_cnt}），被拒 {reject_cnt}")

bal1, logs1 = balance_of(token)
n_recharge1 = sum(1 for l in logs1 if l.get("type") == "recharge")
delta = bal1 - bal0

check("F1 余额**只**增加了 1 次（不是 N 次）", abs(delta - AMOUNT) < 0.005,
      f"{bal0:.2f} -> {bal1:.2f}，增加了 {delta:.2f}（期望 {AMOUNT:.2f}）")
check("F2 充值流水**只**新增 1 条", n_recharge1 - n_recharge0 == 1,
      f"{n_recharge0} -> {n_recharge1}")
check("F3 所有请求都已返回（没有卡死/超时）", all(r is not None for r in results))
check("F4 返回码只在 0 / 1001 之间（没有冒成 500）",
      all((r[1].get("code") in (0, 1001)) for r in results if r),
      str(codes))

print()
print("=" * 66)
print("G. 对照组：并发但**不同** requestId —— 应当每一笔都入账")
print("=" * 66)
bal2, _ = balance_of(token)
N2 = 5
AMOUNT2 = 1.00
rids = [str(uuid.uuid4()) for _ in range(N2)]
res2 = [None] * N2
barrier2 = threading.Barrier(N2)


def worker2(i):
    barrier2.wait()
    res2[i] = call("POST", "/wallet/recharge", {"amount": AMOUNT2, "requestId": rids[i]}, token)


threads2 = [threading.Thread(target=worker2, args=(i,)) for i in range(N2)]
for t in threads2:
    t.start()
for t in threads2:
    t.join()

ok2 = sum(1 for r in res2 if r and r[1].get("code") == 0)
bal3, _ = balance_of(token)
delta2 = bal3 - bal2
check("G1 5 个不同键的并发充值全部成功", ok2 == N2, f"成功 {ok2}/{N2}")
check("G2 余额增加了 5 × 1.00", abs(delta2 - N2 * AMOUNT2) < 0.005,
      f"增加了 {delta2:.2f}（期望 {N2 * AMOUNT2:.2f}）")

print()
print("=" * 66)
print("汇总")
print("=" * 66)
print(f"  通过 {len(PASS)} / {len(PASS) + len(FAIL)}")
if FAIL:
    print("  失败项：")
    for f in FAIL:
        print("    - " + f)
    raise SystemExit(1)
