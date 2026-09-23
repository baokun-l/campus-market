/**
 * P1-11（鉴权快照缓存）+ D9（HttpOnly Cookie）+ P2-3（vite base）文档销项。
 *
 * 纪律（沿用本仓 apply-*-docs 的约定）：
 *  1. 每处替换都要求锚点**恰好命中 1 次**，命中数不对就整体不写、退出码 2（原子：先全读进内存，最后统一写盘）；
 *  2. **幂等**：靠 marker 判断「这一处是否已经写过」，重复跑不产生重复节；
 *  3. 写完**回读自证**：确认新节真的在文件里、且旧结论确实被改掉（不是"我以为改了"）；
 *  4. marker 必须选**只有本次替换才会写出的**独特字样（踩过「marker 撞车导致静默跳过」）。
 *
 * 用法：node .workbuddy/apply-p111d9-docs.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BE = path.join(ROOT, 'campus-secondhand-backend');

const F_CLIST = path.join(BE, 'docs', '服务器部署适配清单.md');
const F_DESIGN = path.join(BE, 'docs', '后端设计说明.md');
const F_FIX = path.join(ROOT, '项目缺陷检查与修复清单.md');
const F_REPORT = path.join(ROOT, '缺陷清单逐条核对报告.md');
const F_README = path.join(BE, 'README.md');

const read = (f) => fs.readFileSync(f, 'utf8');
let problems = 0;
const done = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); problems++; };

const touched = new Map();
const get = (f) => { if (!touched.has(f)) touched.set(f, read(f)); return touched.get(f); };
const set = (f, s) => touched.set(f, s);

function replaceOnce(file, from, to, marker) {
    const txt = get(file);
    if (txt.includes(marker)) { console.log(`  – 已存在，跳过：${path.basename(file)} :: ${marker.slice(0, 40)}…`); return; }
    const n = txt.split(from).length - 1;
    if (n !== 1) throw new Error(`${path.basename(file)} 锚点命中 ${n} 次（要求 1）：${from.slice(0, 70)}…`);
    set(file, txt.replace(from, to));
    done(`${path.basename(file)} ← ${marker.slice(0, 50)}`);
}
function insertBefore(file, anchor, block, marker) { replaceOnce(file, anchor, block + anchor, marker); }
function appendAtEnd(file, block, marker) {
    const txt = get(file);
    if (txt.includes(marker)) { console.log(`  – 已存在，跳过：${path.basename(file)} :: ${marker.slice(0, 40)}…`); return; }
    set(file, (txt.endsWith('\n') ? txt : txt + '\n') + block);
    done(`${path.basename(file)} ← 追加 ${marker.slice(0, 50)}`);
}

/* ==========================================================================
 * 1) docs/服务器部署适配清单.md
 * ========================================================================== */

// —— P1-11 证据块：三层 → 四层（补真机）
replaceOnce(F_CLIST, '> 证据（三层）：\n', '> 证据（四层）：\n', '> 证据（四层）：');
replaceOnce(F_CLIST,
    '> - 判据红绿：审计里这一项从「只看 pom 有没有 caffeine」改成锚能力（依赖 + 拦截器经缓存\n'
    + '>   + 不再直查 + TTL 兜底 + 失效点 ≥6）。\n',
    '> - 判据红绿：审计里这一项从「只看 pom 有没有 caffeine」改成锚能力（依赖 + 拦截器经缓存\n'
    + '>   + 不再直查 + TTL 兜底 + 失效点 ≥6）；\n'
    + '> - 真机 `.workbuddy/e2e-p111.mjs` 跑**两个产物**（两侧各 **16 PASS / 0 FAIL**）：\n'
    + '>   修复后 `a9b773315108` 下「直改库封禁后 28ms 仍放行、8.3 秒后才转 401」；\n'
    + '>   修复前 `cbdf3841d484` 下**同一判据 12ms 就直接 401** ⇒ 「缓存存在」这项能力确实随版本出现。\n'
    + '>   详见 §7.10。\n',
    '> - 真机 `.workbuddy/e2e-p111.mjs` 跑**两个产物**');

// —— 原始「改法」与最终实现不一致，就地订正（否则同一页里「5~30 秒」与「10 秒」自相矛盾）
replaceOnce(F_CLIST,
    '- **改法**：加 `spring-boot-starter-cache` + Caffeine，给这次回查加 **5~30 秒 TTL 的本地缓存**，\n'
    + '  并在封禁/改密/改角色时**主动失效**该 key。\n',
    '- **改法（原建议）**：加 `spring-boot-starter-cache` + Caffeine，给这次回查加 **5~30 秒 TTL 的本地缓存**，\n'
    + '  并在封禁/改密/改角色时**主动失效**该 key。\n'
    + '  ▲ **落地时的两处订正**（理由见本节开头的 ✅ 块与 §7.10）：\n'
    + '  ① **不引** `spring-boot-starter-cache`，只引 `caffeine` —— 要的是显式失效，不是注解式切面；\n'
    + '  ② TTL 取 **10 秒的常量**（不是可配的 5~30 秒）—— 这个数字是**安全边界**而非性能旋钮，\n'
    + '     做成配置项等于给运维留一个「调大一点更快」而**不报任何错**的坑。\n',
    '▲ **落地时的两处订正**');

// —— §6 检查表里的过期结论
replaceOnce(F_CLIST,
    '> 判据：`node .workbuddy/audit-deploy-gap.mjs`（回代码取证据，不认台账）**27 项中 23 项通过**，\n'
    + '> 且 P0 全部通过。剩下的都在"服务器侧"（要拿到机器才能做）或代码侧待办（P1-10/11、P2-3、D9）。\n',
    '> 判据：`node .workbuddy/audit-deploy-gap.mjs`（回代码取证据，不认台账）**27 项全部通过**，\n'
    + '> P0 全关、代码侧 P1/P2 待办清零。**剩下的只有"服务器侧"**（要拿到机器才能做：HTTPS、\n'
    + '> 数据库降权、Nginx 静态资源、备份与告警）与两项**待拍板的产品决策**（见下表）。\n',
    '**27 项全部通过**');
replaceOnce(F_CLIST,
    '| 5 | 缓存层（P1-11） | ❌ 待做 | `spring-boot-starter-cache` + Caffeine，给「每请求回查 t_user」加 5~30 秒 TTL |\n',
    '| 5 | 缓存层（P1-11） | ✅ 已修（2026-09-23） | `caffeine` + `AuthSnapshotCache`：把「每请求回查 `t_user`」压到「每用户每 10 秒一次」；6 个鉴权列写入点**显式失效**（撤销仍立即生效），TTL 只作兜底。真机 `e2e-p111` 两侧各 **16 PASS / 0 FAIL**，详见 §7.10 |\n',
    '| 5 | 缓存层（P1-11） | ✅ 已修（2026-09-23）');
replaceOnce(F_CLIST,
    '| 7 | 前端 `.nvmrc` / `base`（P2-2/P2-3） | ⚠️ | `engines` 已声明；`base` 仅在子路径部署时需要设 |\n',
    '| 7 | 前端 `.nvmrc` / `base`（P2-2/P2-3） | ✅ 已修（2026-09-23） | `engines` 已声明；`base` 与路由 history 的 base **成对**取自 `BASE_URL`，子路径部署只改 `.env.production` 一处（根域名部署零影响） |\n',
    '| 7 | 前端 `.nvmrc` / `base`（P2-2/P2-3） | ✅ 已修（2026-09-23）');
replaceOnce(F_CLIST,
    '| D9 | token 存 localStorage | ❌ 待决策 | 前端 10 处（含 spec）；改 httpOnly Cookie 属接口契约级改动，需先拍板 |\n',
    '| D9 | token 存 localStorage | ✅ 已修（2026-09-23） | 改为 **HttpOnly Cookie**（`c2c-token`）+ 保留 `Authorization` 作为第二条通道；前端不再持久化凭据、401 即作废会话；新增登出端点（幂等、匿名可用）。**响应体里的 `token` 契约不变**（避免连带改一批客户端）。真机 `e2e-d9` 两侧各 **21 PASS / 0 FAIL**，详见 §7.9 |\n',
    '| D9 | token 存 localStorage | ✅ 已修（2026-09-23）');
replaceOnce(F_CLIST,
    '| P1-11（缓存层） | 未做缓存时，回调 + 前端轮询 + 每请求回查用户会叠加；支付链路对延迟更敏感 |\n',
    '| P1-11（缓存层） | **已做**：回调 + 前端轮询 + 每请求回查用户原本会叠加，而支付链路对延迟最敏感 —— 这正是它被排在性能维度的原因。缓存把「每请求一次主键查询」压到「每用户每 10 秒一次」；撤销仍靠 6 个写入点的显式失效**立即**生效 |\n',
    '| P1-11（缓存层） | **已做**：回调 + 前端轮询');

// —— 新增 §7.10（真机结论 + 两条边界）
const CLIST_710 = [
    '',
    '---',
    '',
    '## 7.10 鉴权快照缓存的真机结论与两条边界（P1-11，2026-09-23 新增）',
    '',
    '### 为什么非要真机跑一遍',
    '',
    '缓存这东西「看不见」：生效了接口更快，而**计时判据不可靠**（本仓纪律：次序判据 > 计时判据）。',
    '`.workbuddy/e2e-p111.mjs` 的做法是**绕过应用直接改库**（`UPDATE t_user SET status=...`）：',
    '应用不知道这次改动 ⇒ 不可能显式失效 ⇒ 响应码只能由缓存里的旧快照决定。',
    '于是「改库后**立刻**仍然放行」成了一条**确定性**的「缓存存在」证据。',
    '',
    '| 观测（同一份判据，两个产物） | 修复后 `a9b773315108` | 修复前 `cbdf3841d484` |',
    '|---|---|---|',
    '| 直改库封禁后**立刻**请求 `POST /user/heartbeat` | `code=0`（距改库 **28ms**） | `code=401`（距改库 **12ms**） |',
    '| 转为 401 所需时间 | **8278ms**（TTL=10s ⇒ 兜底生效、窗口有界） | 7ms |',
    '| 后台封禁 → **下一次**请求 | 401（显式失效立即生效） | 401 |',
    '| 后台解封 → **下一次**请求 | 0（解封同样失效，否则缓存里留着 `banned`） | 0 |',
    '| 改密后旧票 | 401（`token_version` +1 并被失效） | 401 |',
    '| 合计 | **16 PASS / 0 FAIL** | **16 PASS / 0 FAIL**（能力项全"不存在"） |',
    '',
    '> 两侧都 0 FAIL 才是「红对照成立」：同一探针在旧产物上把能力项判成 ❌，',
    '> 而安全项（撤销链、匿名/伪造票拒绝）在**两侧都必须成立** —— 它们是防掩盖判据。',
    '',
    '### ★ 真机逮到的第一件事：探针第一版「判据测错了对象」',
    '',
    '第一版用 `/user/profile` 观测缓存，结果直改库后**立刻**拿到 `403 账号已被封禁`，',
    '看起来像「缓存没生效」。回代码取证才发现 `UserService#getProfile` 里还有**第二道**封禁判定',
    '（`userMapper.selectById` 直查库 → `forbidden("账号已被封禁")`）。',
    '也就是说那次 403 恰恰说明「拦截器放行了、下游把它拦了」，**缓存其实生效了**。',
    '⇒ 改用 `/user/heartbeat`（只写 `last_active_at`，**没有任何状态校验**）作为干净出口。',
    '**报红先怀疑断言对象，别先怀疑被测实现。**',
    '',
    '### 边界一：封禁的生效延迟取决于端点自带不带状态校验',
    '',
    'P1-11 之后，全站对「封禁」的响应**不再是一个统一延迟**：',
    '',
    '| 端点类型 | 例子 | 经应用封禁 | 绕过应用直接改库 |',
    '|---|---|---|---|',
    '| 自带服务层状态校验 | `GET /user/profile` | 立即（401） | **立即**（服务层直查库 → 403） |',
    '| 不带校验（只靠拦截器） | `POST /user/heartbeat` | 立即（401，显式失效） | **最多慢 10 秒**（TTL 兜底） |',
    '',
    '这**不是缺陷**，是 TTL 兜底的固有代价，且只在「有人在应用之外改了库」时才可能被观察到。',
    '如实记在这里，免得日后有人看到 `/user/profile` 立刻 403、`/user/heartbeat` 还在 200 而怀疑缓存坏了。',
    '顺带一个观察：同一条件下两个端点一个回 403（服务层）、一个回 401（拦截器），',
    '前端对 401 是「清票跳登录」、对 403 是「提示无权」—— 这个差异**只**出现在这条窄窗口里。',
    '',
    '### 边界二：缓存是进程内的',
    '',
    '多实例部署时，**每个实例各有一份缓存**，显式失效只作用于「处理这个请求的那个实例」。',
    '⇒ 经应用封禁后，另一台实例上该用户的缓存要等 **TTL（≤10s）** 才过期。',
    '与本仓其它闸门同一边界。真要跨实例即时失效，得上 Redis 发布订阅 —— 与「单台云服务器」的目标不匹配，**不做**。',
    '',
    '### 证据（四层，缺一不可）',
    '',
    '| 层 | 命令 | 结果 |',
    '|---|---|---|',
    '| 单测 | `node .workbuddy/run-mvn.mjs` | 新增 18 条全绿（`AuthSnapshotCacheTest` 10 + `AuthCacheInvalidationTest` 8）；全量 **489/489**、BUILD SUCCESS |',
    '| 红绿 | `node .workbuddy/probe-p111-redgreen.mjs` | **9 轮全部成立 + 0 处异常**（含 R0/RC 对照组、R6 反向对照、R5 看守自证） |',
    '| 判据 | `node .workbuddy/audit-deploy-gap.mjs` | 该项判据**已改锚能力**（依赖 + 拦截器经缓存 + 不再直查 + TTL 兜底 + 失效点 ≥6） |',
    '| 真机 | `node .workbuddy/e2e-p111.mjs`（present）／`--expect=absent` | 两侧各 **16 PASS / 0 FAIL**（见上表） |',
    '',
].join('\n');
insertBefore(F_CLIST, '## 8. 附：本次审查的证据索引', CLIST_710, '## 7.10 鉴权快照缓存的真机结论与两条边界');

// —— §7.9（D9）证据表补真机一行
replaceOnce(F_CLIST,
    '| 副本一致 | `sync-front.mjs --from=t3` + `sync-check.mjs` | 一致 133 项 / 差异 0 ✅ |\n',
    '| 真机 | `.workbuddy/e2e-d9.mjs` —— 跑**两个产物**（同一判据）：`Set-Cookie` 的 HttpOnly / SameSite=Lax / Path=/、Cookie 单独可用、**Cookie 优先于无效 Bearer**、注册同样下发、登出清票且幂等匿名、HTTP 下**不带** Secure、响应体 `token` 契约不变 | 修复后 `a9b773315108` **21 PASS / 0 FAIL**；修复前 `cbdf3841d484` **21 PASS / 0 FAIL（14 项能力全"不存在"）** ✅ |\n'
    + '| 副本一致 | `sync-front.mjs --from=t3` + `sync-check.mjs` | 一致 133 项 / 差异 0 ✅ |\n',
    '| 真机 | `.workbuddy/e2e-d9.mjs` —— 跑**两个产物**');

/* ==========================================================================
 * 2) docs/后端设计说明.md —— 附二十七 / 附二十八
 * ========================================================================== */

const DESIGN_27 = [
    '',
    '---',
    '',
    '## 附二十七、鉴权快照缓存：把「每请求回查 t_user」压到「每用户每 10 秒一次」（P1-11）（2026-09-23）',
    '',
    '### 27.1 要修的是什么',
    '',
    '`AuthInterceptor` 为了「撤销撤得干净」，**每个已登录请求都回查一次 `t_user`**',
    '（封禁 / 降权 / `token_version` 三件事都靠它即时生效）。这个决定本身是对的，',
    '代价是每次请求多一次主键查询与一次网络往返，而前端一个页面的加载期会并发好几个接口。',
    '',
    '读的却是**同一行里几乎不变的三列**：`role` 建号后基本不动、`status` 极少变、',
    '`token_version` 只在改密/重置时 +1 —— 典型「读多写极少」，正该缓存。',
    '',
    '### 27.2 缓存会不会让「封禁即时生效」失效：这是唯一需要认真回答的问题',
    '',
    '会，**如果只靠 TTL**。所以正确性不押在 TTL 上，而是分两层：',
    '',
    '| 层 | 作用 | 失效点 |',
    '|---|---|---|',
    '| **显式失效（正确性）** | 改了这三列 ⇒ 紧接着 `invalidate(userId)`，**立即**生效 | 6 处：`approveUser` / `toggleUserStatus` / `batchToggleUserStatus` / `resetUserPassword` / `changePassword` / 举报处置的「封禁」 |',
    '| **TTL 兜底（防遗漏）** | 万一将来新增写点忘了接线，最多慢 10 秒到期回源，**不会永久残留** | `expireAfterWrite(10s)` + `maximumSize(10000)` |',
    '',
    '「谁写谁清」这条契约由一条**源码级看守测试**兜住：`AuthSnapshotCacheTest#everyAuthColumnWriteInvalidates`',
    '扫源码找「写这三列」的语句，要求**同一函数体内**必须出现失效调用 —— 以后新增写点若忘了失效，测试会红。',
    '',
    '### 27.3 只缓存三列，不缓存整个 `User`',
    '',
    '- 拦截器只读这三列，别的没必要；',
    '- 避免密码哈希这类字段在缓存里多留一份；',
    '- 挡掉「顺手拿缓存对象去渲染个人资料」—— 那会拿到可能已过期的昵称/头像，',
    '  属于本缓存**不该承担**的语义。',
    '',
    '另有一条**负缓存**：token 里的 userId 查库为空时缓存 `Optional.empty()`，',
    '把「删号后手上还留着旧 token」的无效流量挡在数据库之外。它不会造成「注册后立刻被当成不存在」——',
    'token 只可能为**已经存在过**的 id 签发，删号与建号之间不存在「同一 id 先查空、后被创建」的时序。',
    '',
    '### 27.4 为什么不引 `spring-boot-starter-cache` / `@Cacheable`',
    '',
    '那套需要 `@EnableCaching` + AOP 代理，而**注解式缓存的失效点写在调用方**，',
    '与本类「谁写谁清」的显式契约相比只是换了个地方藏，却多引入一层代理语义',
    '（同类内自调用不走代理、事务内外顺序等）。本项目已经反复栽在「改了没生效且不报错」上，',
    '所以这里选**没有魔法的显式调用**，并配一条源码看守测试兜住「忘了清」。',
    '',
    '### 27.5 TTL 为什么是常量、不做成配置项',
    '',
    '这个数字是**安全边界**（「失效生效前，最坏情况能多活多久」），不是性能旋钮。',
    '做成配置项等于给运维留了一个「把它调到 3600 能让接口快一点」的坑，',
    '而后果（被踢下线的账号还能继续访问一小时）**不会报任何错**。',
    '常量 + 在类注释里写明理由，比一个能被调坏的开关更适合放在这道闸上。',
    '',
    '### 27.6 ★ 一个看似更省事的做法为什么不采用：按「动了 t_user 就清空」',
    '',
    '`UserService#heartbeat`（在线心跳）**每 60 秒就 UPDATE 一次 t_user**（只写 `last_active_at`）。',
    '若按「动了 t_user 就清」来，缓存会被心跳持续冲掉，**命中率趋近 0** ——',
    '加了缓存等于没加，还多了一份内存。所以失效必须**锚到那三列**，',
    '而不是锚到「这张表被写过」；并配一条反向对照用例 `heartbeatDoesNotFlushTheAuthCache` 守着它。',
    '',
    '### 27.7 真机发现：封禁的生效延迟取决于端点自带不带状态校验',
    '',
    '真机探针第一版用 `/user/profile` 观测缓存，拿到 `403 账号已被封禁` ——',
    '看着像「缓存没生效」，其实 `UserService#getProfile` 里还有**第二道**直查库的封禁判定，',
    '是它把请求拦下的（**拦截器确实放行了**，缓存生效）。改用 `/user/heartbeat`（无状态校验）才观测干净。',
    '完整结论与两条边界见部署清单 §7.10。',
    '',
    '### 27.8 边界（如实交代）',
    '',
    '- **进程内缓存**：多实例各一份，显式失效只作用于处理该请求的实例；另一台要等 TTL（≤10s）。',
    '  跨实例即时失效需 Redis 发布订阅，与「单台云服务器」目标不匹配，**不做**；',
    '- **只在应用之外改库时才会看到延迟**：经应用正常路径封禁/改密一律**立即**生效；',
    '- 缓存条目数上界 10000 只是**防无界增长**（伪造/历史 userId 打接口时条目不会一直堆），不做容量规划。',
    '',
].join('\n');

const DESIGN_28 = [
    '',
    '---',
    '',
    '## 附二十八、会话凭据改 HttpOnly Cookie（D9）与前端 `base` 收口（P2-3）（2026-09-23）',
    '',
    '### 28.1 要修的是什么',
    '',
    'JWT 原由前端写进 `localStorage`（`stores/modules/user.ts` 的 `persist.paths=[\'token\']`）。',
    '后果不会报错：**页面上任何一段脚本都能把它读走**。一次 XSS（第三方脚本、评论里塞的',
    '`<img onerror>`、被投毒的依赖）就能把 24 小时有效的凭据静默带出去，攻击者换一台机器照样能用，',
    '而用户直到令牌过期都毫无察觉。',
    '',
    '改为 **HttpOnly Cookie**（`c2c-token`）：浏览器自动携带，**JS 读不到**；前端连「读 token」这个动作都不再需要。',
    '',
    '### 28.2 走 Cookie 会不会把 CSRF 引进来',
    '',
    'Cookie 会被自动带上，这正是 CSRF 的成因。这里用 **`SameSite=Lax`** 兜住：',
    '跨站发起的 POST/PUT/PATCH/DELETE **不会**带上本 Cookie，而本项目的写操作全部是这些方法（GET 只读）。',
    '于是「诱导点击」这条路径被浏览器自己掐断，不必再自己实现一套 CSRF token —— 少一套机制就少一处「忘了接」的角落。',
    '',
    '> ★ 留档：若哪天要支持**跨站** POST，就必须补 CSRF token，届时 `SameSite=Lax` 的保护会在改动中被**静默削弱**。',
    '',
    '### 28.3 两个必须由服务端决定的属性',
    '',
    '| 属性 | 取值 | 为什么不能做成配置项 |',
    '|---|---|---|',
    '| `Secure` | `request.isSecure()` 自动判定 | 本地开发走 `http://`，带 `Secure` 的 Cookie 会被浏览器**直接丢弃** —— 表现是「登录接口返回成功、下一个请求却是未登录」，且**无任何报错**。做成配置项等于把这个坑交给运维去踩。方向也是安全的：判断失误只会「HTTP 下少一个 Secure 标记」（仍可用），不会「HTTPS 下登录不了」 |',
    '| `Max-Age` | 取 `JwtConfig#getExpiration()` | 与 token **同源**。两者一旦漂移，就会出现「Cookie 还在、token 已过期」或反过来的错位状态，而前端此时已不再持有 token、**无从自证**，表现是「莫名其妙要求重新登录」 |',
    '',
    '### 28.4 登出端点不是锦上添花，是必需品',
    '',
    'HttpOnly 的含义就是**前端没有能力删它**。没有登出端点，用户点「退出登录」只会清空前端 store，',
    '而浏览器依旧带着那张有效票据 —— 一刷新就又是登录态，表现是「退不出去」。',
    '（之前没有这个问题，只因为凭据存在 `localStorage`、前端正好能自己删。）',
    '',
    '`POST /user/logout` 刻意做成**幂等**且**不要求已登录**：凭据已过期、已被封禁、甚至压根没登录时',
    '调用它都应当成功返回（清一个不存在的 Cookie 是无害的）。若要求登录，用户在最需要退出的时刻',
    '（会话已失效）反而退不掉。清空用 `Max-Age=0` + **同名同路径**，属性必须与下发时一致（`Path` 尤其重要），',
    '否则会「删了个不存在的 Cookie」。',
    '',
    '### 28.5 两条通道并存，且 Cookie 优先',
    '',
    '主通道是 Cookie；`Authorization` 头保留为**第二条通道**，理由是加法式改动的纪律：',
    '① 现有探针、脚本、Swagger「Try it out」都靠它，砍掉等于同时废掉一批验证手段；',
    '② 将来接入非浏览器客户端，那条路本来就该走头。',
    '',
    '两条通道进的是**同一个验签与同一段后续校验**（`AuthCookie.read` 优先，取不到再读头），',
    '不存在「某条通道少验了什么」—— 这是这里唯一需要守的边界：**绝不为了兼容再写一套平行的鉴权逻辑**。',
    '真机探针对此有一条**次序判据**：同时带「有效 Cookie + 无效 Bearer」必须仍通过；顺序被改反就会报红。',
    '',
    '**响应体里的 `token` 一个字都不改**（登录仍返回 `{token, user}`）：契约保持原样，改动只发生在**存储通道**上。',
    '残留风险如实记：正在发生 XSS 的那一刻，攻击者可以从这次登录的响应里截获 token ——',
    '但那需要「诱导用户重新登录 + 已知口令」，与「从存储里静默读走现成凭据、换台机器继续用」不是一个量级。',
    '彻底消除需要把 token 从响应体里删掉（属接口契约变更，另行评估）。',
    '',
    '### 28.6 同批收口的前端 `base`（P2-3）',
    '',
    '`base` 与路由 history 的 base **成对**取自 Vite 注入的 `BASE_URL`：',
    '`vite.config.ts` 的 `base: env.VITE_BASE || \'/\'`、`src/router/index.ts` 的',
    '`createWebHistory(import.meta.env.BASE_URL)`，`.env.production` 只留一处 `VITE_BASE=/`。',
    '★ 只改打包 `base` 会让资源在 `/market/assets/`、路由仍按根解析 ⇒ **资源与路由两套前缀**，',
    '表现是「首页能开、一点导航就 404」。根域名部署时 `VITE_BASE=/` 零影响。',
    '',
    '### 28.7 证据与边界',
    '',
    '证据（四层见部署清单 §7.9）：单测 后端 19 条 + 前端 20 条（前端全量 **727/727**、`vue-tsc` 0 错）；',
    '红绿 `.workbuddy/probe-d9-redgreen.mjs` **12 轮**；判据红绿 `.workbuddy/probe-d9-criterion.mjs` **9 轮**；',
    '真机 `.workbuddy/e2e-d9.mjs` 两侧各 **21 PASS / 0 FAIL**。',
    '',
    '边界：',
    '- **登出只清浏览器侧票据**，服务端不维护黑名单（无状态 JWT）。「让已发出的票据立即失效」靠',
    '  `token_version`（改密/重置即 +1），不是靠登出本身；',
    '- 无状态 JWT + Cookie 的组合天然没有「服务端会话表」，也就没有「主动踢人」能力 ——',
    '  需要踢人时改的是 `token_version`；',
    '- 响应体仍返回 `token`（见 28.5 的残留风险说明）。',
    '',
].join('\n');

// 附二十七 / 附二十八 追加到末尾
appendAtEnd(F_DESIGN, DESIGN_27, '## 附二十七、鉴权快照缓存');
appendAtEnd(F_DESIGN, DESIGN_28, '## 附二十八、会话凭据改 HttpOnly Cookie');

// 设计说明里的两处过期「剩余」结论
replaceOnce(F_DESIGN,
    '  ▲ **已订正（见附二十五）**：P1-5 与 P1-6 在紧接着的下一轮修完；\n'
    + '  剩余为 **P1-10 上传限流+魔数 / P1-11 缓存层 / P2-3 vite base / D9 localStorage token**。\n',
    '  ▲ **已订正（见附二十五）**：P1-5 与 P1-6 在紧接着的下一轮修完；\n'
    + '  ▲ **再次订正（见附二十六、附二十七、附二十八）**：P1-10 在 B7 批关闭，\n'
    + '  P1-11 缓存层 / P2-3 vite `base` / D9 localStorage token 在 B8 批一次关完 ⇒\n'
    + '  **部署适配清单 27 项至此全部通过**（详见部署清单 §6 与 §7.9 / §7.10）。\n',
    '▲ **再次订正（见附二十六、附二十七、附二十八）**');
replaceOnce(F_DESIGN,
    '- 剩余：**P1-11 缓存层 / P2-3 vite `base` / D9 localStorage token**。\n',
    '- 剩余：**无** —— P1-11 / P2-3 / D9 已在 B8 批关闭（见附二十七、附二十八）。\n',
    '- 剩余：**无** —— P1-11 / P2-3 / D9 已在 B8 批关闭');

/* ==========================================================================
 * 3) 项目缺陷检查与修复清单.md —— 二十八
 * ========================================================================== */

const FIX_28 = [
    '',
    '---',
    '',
    '## 二十八、第二十轮（B8 批）：鉴权快照缓存 + 会话凭据 Cookie + 前端 base（2026-09-23）',
    '',
    '> 本轮把部署适配清单**最后三项**（P1-11 / P2-3 / D9）一次关完，全表 **27/27**。',
    '> ★ 本轮最值得记的不是这三项本身，而是**两次「台账/判据撒谎」**（见 28.5）。',
    '',
    '### 28.1 缺陷内容（三项，互相独立）',
    '',
    '| 编号 | 缺陷 | 后果（不报错的那一面） |',
    '|---|---|---|',
    '| **P1-11** | `AuthInterceptor` 每个已登录请求都回查 `t_user`（`selectById`） | 每次请求多一次主键查询 + 一次网络往返，且**先于业务逻辑占用连接**；并发一上来连接被这一层先吃掉，表现是「业务查询还没开始就在等连接」 |',
    '| **D9** | JWT 存 `localStorage` | 页面上任何一段脚本都能读走 24 小时有效的凭据；一次 XSS 即可换台机器继续用，用户毫无察觉 |',
    '| **P2-3** | 前端 `base` 未配置 | 子路径部署时资源在 `/market/assets/`、路由按根解析 ⇒ 首页能开、一点导航就 404 |',
    '',
    '### 28.2 落地清单',
    '',
    '| # | 落地 | 位置 |',
    '|---|---|---|',
    '| 1 | `AuthSnapshotCache`（Caffeine；只缓存 `status`/`role`/`token_version` 三列 + 负缓存；`TTL=10s` 常量、`maximumSize=10000`；时钟可注入） | `security/AuthSnapshotCache.java` |',
    '| 2 | 拦截器改走缓存（语义不变：仍「以库为准、不信 token」，只是「库」变成「最多 10 秒前的库」） | `interceptor/AuthInterceptor.java` |',
    '| 3 | **6 个鉴权列写入点全部显式失效** + 源码看守测试 | `UserService`（5 处）、`ContentService`（1 处）、`AuthSnapshotCacheTest#everyAuthColumnWriteInvalidates` |',
    '| 4 | 只引 `caffeine`，**不引** `spring-boot-starter-cache`（pom 里就地写明理由） | `pom.xml` |',
    '| 5 | `AuthCookie`（`c2c-token`，HttpOnly + SameSite=Lax + Path=/ + Max-Age 与 token 同源，Secure 由 `request.isSecure()` 决定） | `security/AuthCookie.java` |',
    '| 6 | 登录/注册都下发 Cookie；拦截器**Cookie 优先**、`Authorization` 作第二通道 | `UserController`、`AuthInterceptor` |',
    '| 7 | `POST /user/logout`（幂等、不要求已登录，清票用 Max-Age=0 且属性与下发一致） | `UserController#logout` |',
    '| 8 | 前端：不再持久化凭据、401 即作废会话、子路径跳转按 `BASE_URL` | `api/session.ts`、`stores/modules/user.ts`、`api/request.ts`、`utils/permission.ts`、`App.vue` |',
    '| 9 | 前端 `base` 与路由 history base **成对**取自 `BASE_URL` | `vite.config.ts`、`src/router/index.ts`、`.env.production` |',
    '| 10 | 单测：后端 18 + 19、前端 20；真机探针 `e2e-p111.mjs` / `e2e-d9.mjs` | `src/test/java/...`、`.workbuddy/` |',
    '',
    '### 28.3 关键决策',
    '',
    '1. **缓存不引 `spring-boot-starter-cache`**：注解式缓存的失效点写在调用方，与「谁写谁清」的显式契约相比只是换个地方藏，却多一层 AOP 代理语义（自调用不走代理、事务内外顺序）。本仓反复栽在「改了没生效且不报错」上 ⇒ 要**没有魔法的显式调用**。',
    '2. **正确性不押在 TTL 上**：6 个写入点显式失效保证「撤销立即生效」，TTL 只是「万一漏了」的兜底；并有一条**源码级看守测试**要求「写了这三列就必须在同一函数体内失效」，新增写点忘了接线会报红。',
    '3. **失效锚到那三列，而不是「t_user 被写过」**：`heartbeat` 每 60 秒写一次 `last_active_at`，按「动表就清」会让缓存被心跳冲干净（命中率趋近 0）；反向对照用例 `heartbeatDoesNotFlushTheAuthCache` 守着这件事。',
    '4. **TTL 是常量不是配置项**：它是安全边界（最坏能多活多久），不是性能旋钮；做成配置项等于留一个「调大一点更快」而**不报错**的坑。',
    '5. **只缓存三列**：不必缓存整实体 —— 拦的是「密码哈希多留一份」与「顺手拿缓存对象渲染个人资料」两类问题。',
    '6. **Cookie 不引 CSRF token**：`SameSite=Lax` 已让跨站的写方法不带票，而本项目写操作全是这些方法。若将来支持跨站 POST，必须补 CSRF token（已在类注释留档）。',
    '7. **`Secure` 由 `request.isSecure()` 决定**：HTTP 下带 `Secure` 的 Cookie 会被浏览器直接丢弃 ⇒「登录成功但立刻未登录」且无报错；配置化等于把这个坑交给运维。',
    '8. **`Max-Age` 与 token 同源**：两者漂移会出现「Cookie 在、token 过期」，而前端已不持有 token、无从自证。',
    '9. **登出端点幂等且匿名可用**：HttpOnly 意味着前端删不掉票据；要求登录会让「会话已失效时最需要退出」的场景反而退不掉。',
    '10. **响应体 `token` 契约不变**：改动只发生在存储通道，避免连带改一批客户端与探针。',
    '',
    '### 28.4 四层验证（缺一不可）',
    '',
    '| 层 | 命令 | 结果 |',
    '|---|---|---|',
    '| 单测 | `node .workbuddy/run-mvn.mjs` | 后端全量 **489/489**、BUILD SUCCESS（本轮新增缓存 18 + Cookie/快照 19）；前端全量 **727/727** + `vue-tsc` 0 错 |',
    '| 红绿 | `probe-p111-redgreen.mjs`（9 轮）/ `probe-d9-redgreen.mjs`（12 轮） | 全部成立 + 0 处异常（各含 R0/RC 对照组与防掩盖判据） |',
    '| 判据 | `probe-d9-criterion.mjs`（9 轮）；`audit-deploy-gap.mjs` 的 P1-11 判据**已改锚能力** | 全部成立；审计 **27 项全部通过** |',
    '| 真机 | `e2e-p111.mjs` / `e2e-d9.mjs`，**同一判据各跑两个产物** | P1-11 两侧各 **16 PASS / 0 FAIL**；D9 两侧各 **21 PASS / 0 FAIL** |',
    '',
    '### 28.5 ★ 本轮两次「台账/判据撒谎」（最值得记的）',
    '',
    '**① 会话记忆里的「下一步」是过期台账。** 接手时的记忆写着「已完成 24 / 未完成 3，下一步 P1-11」，',
    '但回代码一看：`pom.xml` 里已有 `caffeine`、`AuthSnapshotCache` 已存在、D9 的 `AuthCookie` 也已落地 ——',
    '**丢失的那段工作其实已经把三项都做完了**，只是文档销项与真机层没跟上。',
    '⇒ 按本仓纪律「**答『还剩多少没修』前必须回代码逐条求证**」逐条核过才避免重复劳动。',
    '确认方式：文件 mtime 时间线 + 回代码读实现 + 跑 `audit-deploy-gap.mjs`。',
    '',
    '**② 真机探针第一版「判据测错了对象」。** 观测缓存时用 `/user/profile`，直改库后**立刻**拿到',
    '`403 账号已被封禁`，看着像「缓存没生效」。回代码取证发现 `UserService#getProfile` 还有**第二道**',
    '直查库的封禁判定（是它拦的，**拦截器其实放行了**）。改用无状态校验的 `/user/heartbeat` 才观测干净。',
    '**报红先怀疑断言对象，别先怀疑被测实现。**',
    '',
    '**③ D9 探针第一版把「能力项」误归成「安全项」。** `logoutAnonymousOk` / `logoutIdempotent` /',
    '`noSecureFlagOnHttp` 被放进「两组都必须成立」的安全项，结果修复前产物（那时 `/user/logout`',
    '**端点还不存在**）三项必然为假 ⇒ 红对照报红。它们其实是**随版本变化的能力**，已挪到能力项。',
    '★ 纪律：**安全项必须两组都为真，否则它就不是安全项** —— 把能力伪装成安全项会让红对照永远通不过。',
    '',
    '### 28.6 遗留与边界（如实记）',
    '',
    '- **缓存是进程内的**：多实例各一份，显式失效只作用于处理该请求的实例，另一台要等 TTL（≤10s）；',
    '  跨实例即时失效需 Redis 发布订阅，与「单台云服务器」目标不匹配，不做；',
    '- **封禁的生效延迟不是统一值**：自带服务层状态校验的端点（如 `/user/profile`）在有人绕过应用改库时',
    '  仍立即拒绝；只靠拦截器的端点（如 `/user/heartbeat`）最坏慢 10 秒。经应用正常路径封禁一律立即；',
    '- **登出只清浏览器侧票据**，服务端无黑名单；「立即失效已发出的票」靠 `token_version`；',
    '- **响应体仍返回 `token`**：正在发生 XSS 的那一刻仍可能从登录响应里截获（残留风险，见附二十八 28.5）；',
    '- **待用户拍板**：`favorite_count` 装饰大数 · D11 待审核态 · 支付宝沙箱密钥是否真去申请；',
    '- **仓库仍未 `git init`**（工作区无 `.git`）。',
    '',
].join('\n');

replaceOnce(F_FIX,
    '- 剩余未修：**P1-11 缓存层 / P2-3 前端 `vite base`**（B7 批已关闭 P1-10，见 §二十七）；\n'
    + '  待用户拍板：**D9**（token 存 localStorage）。\n',
    '- 剩余未修：**无** —— P1-11 缓存层 / P2-3 前端 `vite base` / D9 凭据改 Cookie 已在 B8 批关闭（见 §二十八）；\n'
    + '  部署适配清单 **27/27 全部通过**。剩余为待用户拍板的产品决策项（`favorite_count` 装饰大数、D11 待审核态、\n'
    + '  支付宝沙箱密钥是否真去申请）与仓库仍未 `git init`。\n',
    'P1-11 缓存层 / P2-3 前端 `vite base` / D9 凭据改 Cookie 已在 B8 批关闭');
appendAtEnd(F_FIX, FIX_28, '## 二十八、第二十轮（B8 批）');

/* ==========================================================================
 * 4) 缺陷清单逐条核对报告.md —— 二十二
 * ========================================================================== */

const REPORT_22 = [
    '',
    '---',
    '',
    '## 二十二、B8 批：P1-11 / P2-3 / D9 的逐条核对（2026-09-23）',
    '',
    '### 22.1 开场：这一轮是「先发现台账过期，再补验证与销项」',
    '',
    '接手时的记忆（`MEMORY.md` §一）写着「已完成 **24 / 未完成 3**，下一步 = P1-11 缓存层」。',
    '按本仓纪律**不采信台账**，逐条回代码求证，结果三项**都已在代码里落地**（丢的那段会话做完了实现，',
    '只是文档销项与真机层没跟上）：',
    '',
    '| 项 | 回代码证据 | 台账判定 | 实际 |',
    '|---|---|---|---|',
    '| **P1-11** | `pom.xml` 有 `caffeine`（且就地写明「不引 starter-cache」的理由）；`security/AuthSnapshotCache.java` 存在；`AuthInterceptor` 注入的是缓存类、不再注入 `UserMapper` | ❌ 未完成 | ✅ **已落地** |',
    '| **P2-3** | `vite.config.ts` 的 `base: env.VITE_BASE \\|\\| \'/\'`；`src/router/index.ts` 用 `createWebHistory(import.meta.env.BASE_URL)` | ❌ 未完成 | ✅ **已落地** |',
    '| **D9** | `security/AuthCookie.java` 存在；登录/注册都调 `issueSessionCookie`；`POST /user/logout` 已在白名单内 | ❌ 未完成 | ✅ **已落地** |',
    '',
    '发现方式：**文件 mtime 时间线**（`pom.xml` 14:39 → `AuthSnapshotCache` 15:07 → `AuthCookie`/前端 16:18 →',
    '部署清单 16:20）+ 回代码读实现 + 跑审计脚本。',
    '',
    '> ★ 这正是本仓那条纪律的又一次生效：**台账会撒谎，答「还剩多少未修」前必须回代码逐条求证。**',
    '> 若直接照记忆里的「下一步 = 开始写缓存」，会是纯粹的重复劳动。',
    '',
    '### 22.2 逐项核对',
    '',
    '| 台账/记忆原文 | 回代码核对 | 判定 |',
    '|---|---|---|',
    '| 「P1-11 缓存层：`spring-boot-starter-cache` + Caffeine，5~30 秒 TTL」 | 实现为**只引 `caffeine`** + `AuthSnapshotCache`，TTL = **10 秒常量** | ⚠️ **实现与原建议有两处差异，均已就地订正文档**：① 不引 starter-cache（要显式失效，不要注解式切面）；② TTL 是安全边界不是性能旋钮 ⇒ 不做成配置项 |',
    '| 「D9 未修（待拍板）」 | `AuthCookie` + 登出端点 + 前端去凭据持久化均已落地，且有单测 19 + 前端 spec 20 | ✅ **已修** |',
    '| 「P2-3 未修」 | `base` 与路由 base 成对取自 `BASE_URL` | ✅ **已修** |',
    '| 「审计 **27 项中 23 项通过**」 | 重跑 `audit-deploy-gap.mjs`：**27 项全部通过，未完成 0** | ✅ **已更新** |',
    '',
    '### 22.3 ★ 本轮补做的那一层：真机（原实现只做到「单测 + 红绿 + 判据」）',
    '',
    '缓存与 Cookie 都属于「单测里被 `new` 出来、红绿里改的是源码」的对象，**都绕过了真实装配与 HTTP 链路**',
    '（Bean 有没有被扫到、拦截器注入的是不是缓存、`Set-Cookie` 有没有真的出现在响应头里）——',
    '所以本轮补了 `.workbuddy/e2e-p111.mjs` 与 `.workbuddy/e2e-d9.mjs`，各跑**两个产物**：',
    '',
    '| 探针 | 修复后 `a9b773315108`（本轮构建） | 修复前 `cbdf3841d484`（P1-10 时代产物） |',
    '|---|---|---|',
    '| `e2e-p111.mjs` | **16 PASS / 0 FAIL**（直改库封禁后 **28ms 仍放行** ⇒ 缓存存在；**8.3 秒**后转 401 ⇒ TTL 兜底有界） | **16 PASS / 0 FAIL**（同一判据 **12ms 直接 401**，能力项全"不存在"） |',
    '| `e2e-d9.mjs` | **21 PASS / 0 FAIL**（HttpOnly / SameSite=Lax / Path=/、Cookie 单独可用、Cookie 优先、注册也下发、登出清票幂等匿名、HTTP 下无 Secure、响应体契约不变） | **21 PASS / 0 FAIL**（14 项能力全"不存在"） |',
    '',
    '> ★ 缓存「看不见」，所以判据不去量耗时（本仓纪律：**次序判据 > 计时判据**），而是**绕过应用直接改库**：',
    '> 应用不知道这次改动 ⇒ 不可能显式失效 ⇒ 响应码只能由缓存里的旧快照决定。',
    '> 「改库后立刻仍放行」于是成了一条**确定性**的「缓存存在」证据。',
    '',
    '### 22.4 两个红对照各抓出一条「自己的问题」',
    '',
    '1. **P1-11 探针第一版判据测错对象**：用 `/user/profile` 观测缓存，直改库后立刻拿到 `403 账号已被封禁`，',
    '   看着像「缓存没生效」。回代码发现 `UserService#getProfile` 还有**第二道**直查库的封禁判定，',
    '   是它拦的（拦截器确实放行了）。改用 `/user/heartbeat`（只写 `last_active_at`、无状态校验）后观测干净。',
    '   **报红先怀疑断言对象，别先怀疑被测实现。**',
    '2. **D9 探针第一版把能力项误归成安全项**：`logoutAnonymousOk` / `logoutIdempotent` /',
    '   `noSecureFlagOnHttp` 放进「两组都必须成立」的安全项，而修复前产物里 `/user/logout` **端点还不存在**',
    '   ⇒ 三项必然为假 ⇒ 红对照报红。它们其实是**随版本变化的能力**。',
    '   ★ 纪律：**安全项必须两组都为真，否则它就不是安全项** —— 伪装成安全项的能力会让红对照永远通不过。',
    '',
    '### 22.5 证据（四层，缺一不可）',
    '',
    '| 层 | 做法 | 结果 |',
    '|---|---|---|',
    '| 单测 | 后端 `node .workbuddy/run-mvn.mjs`；前端 vitest 全量 | 后端 **489/489** + BUILD SUCCESS；前端 **727/727** + `vue-tsc` 0 错 |',
    '| 红绿 | `probe-p111-redgreen.mjs` 9 轮 / `probe-d9-redgreen.mjs` 12 轮（各含 R0/RC 对照组、防掩盖判据、逐字节还原） | 全部成立 + 0 处异常 |',
    '| 判据 | `probe-d9-criterion.mjs` 9 轮；P1-11 判据改锚能力（依赖 + 拦截器经缓存 + 不再直查 + TTL 兜底 + 失效点 ≥6） | 全部成立；审计 27/27 |',
    '| 真机 | `e2e-p111.mjs` / `e2e-d9.mjs` 各跑两个产物（见 22.3） | P1-11 16/16 两侧；D9 21/21 两侧 |',
    '',
    '### 22.6 台账订正',
    '',
    '- `MEMORY.md` 进度由 **24/3** 更新为 **27/27**（三项在丢失的那段工作中已落地，本轮补真机与销项）；',
    '- 「剩余未完成」一项**清空**；剩余只有「待用户拍板的产品决策」与「仓库仍未 `git init`」；',
    '- 设计说明新增**附二十七 / 附二十八**；部署清单新增 **§7.10**；本条为本报告 **§二十二**。',
    '',
].join('\n');

appendAtEnd(F_REPORT, REPORT_22, '## 二十二、B8 批');
replaceOnce(F_REPORT,
    '> 要判断「现在还剩什么没修」，请看 **§十一 ~ §二十一**（最新一节 = 当前状态），\n',
    '> 要判断「现在还剩什么没修」，请看 **§十一 ~ §二十二**（最新一节 = 当前状态），\n',
    '**§十一 ~ §二十二**（最新一节 = 当前状态）');
replaceOnce(F_REPORT,
    '> 最近一次更新：**§二十 = B6 批「P1-5 健康检查 + P1-6 请求上下文」已修**（另：§十一~§二十 逐节订正过历史判定）。\n',
    '> 最近一次更新：**§二十二 = B8 批「P1-11 缓存层 + D9 凭据改 Cookie + P2-3 前端 base」已修**，'
    + '部署适配清单 **27/27 全部通过**（另：§十一~§二十 逐节订正过历史判定）。\n',
    '**§二十二 = B8 批「P1-11 缓存层 + D9 凭据改 Cookie + P2-3 前端 base」已修**');

/* ==========================================================================
 * 5) campus-secondhand-backend/README.md
 * ========================================================================== */

replaceOnce(F_README,
    '（「附一」～「附二十六」）',
    '（「附一」～「附二十八」）',
    '（「附一」～「附二十八」）');
replaceOnce(F_README,
    '- 登录 token 存在 `localStorage`（改 httpOnly Cookie 属接口契约级改动，尚未拍板）；\n',
    '- 会话凭据已改为 **HttpOnly Cookie**（`c2c-token`，`SameSite=Lax`）：JS 读不到，XSS 拿不走；\n'
    + '  响应体里的 `token` **仍返回**（契约不变），所以正在发生 XSS 的那一刻仍可能从登录响应里截获（残留风险，见设计说明附二十八）；\n'
    + '  登出只清浏览器侧票据，服务端不维护黑名单 —— 「让已发出的票立即失效」靠 `token_version`（改密/重置即 +1）；\n'
    + '- 鉴权快照缓存（P1-11）是**进程内**的：多实例各一份，显式失效只作用于处理该请求的实例，\n'
    + '  另一台要等 TTL（≤10 秒）。由此「封禁的生效延迟」不是统一值：自带服务层状态校验的端点\n'
    + '  （如 `GET /user/profile`）仍立即拒绝，只靠拦截器的端点（如 `POST /user/heartbeat`）最坏慢 10 秒；\n'
    + '  经应用正常路径封禁（`POST /admin/users/{id}/ban`）一律**立即**生效；\n',
    '会话凭据已改为 **HttpOnly Cookie**（`c2c-token`，`SameSite=Lax`）');

/* ==========================================================================
 * 写盘 + 回读自证
 * ========================================================================== */

console.log('\n-- 写盘');
for (const [f, txt] of touched) {
    if (txt !== read(f)) {
        fs.writeFileSync(f, txt, 'utf8');
        console.log(`  ✓ 已写 ${path.relative(ROOT, f)}`);
    } else {
        console.log(`  – 无变化 ${path.relative(ROOT, f)}`);
    }
}

console.log('\n-- 回读自证');
const asserts = [
    [F_CLIST, '> 证据（四层）：', '清单 P1-11 证据升级为四层'],
    [F_CLIST, '> - 真机 `.workbuddy/e2e-p111.mjs` 跑**两个产物**', '清单 P1-11 真机行'],
    [F_CLIST, '▲ **落地时的两处订正**', '清单 P1-11 旧「改法」已订正'],
    [F_CLIST, '**27 项全部通过**', '清单 §6 检查表结论已更新'],
    [F_CLIST, '| 5 | 缓存层（P1-11） | ✅ 已修（2026-09-23）', '清单 P1-11 表行已翻转'],
    [F_CLIST, '| D9 | token 存 localStorage | ✅ 已修（2026-09-23）', '清单 D9 表行已翻转'],
    [F_CLIST, '## 7.10 鉴权快照缓存的真机结论与两条边界', '清单 §7.10 新节'],
    [F_CLIST, '| 真机 | `.workbuddy/e2e-d9.mjs` —— 跑**两个产物**', '清单 §7.9 D9 真机行'],
    [F_CLIST, '| 5 | 缓存层（P1-11） | ❌ 待做 |', '清单 P1-11 旧结论已消失', true],
    [F_CLIST, '| D9 | token 存 localStorage | ❌ 待决策 |', '清单 D9 旧结论已消失', true],
    [F_CLIST, '**27 项中 23 项通过**', '清单旧计数已消失', true],
    [F_DESIGN, '## 附二十七、鉴权快照缓存', '设计说明附二十七'],
    [F_DESIGN, '## 附二十八、会话凭据改 HttpOnly Cookie', '设计说明附二十八'],
    [F_DESIGN, '- 剩余：**无** —— P1-11 / P2-3 / D9 已在 B8 批关闭', '设计说明旧遗留已订正'],
    [F_FIX, '## 二十八、第二十轮（B8 批）', '清单二十八'],
    [F_FIX, 'D9 凭据改 Cookie 已在 B8 批关闭', '清单旧遗留已订正'],
    [F_REPORT, '## 二十二、B8 批', '核对报告二十二'],
    [F_REPORT, '**§十一 ~ §二十二**（最新一节 = 当前状态）', '核对报告导航已更新'],
    [F_README, '（「附一」～「附二十八」）', 'README §8 附录范围已更新'],
    [F_README, '会话凭据已改为 **HttpOnly Cookie**', 'README §9 新限制'],
    [F_README, '登录 token 存在 `localStorage`', 'README 旧限制已消失', true],
];
for (const [f, needle, label, mustBeAbsent] of asserts) {
    const has = read(f).includes(needle);
    if (mustBeAbsent) {
        if (has) bad(`回读失败：${label}`);
        else done(`回读 · ${label}`);
    } else {
        if (has) done(`回读 · ${label}`);
        else bad(`回读失败：${label}（文件里找不到）`);
    }
}

// 节序号连续性 + 唯一性（追加型脚本重复跑会静默产生重复节）
{
    const report = read(F_REPORT);
    const secs = [...report.matchAll(/^## ([一二三四五六七八九十]+)、/gm)].map((m) => m[1]);
    const dup = secs.filter((s, i) => secs.indexOf(s) !== i);
    if (dup.length) bad(`核对报告的节序号有重复：${dup.join(', ')}`);
    else done(`核对报告节序号无重复（共 ${secs.length} 节，末节「${secs[secs.length - 1]}」）`);

    const fix = read(F_FIX);
    const fsecs = [...fix.matchAll(/^## ([一二三四五六七八九十]+)、/gm)].map((m) => m[1]);
    const fdup = fsecs.filter((s, i) => fsecs.indexOf(s) !== i);
    if (fdup.length) bad(`缺陷清单的节序号有重复：${fdup.join(', ')}`);
    else done(`缺陷清单节序号无重复（共 ${fsecs.length} 节，末节「${fsecs[fsecs.length - 1]}」）`);

    const dsn = read(F_DESIGN);
    const dsecs = [...dsn.matchAll(/^## (附[一二三四五六七八九十]+)、/gm)].map((m) => m[1]);
    const ddup = dsecs.filter((s, i) => dsecs.indexOf(s) !== i);
    if (ddup.length) bad(`设计说明的附号有重复：${ddup.join(', ')}`);
    else done(`设计说明附号无重复（共 ${dsecs.length} 节，末节「${dsecs[dsecs.length - 1]}」）`);
}

console.log(problems === 0 ? '\n结果：文档销项完成（0 处异常）' : `\n结果：${problems} 处异常`);
process.exit(problems === 0 ? 0 : 2);
