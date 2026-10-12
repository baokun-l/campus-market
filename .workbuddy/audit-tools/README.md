# audit-tools · 一次性审计/探针脚本归档

本目录收集**跨会话可复用**的审计与红绿探针脚本。它们原先散落在 `C:/wbtmp/`（工作区之外），
换台机器就找不回来了，所以归档到这里。

> 这些脚本**不是**项目构建/测试流水线的一部分，跑不跑都不影响项目本体。
> 它们是「怎么查出来的」的留档 —— 当同一个缺陷形态再出现时，直接复用判据，不必重新发明。

## 脚本清单

| 脚本 | 用途 | 怎么跑 |
|---|---|---|
| `scan_mapper_params.py` | 扫 MyBatis XML 里引用了**方法参数命名空间之外**的名字（`#{pageSize}` 而方法签名只有 `@Param("query")`）。就是「导出当前筛选报 500」那类 `BindingException` 的根因形态 | `python scan_mapper_params.py <后端根>` |
| `scan_mapper_consistency.py` | 接口 ↔ XML 双向一致性：接口没 XML（且非 MP 内置方法）、XML 有悬空 `<include>`、重复 `<sql id>`、悬空 `resultMap` | 同上 |
| `scan_zero_ref_constants.py` | 语义常量（如 `TYPE_RECHARGE`）的**零调用方**扫描 —— 常量定义了却没人用，往往意味着「另一半没接线」 | 同上 |
| `verify_export_sort.py` | 对比「列表接口的排序」与「导出接口的排序」是否一致（曾出现导出忽略 `sort`） | `python verify_export_sort.py`（后端须在 8080） |
| `red-probe-auto-offline.sh` | **红绿探针**：把 `src/api/settings.ts` 的自动下架实现逐条改坏，证明 `settings.spec.ts` 真的抓得住（4 变体） | `bash red-probe-auto-offline.sh` |
| `red-probe-test-audit.sh` | **红绿探针**：把 `.vitest-report.json` 改坏，证明 `check-test-coverage.mjs` 真的能抓出「静默丢文件」（3 变体） | `bash red-probe-test-audit.sh`（需先 `npm run test:audit`） |

## ★ 两条纪律（都踩过）

### 1. 探针报红时，先证明「探针自己的前提成立」

`red-probe-auto-offline.sh` 的第一版用 Node 的 `spawnSync` 派生 vitest，四组变体**全部报「仍然是绿的」**。
看起来像「断言没有判别力」，实际是 `spawnSync` 直接抛 **EBUSY**（沙箱禁子进程派生），测试一次都没跑起来，
而解析逻辑把「没匹配到 `Tests` 行」当成了「0 failed」。

⇒ **不改用 Bash 驱动，并且显式判定「到底跑了没有」**：没有 `Tests` 行一律记 ERROR，不算通过。

同一形态在这个项目里一共出现五次（`spawnSync EBUSY`、vitest 的 ANSI 颜色码、
Vite 代理的 host、Element Plus 增减按钮监听 `mousedown`、`el-loading-mask` 遮挡点击），
**每一次都表现为「被测代码有缺陷」**。详见 `.workbuddy/memory/MEMORY.md` §16.5。

### 2. 扫描器先消除误报，再下结论

`scan_mapper_params.py` 迭代了三版才可用：
① 把 `test="sort == 'price_asc'"` 里的字符串字面量当成变量（14 个假问题）→
② 把 `query.sort` 拆成 `query` + `sort`（4 个假问题）→
③ 剩 **1 个真问题**（就是那个 `LIMIT #{pageSize}`）。

⇒ 如果第一版就报「发现 14 处」，这份报告的唯一后果是被人忽略。
**噪音比越高，真问题越容易被一起丢掉。**

## 依赖

- Python 脚本：`C:/Users/刘宝杰/.workbuddy/binaries/python/versions/3.13.12/python.exe`
- 假设后端仓库位于 `实践任务3：后端开发(前后端分离)/campus-secondhand-backend`
- 后端服务（`verify_export_sort.py`）默认连 `127.0.0.1:8080`，且需要 admin 账号在线
