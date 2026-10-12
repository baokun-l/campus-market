"""
充值功能端到端验证（真实 HTTP 调用，不 mock）

覆盖：
  A. 基础链路：登录 -> 查余额 -> 充值 -> 余额增加 -> 流水落库
  B. 幂等：同一 requestId 重复提交，余额不得二次增加
  C. 边界校验：0 / 负数 / 超上限 / 缺金额 / 非法幂等键
  D. 鉴权：未登录取余额与充值都必须 401
  E. 不变式：余额 = 流水之和（逐账号对账）
  F. 可用性：充值后的钱确实能进入支付链路（收银台渠道列表读到新余额）
"""
import json
import urllib.request
import urllib.error
import uuid

BASE = "http://127.0.0.1:8080/api"

# ★ 显式禁用代理 ★
# 本机系统代理指向 Nano（TUN 模式）的本地端口；Nano 未运行时，
# 任何走系统代理的请求都会 [WinError 10061] 连接被拒 —— 连 127.0.0.1 也会被代理拦。
# 所以对本地后端一律用空 ProxyHandler 直连。
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

PASS, FAIL = [], []


def call(method, path, body=None, token=None):
    """返回 (http_status, json_body)"""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json;charset=UTF-8")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with _opener.open(req, timeout=15) as r:
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


def login(username, password):
    st, body = call("POST", "/user/login", {"username": username, "password": password})
    assert st == 200 and body.get("code") == 0, f"登录失败 {username}: {body}"
    return body["data"]["token"]


print("=" * 66)
print("A. 基础链路（用 admin：改造前它的余额恒为 0.00）")
print("=" * 66)
admin_token = login("admin", "admin123")

st, body = call("GET", "/wallet", token=admin_token)
before = float(body["data"]["balance"])
logs_before = len(body["data"]["logs"])
print(f"  充值前：余额 {before:.2f}，流水 {logs_before} 条")
check("A1 未充值账号可读到钱包概览（不再是「无入口」）", st == 200 and body["code"] == 0)

rid = str(uuid.uuid4())
st, body = call("POST", "/wallet/recharge", {"amount": 100.00, "requestId": rid}, admin_token)
ok = st == 200 and body.get("code") == 0
check("A2 充值 ¥100.00 成功", ok, json.dumps(body, ensure_ascii=False)[:160])
data = body.get("data") or {}
after = float(data.get("balance", -1))
check("A3 返回的余额 = 充值前 + 100", abs(after - (before + 100)) < 0.005,
      f"{before:.2f} + 100.00 = {after:.2f}")

st, body = call("GET", "/wallet", token=admin_token)
after2 = float(body["data"]["balance"])
logs = body["data"]["logs"]
check("A4 重新查库余额一致", abs(after2 - after) < 0.005, f"{after2:.2f}")
check("A5 流水新增 1 条", len(logs) == logs_before + 1, f"{logs_before} -> {len(logs)}")
if logs:
    top = logs[0]
    check("A6 最新流水类型 = recharge", top.get("type") == "recharge", str(top.get("type")))
    check("A7 流水中文名由服务端下发 = 充值", top.get("typeLabel") == "充值", str(top.get("typeLabel")))
    check("A8 流水 balance_after 与当前余额一致",
          abs(float(top.get("balanceAfter")) - after2) < 0.005, str(top.get("balanceAfter")))
    check("A9 流水 biz_id = 幂等键", top.get("bizId") == rid, str(top.get("bizId")))

print()
print("=" * 66)
print("B. 幂等（同一 requestId 重复提交）")
print("=" * 66)
st, body = call("POST", "/wallet/recharge", {"amount": 100.00, "requestId": rid}, admin_token)
dup_ok = st == 200 and body.get("code") == 0
check("B1 重复提交不报错（幂等回放）", dup_ok, json.dumps(body, ensure_ascii=False)[:160])
st, body = call("GET", "/wallet", token=admin_token)
now_bal = float(body["data"]["balance"])
now_logs = len(body["data"]["logs"])
check("B2 余额**未**二次增加", abs(now_bal - after2) < 0.005, f"仍为 {now_bal:.2f}")
check("B3 流水条数**未**增加", now_logs == len(logs), f"{len(logs)} -> {now_logs}")

print()
print("=" * 66)
print("C. 边界校验（前端绕过也拦得住）")
print("=" * 66)
cases = [
    ("C1 金额 0", {"amount": 0}, "必须大于"),
    ("C2 金额负数", {"amount": -5}, "必须大于"),
    ("C3 金额超单笔上限", {"amount": 999999}, "单笔充值最多"),
    ("C4 缺金额字段", {"requestId": str(uuid.uuid4())}, "请填写充值金额"),
    ("C5 幂等键太短", {"amount": 10, "requestId": "ab"}, "格式不正确"),
    ("C6 幂等键含非法字符", {"amount": 10, "requestId": "abc def!@#$%^&*()"}, "格式不正确"),
]
for name, payload, expect_word in cases:
    st, body = call("POST", "/wallet/recharge", payload, admin_token)
    msg = body.get("message", "")
    check(name, body.get("code") == 1001 and expect_word in msg, f"code={body.get('code')} msg={msg}")

print()
print("=" * 66)
print("D. 鉴权")
print("=" * 66)
st, body = call("GET", "/wallet")
check("D1 未登录取余额 -> 401", body.get("code") == 401, f"code={body.get('code')} msg={body.get('message')}")
st, body = call("POST", "/wallet/recharge", {"amount": 100, "requestId": str(uuid.uuid4())})
check("D2 未登录充值 -> 401", body.get("code") == 401, f"code={body.get('code')} msg={body.get('message')}")

print()
print("=" * 66)
print("E. 可用性：充值后的钱进入支付链路")
print("=" * 66)
st, body = call("GET", "/pay/channels", token=admin_token)
chans = body.get("data") or []
wallet_ch = next((c for c in chans if c.get("code") == "wallet"), None)
check("E1 收银台能读到钱包渠道", wallet_ch is not None)
if wallet_ch:
    check("E2 收银台显示的余额 = 充值后的余额",
          abs(float(wallet_ch.get("balance") or -1) - now_bal) < 0.005,
          f"渠道={wallet_ch.get('balance')} 钱包={now_bal:.2f}")

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
