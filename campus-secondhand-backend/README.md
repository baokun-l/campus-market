# 校园二手集市 · 后端服务

> Spring Boot 3.2.5 + MyBatis-Plus 3.5.6 + MySQL 8 + JWT，前后端分离中的**服务端**。
> 配套前端见 `../campus-secondhand-frontend`（Vue 3 + Vite + TS + Element Plus）。

---

## 1. 技术选型

| 层 | 选型 | 版本 | 说明 |
|---|---|---|---|
| 运行时 | JDK | 17 | 与 Spring Boot 3.x 基线一致 |
| 框架 | Spring Boot | 3.2.5 | 父工程 |
| 持久层 | MyBatis-Plus | 3.5.6 | 单表 CRUD 免写 XML；复杂查询走 XML 映射 |
| 数据库 | MySQL | 8.x | 字符集 `utf8mb4` |
| 鉴权 | jjwt | 0.12.5 | 无状态 JWT，拦截器统一校验 |
| 密码 | BCrypt | — | 全链路哈希，明文永不落库 |
| 接口文档 | springdoc-openapi | 2.3.0 | Swagger UI，**版本与 Boot 3.2.x 配对** |
| 构建 | Maven | 3.9.x | |

---

## 2. 快速开始

### 2.1 前置条件

- JDK 17（`java -version` 应输出 17.x）
- Maven 3.9+
- MySQL 8 已启动，账号能建库建表

### 2.2 初始化数据库：**不需要手动执行任何 SQL**

启动时会自动完成「**建库 → 建表 → 灌种子数据**」三步：

| 步骤 | 由谁完成 | 说明 |
|---|---|---|
| 建库 | JDBC URL 的 `createDatabaseIfNotExist=true` | 库不存在也不会报错 |
| 建表 | `spring.sql.init` → `db/schema-auto.sql` | ⚠️ **生成物，不要手改**（见 §2.5） |
| 灌种子 | `db/seed-base.sql` | **仅当表为空时**才灌，重启不会重复插入 |

默认连接参数（可用环境变量覆盖）：

```
地址：localhost:3306    库名：campus_market
账号：root              密码：123456
```

### 2.3 启动

```bash
# 开发（默认 profile）
./mvnw spring-boot:run

# 或先打包再运行
./mvnw -DskipTests package
java -jar target/campus-secondhand-backend-1.0.0.jar --server.port=8080
```

启动成功后：

- 接口根地址：`http://localhost:8080/api`
- **接口文档（Swagger UI）：`http://localhost:8080/api/swagger-ui/index.html`**
- 日志：`logs/campus-market.log` 与 `logs/campus-market-error.log`
  （滚动策略见 `src/main/resources/logback-spring.xml`；目录可用环境变量 `LOG_DIR` 改）

### 2.4 演示数据 profile

```bash
java -jar target/campus-secondhand-backend-1.0.0.jar \
     --server.port=8080 --spring.profiles.active=demo \
     --app.demo.reset-confirmed=true
```

`demo` 是**重置型** profile：会重建演示数据集（16 件商品 / 9 笔订单 / 若干在线用户）。
⚠️ **演示进行到一半不要重启**，重启会把你现场操作出来的数据一起重置掉。

> ★★ **末尾那个 `--app.demo.reset-confirmed=true` 不能省** ★★
> 从本轮起，`DeploymentGuard` 会在**连数据库之前**检查：只带 `demo` 而不带这个开关，
> 进程直接拒绝启动，并在日志里列出会被清空的表（`t_goods` / `t_category` /
> `t_goods_audit_record` / `t_audit_log` 走 `DELETE FROM`，演示订单按主键删）。
> 这么做的原因：这是全项目唯一一个「启动参数写错就毁数据」的开关，
> 靠"记得别在生产上加"防不住 —— 改成默认安全、想重置的人**主动多敲一个参数**。
> 只想「建库、不重置」的话，去掉 `demo` 这个 profile 即可（默认行为就是这样）。

### 2.5 ★ 关于 `db/schema-auto.sql`

它是**从库结构反向生成的产物**，不是手写脚本：

- 改表结构后必须重新生成，否则新环境建出来的表与你本地的不一致；
- 重新生成命令：`node .workbuddy/gen-schema-auto.mjs`，校验：`--check`；
- ⛔ **绝不要**把「重建型」脚本（`DROP TABLE` + `CREATE`）配进 `spring.sql.init` ——
  那会让**每次启动都清库**。

---

## 3. 构建与测试

★ **统一用 `mvnw`（Maven Wrapper），不要依赖本机装的 `mvn`** ★
`mvnw` / `mvnw.cmd` 已随仓库提供，首次运行会自己把 Maven 3.9.4 拉到
`~/.m2/wrapper/dists/`（`distributionUrl` 指向阿里云镜像，国内可用）。
这样"我这儿能打包、服务器上不行"就不会再发生 —— 服务器上**只需要 JDK 17**。

```bash
./mvnw test                                    # 全量单元测试
./mvnw -DskipTests package                     # 开发包（含 demo 演示资源）
./mvnw -Pprod -DskipTests package              # ★ 生产包（物理剔除 demo 资源）
./mvnw test -Dtest=UserServiceGuardTest        # 只跑某一个测试类
```

Windows 下把 `./mvnw` 换成 `mvnw.cmd`。

测试基线：**后端 371 个用例全绿**；前端 **28 个测试文件 / 707 个用例**、`vue-tsc` 0 错误。

> 若 `mvnw test` 报 `Error reading old mojo status ... Input length = 1`，
> 是 IDE 留下的 GBK 缓存损坏：删掉 `target/maven-status` 再跑即可。

### 3.1 ★ 发版（生产包）—— 服务器**不构建**

```bash
node deploy/build-release.mjs            # 打包 + 产物自检 + 落 dist/
node deploy/build-release.mjs --tests    # 先跑全量单测再打包（发版建议）
node deploy/build-release.mjs --offline  # 强制离线构建（验证依赖是否齐备）
```

它做四件事：用 `-Pprod` 打包 → 重命名为带**版本 + commit/源码指纹 + 时间**的名字 →
产出 `.sha256` 校验和与 `.info.txt`（记录构建环境）→ **自检产物**。

★ 为什么要"服务器不构建" ★：本项目依赖 `spring-ai` 里程碑版，
构建需要访问 `repo.spring.io`。目标机器若在无外网 / 只放行国内镜像的环境里，
**构建会直接失败**。把"能不能连上境外 Maven 仓库"变成上线的前置条件，
是最不必要的一类故障源 —— 所以构建固定在本机/CI 完成，服务器只执行 `java -jar`。

★ 为什么脚本要自检产物 ★：它会解 jar 检查里面**有没有 demo 资源**
（`application-demo.yml`、`db/demo-*.sql`）。带上 `-Pprod` 时这些必须为 **0** 个，
否则脚本以**退出码 2 拒绝产出发布件**。
理由是这个错法特别贵：demo 脚本会把**真实商品、分类、订单、审核日志清空后换成演示数据**，
且不可回滚；而"打过包了、BUILD SUCCESS"这几个字**完全不能证明**资源被排除了。
（这条自检本身做过红绿：摘掉 `-Pprod` 后它确实会拦下并逐条点名 6 个 demo 文件。）

> 注：本仓库当前**不是 git 仓库**（有 `.github/` 但无 `.git`），
> 所以产物名里的标识来自**源码指纹**（`src/` + `pom.xml` 的内容摘要），
> 它仍能回答"两个包是不是同一份代码"，但**无法反查历史**。建议尽早 `git init`。

#### ★ 它会钉死 JDK 17，并**故意忽略你环境里的 `JAVA_HOME`** ★

实测踩过：本机 `JAVA_HOME` 指向 `D:\Android\Android Studio\jbr`
（Android Studio 自带的 JetBrains Runtime，**是 Java 21**）。
于是同一份源码、同一个 pom，两次构建的 `dist/` 产物大小差了 762 字节 ——
逐条比对发现 **73 个条目内容不同**（含 72 个我方 `.class`）。
`javap` 反汇编定位到根因：字符串拼接的降级策略不同，
`invokedynamic makeConcatWithConstants` vs `String.valueOf` + indy，常量池 122 条 vs 128 条。

后果不是"小差异"：**产物取决于开发机当时开着什么 IDE**。
"我测过的包"和"我发出去的包"就无法用任何哈希对上，
而这恰好是"服务器上跑的是不是我验过的那份"唯一能靠的东西。

所以脚本**不信任环境变量**：自己解析出一个真正的 JDK 17
（顺序：`--java-home=<path>` > `JDK17_HOME` > 已是 17 的 `JAVA_HOME` > 常见安装路径），
用它覆盖 `JAVA_HOME` 后再调 `mvnw`，并把解析过程打印出来（可复核）。
一个都找不到就**直接失败**，绝不"凑合用 21 也能编"——
那样就又回到不可复现了。若你的环境变量指向的不是 17，脚本会点名提示"已忽略"。

配合 `pom.xml` 里的 `<project.build.outputTimestamp>`（钉死 jar 条目时间戳），
**「源码 + 依赖」就唯一决定产物字节**。判据是**同一份源码连跑两次、产物 sha256 相同**（已实测通过）。

---

## 4. 目录结构

```
campus-secondhand-backend/
├── pom.xml
├── .gitignore                  ← ★ uploads/ 必须忽略（部署安全，见文件内注释）
├── docs/                       ← 全部设计/体检/部署文档
│   ├── 后端设计说明.md           ← ★ 主文档（含各轮修复的「附N」）
│   ├── 服务器部署适配清单.md
│   ├── 后端安全与健壮性体检报告.md
│   └── ...
├── uploads/                    ← 用户上传图片（★ 不进仓库）
└── src/
    ├── main/java/com/campus/market/
    │   ├── common/             ← Result / 错误码 / 全局异常 / 校验工具
    │   ├── config/             ← WebMvc、调度、MyBatis-Plus 等配置
    │   ├── controller/         ← 接口层（只做参数收发与鉴权入口）
    │   ├── entity/             ← 数据库实体
    │   ├── interceptor/        ← AuthInterceptor（★ 白名单在此，按「方法+路径」判定）
    │   ├── mapper/             ← MyBatis-Plus Mapper（复杂查询配 resources/mapper/*.xml）
    │   ├── security/           ← 登录失败闸门等安全组件
    │   ├── service/            ← 业务逻辑层（越权约束一律进 SQL）
    │   └── job/                ← @Scheduled 定时任务
    ├── main/resources/
    │   ├── application.yml
    │   ├── db/                 ← schema-auto.sql（生成物）/ seed-base.sql
    │   └── mapper/             ← 自定义 XML
    └── test/java/...           ← 单元测试
```

---

## 5. 接口约定（对接前端必读）

### 5.1 统一响应体

**所有请求一律 HTTP 200**，错误信息在 body 的业务码里：

```json
{ "code": 0, "message": "ok", "data": { } }
```

| code | 含义 | 前端行为 |
|---|---|---|
| `0` | 成功 | 取 `data` |
| `401` | 未登录 / token 失效 | **清 token 并跳登录页** |
| `403` | 已登录但无权限 | 提示无权限 |
| `404` | 资源不存在 | 提示不存在 |
| `1001` | **参数 / 业务规则拒绝** | 弹提示 |
| `1002` | 冲突类业务拒绝 | 弹提示 |
| `500` | **仅真正的服务端未捕获故障** | 提示稍后重试 |

> ★ `1001` 是「业务上说不行」的统一出口（库存不足、状态不允许、越权改他人数据…）。
> `500` 的语义被刻意收窄为「**后端坏了**」，不要拿它表示业务拒绝 ——
> 否则监控里真故障会被假故障淹没。

### 5.2 分页结构

```json
{ "code": 0, "data": { "list": [], "total": 0, "page": 1, "pageSize": 10 } }
```

字段名是 **`list`**，不是 `records`。

### 5.3 鉴权

- 登录返回 JWT，前端存下后逐请求带 `Authorization: Bearer <token>`；
- 服务端由 `AuthInterceptor` 统一校验：
  - **公开白名单写在拦截器内部、按「方法 + 路径」判定**（不是 `excludePathPatterns`）；
  - 同一路径可能 **GET 公开、POST 需登录**，所以不能用「整条路径放行」的写法；
  - `/uploads/**` **仅放行 GET**。

### 5.4 时间格式

统一 `yyyy-MM-dd HH:mm:ss`（受服务器时区影响，本地开发默认东八区）。

---

## 6. 配置项（环境变量）

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `SPRING_PROFILES_ACTIVE` | — | 设为 `demo` 启用演示数据 |
| `JWT_SECRET` | 内置兜底值 | ★ **生产必须显式注入** |
| `SPRINGDOC_API_DOCS_ENABLED` | `true` | ★ 生产置 `false` 关闭 OpenAPI JSON |
| `SPRINGDOC_SWAGGER_UI_ENABLED` | `true` | ★ 生产置 `false` 关闭 Swagger UI |
| `GOODS_AUTO_OFFLINE_ENABLED` | `true` | 商品自动下架开关 |
| `GOODS_AUTO_OFFLINE_CRON` | `0 30 3 * * ?` | 自动下架执行时间（默认每天 03:30） |
| `LOG_DIR` | `logs`（prod 为 `/data/campus/logs`） | 日志落盘目录 |
| `UPLOAD_DIR` | `uploads`（prod 为 `/data/campus/uploads`） | 图片落盘目录 |
| `UPLOAD_GUARD_USER_MAX_UPLOADS` | `10` | 单个用户在窗口内最多上传几张（0 / 负数 = 该维度不限） |
| `UPLOAD_GUARD_GLOBAL_MAX_UPLOADS` | `60` | ★ 全站同一窗口内的上限 —— **真正兜住磁盘的那条网**（用户维度拦不住「注册多个账号各传几张」）；**刻意不在错误提示里回显** |
| `UPLOAD_GUARD_WINDOW_SECONDS` | `60` | 计数窗口；配 `0` 会被收敛到 1 秒（0 毫秒窗口 = 闸门静默失效） |
| `HEALTH_DB_TIMEOUT_MS` | `2000` | ★ 健康检查探测数据库的**上界**（毫秒）。库挂住时探针必须自己先返回，否则「探针看不出故障」会退化成「探针自己不可用」。`0` / 负数会被**收敛到下限 200ms** —— 时限没有"无限等"这种选项 |
| `APP_TIME_ZONE_OFFSET` | `+08:00` | ★ 同时决定 JVM 与 MySQL 会话时区（**只有一个开关**） |
| `APP_INSTANCE_ID` | `0` | 多实例部署必配（0..9），同值会撞订单号 |
| `DB_URL` / `DB_USERNAME` / `DB_PASSWORD` | 本地默认 | prod 下**无默认值**，缺失即启动失败 |
| `APP_PAY_PUBLIC_BASE_URL` | 空 | ★ 支付回调地址的前缀，留空则支付宝渠道不可用 |
| `APP_PAY_ALIPAY_*` | 空 | 支付宝沙箱四项凭据，缺一即渠道不可用 |
| `AI_GUARD_USER_MAX_CALLS` | `30` | 单用户在 `WINDOW_SECONDS` 内的 AI 调用上限（0 / 负数 = 不限） |
| `AI_GUARD_GLOBAL_MAX_CALLS` | `300` | ★ 全站同一窗口内的上限 —— **唯一能兜住 AI 账单的那条网**，上线前按可接受月账单反推 |
| `AI_GUARD_WINDOW_SECONDS` | `600` | 计数窗口；配 `0` 会被收敛到 1 秒（0 毫秒窗口 = 闸门静默失效） |
| `AI_GUARD_MAX_TITLE_LENGTH` | `200` | 生成描述的商品标题上限（对齐 `t_goods.title VARCHAR(200)`） |
| `AI_GUARD_MAX_KEYWORDS_LENGTH` | `200` | 关键词上限 |
| `AI_GUARD_MAX_MESSAGE_LENGTH` | `200` | 客服提问上限（对齐前端输入框 `maxlength="200"`） |

> ★★ **`app.pay.*` 的环境变量一律带 `APP_` 前缀** ★★
> `app.pay.public-base-url` → `APP_PAY_PUBLIC_BASE_URL`（点与横线都转下划线）。
> 写漏了 `APP_`（例如 `PAY_PUBLIC_BASE_URL`）**不会报错**，只是绑不上：
> `publicBaseUrl` 保持空 → `notifyUrl()` 返回 null → 支付宝渠道**从收银台静默消失**。
> 这个前缀差异做过真机对照（`.workbuddy/e2e-pay-env.mjs`，三个场景 + `/pay/channels` 实测）：
> 全 `APP_PAY_*` ⇒ `["alipay_sandbox","wallet"]`；全 `PAY_*` ⇒ `["demo","wallet"]`；
> **只有回调地址一项漏前缀** ⇒ `["wallet"]`（渠道没了，日志里一条错都没有）。
> 同理 `app.pay.enabled-channels` 是 `APP_PAY_ENABLED_CHANNELS`。

> 支付相关配置的默认值全是"关闭"（失败关闭）：宁可不显示该渠道，
> 也不出现「能付款、但订单永远停在待付款」。
> 详见 `docs/服务器部署适配清单.md` §7.5。

> ⚠️ **接口文档公开 = 一份免费的侦察地图**（接口名、参数、字段含义全在里面）。
> 正式对外部署时请把两个 `SPRINGDOC_*` 开关置 `false`。

> ★ **AI 助手（`/ai/**`）的三个配置口径** ★
> 1. 这两个接口**要登录**才能调，但那不等于安全 —— 一个注册账号写个 for 循环就能打上万次，
>    每次都是真实支出。所以另有 `AiQuotaGuard` 双维度闸门：用户维度管**公平**，
>    全站维度管**钱**（费用按调用次数产生、与是谁在调无关）。
> 2. **超长一律报错（1001）而不是截断**：静默截断会让用户拿到一段忽略了他后半句的 AI 结果，
>    且无从知道原因。上限值会写进错误提示里。
> 3. `app.ai-guard.*` 的默认值**只在 `application.yml` 一处定义**，刻意不在
>    `application-prod.yml` 重复声明 —— 两边各写一份 = 同一个概念两个开关，
>    日后只改一处就会出现「配置文件里明明调过、实际没生效」。
> 4. 提示注入做的是**角色隔离**（`SystemMessage` + `UserMessage` 两条独立消息）+ 输入围栏，
>    **不是「已根治」**：模型输出只用于填充商品描述 / 客服话术，没有工具调用与数据访问权限。
>    详见 `docs/服务器部署适配清单.md` §7.6。

---

## 7. 定时任务

| 任务 | 类 | 默认 cron | 作用 |
|---|---|---|---|
| 商品自动下架 | `job/GoodsOfflineJob` | 每天 03:30 | 把超过 `t_settings.auto_offline_days` 天未成交的在售商品下架 |
| 支付超时关单 | `job/PaymentTimeoutJob` | 每 5 分钟 | 关掉 `pay_expire_at` 已过期仍未付款的订单（先关支付单，再逐笔关订单） |

> ★ 支付超时关单**逐笔独立事务**（整批共用事务时，一笔数据异常会让每一轮都卡在同一笔上）。
> 开关：`app.pay.timeout-enabled`（默认 true）；批量上限 `app.pay.close-batch-size`（默认 200）。
> 关掉某笔订单前会先让它名下的支付单失效，否则用户刚被关单又能立刻付款成功。

- 天数配置为 **`0` / 空 / 负数 = 关闭该功能**（缺配置时放宽，绝不收紧）；
- 判据是 `create_time`（**不是 `update_time`** —— 后者会被收藏/浏览自动刷新）；
- 管理端另有**手工入口**：`GET /admin/goods/auto-offline`（预览，只数不改）、
  `POST /admin/goods/auto-offline`（立即执行），**仅 admin**。

> 多实例部署时 `@Scheduled` 会每个实例各跑一次。当前实现幂等（不会重复改数据），
> 但会重复写审计日志；真要集群部署需加分布式锁。

---

## 8. 相关文档

| 文档 | 内容 |
|---|---|
| `docs/后端设计说明.md` | **主文档**：分层设计、事务、鉴权、各轮修复明细（「附一」～「附二十八」） |
| `docs/服务器部署适配清单.md` | 上线前要做的六维适配 |
| `docs/后端安全与健壮性体检报告.md` | 安全维度体检 |
| `../项目缺陷检查与修复清单.md` | 全项目缺陷台账与修复进展 |
| `../缺陷清单逐条核对报告.md` | 对台账的**逐条复核**（含订正与销项） |

---

## 9. 已知限制

- AI 助手的**频控与长度上限已补齐**（`AiQuotaGuard` + `app.ai-guard.*`，见 §6 与部署清单 §7.6），
  但仍属**概率性防护**：提示注入没有被“根治”，只是被抬高了成本；闸门是纯内存实现，
  **多实例部署时每个实例各算各的**（总容忍度放大 N 倍）；
- 订单号生成依赖**单实例内存自增**，多实例部署有撞号风险；
- 消息模块是**轮询**而非 WebSocket 推送；
- 前端部分路由与后端匿名白名单的「游客能力」尚未对齐（属产品决策项）；
- 会话凭据已改为 **HttpOnly Cookie**（`c2c-token`，`SameSite=Lax`）：JS 读不到，XSS 拿不走；
  响应体里的 `token` **仍返回**（契约不变），所以正在发生 XSS 的那一刻仍可能从登录响应里截获（残留风险，见设计说明附二十八）；
  登出只清浏览器侧票据，服务端不维护黑名单 —— 「让已发出的票立即失效」靠 `token_version`（改密/重置即 +1）；
- 鉴权快照缓存（P1-11）是**进程内**的：多实例各一份，显式失效只作用于处理该请求的实例，
  另一台要等 TTL（≤10 秒）。由此「封禁的生效延迟」不是统一值：自带服务层状态校验的端点
  （如 `GET /user/profile`）仍立即拒绝，只靠拦截器的端点（如 `POST /user/heartbeat`）最坏慢 10 秒；
  经应用正常路径封禁（`POST /admin/users/{id}/ban`）一律**立即**生效；
- 健康检查 `GET /health`（P1-5）**恒返回 HTTP 200**（沿用「错误一律 200」契约）
  ⇒ **监控必须判 body 的 `data.status`，不要判状态码**；它只覆盖「数据库 + 日志目录 + 构建号」，
  不含磁盘余量/连接池水位；探测上界见 `HEALTH_DB_TIMEOUT_MS`（配 0 会收敛到下限 200ms）；
- 请求上下文（P1-6）只覆盖**请求线程**，且**成功的请求一行日志都不打** ⇒
  「每行日志都带 traceId/uid/method/uri」的价值只在异常与告警那几行上兑现；
  异步任务与子线程不在范围内（定时任务由 `GoodsOfflineJob` 自设 `job-*` id）。

- 上传接口的次数闸门（P1-10）同样是**纯内存、单实例**实现：多实例各算各的（总容忍度放大 N 倍），
  重启即清零；魔数嗅探只保证「是这几种图片容器」，**不校验解码后的内容**
  （畸形结构 / 压缩炸弹仍需后续处理环节与部署侧磁盘配额配合）。
