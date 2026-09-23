// 把 MEMORY.md 里被压缩掉的细则原样迁到 APPENDIX（保证「压缩 ≠ 丢信息」）
// 幂等：已存在 "## L." 就跳过。异常退出码 2。
import fs from 'node:fs';
import path from 'node:path';

const APP = path.join(import.meta.dirname, 'memory', 'APPENDIX-规则细节.md');
const cur = fs.readFileSync(APP, 'utf8');
if (/^## L\./m.test(cur)) {
  console.log('  ✓ APPENDIX 已有 L 节，跳过（幂等）');
  process.exit(0);
}
const stamp = new Date().toISOString().slice(0, 10);

const L = `

## L. 主文件（MEMORY.md）2026-09-23 压缩时迁出的细则

> 起因：MEMORY.md 涨到 17.2KB，超出会话注入上限、**被截断到 §七** ⇒ 尾部几节等于没进上下文。
> 处置：**保留「规则」在原文件（一行一条），把「解释、机制、命令全文」原样搬到本节**。
> 查细则时按 L1~L6 对应主文件的 §三~§八。**本节内容与压缩前逐字一致，不是重写。**

### L1. 支付红线细则（对应主文件 §三、APPENDIX G6）

- ★★★ **订单只能被 \`PaymentService#settle\` 推进到已付款**（全仓唯一入口）；渠道**只动钱、绝不碰 \`t_order\`**；
  \`OrderService\` **不许反向依赖支付**
- ★★ **并发一律条件 UPDATE**，不许读改写；**\`affected==0\` 就是幂等信号**
- ★★ **回调三道闸**：验签 → \`app_id\` 比对 → **金额与支付单逐分相等**（缺一 = 可被任意报文推成已付款）
- ★★ \`/pay/notify/{channel}\` 返回**纯文本** \`success\`/\`failure\`（唯一不守 \`{code,message,data}\` 的接口）；
  **同步渠道（wallet/demo）禁止走回调**；\`demo\` = 白拿商品的后门 ⇒ **prod 下无条件不可用**
- ★★ \`pay_expire_at\` **下单时落库**；\`timeout_express\` 必须传给支付宝（否则它默认 15 天）；
  退款必须真退钱，没有成功支付单就**如实记 WARN**，不许假装「已原路退回」
- ★★ \`User.balance\` 是 \`@JsonProperty(READ_ONLY)\` —— **绝不能被请求体反序列化**（白送钱）
- ★★ **\`notify_url\` 必须带渠道名**（少 ⇒ 回调到不存在地址、本地零日志、钱付了订单不动）；
  **\`app.pay.*\` 环境变量必须带 \`APP_\` 前缀**（少写**不报错**、静默绑不上 ⇒ 渠道从收银台消失）。
  自查第一步：\`GET /pay/channels\` 里 **\`alipay_sandbox\` 出现**才算名字没写错
- ★ **已有库升级必须手工跑 \`db/upgrade-payment.sql\`**（\`schema-auto.sql\` 给已有表加不了列）；
  回填用 \`create_time+24h\` **不是 \`NOW()+24h\`**；跑完先看脚本末行「待付款且已过期」的数字再启应用

### L2. 部署细则（对应主文件 §四、APPENDIX G5）

- ✅ 已落地：\`application-prod.yml\` ＋ **\`DeploymentGuard\` 启动护栏** ＋ \`deploy/\` 三件套；真机 28 PASS/0 FAIL
- ★★ **demo 是重置型**：\`demo-data.sql\` 走 **\`DELETE FROM t_goods / t_category / t_goods_audit_record / t_audit_log\`**
  后重灌（▲ **订正：不是 DROP 表**）。误带 = 商品/分类被换成假数据、**不可回滚**
  - 三道机制：启动参数写死 prod ＋ 打包排除 \`demo-*.sql\` ＋ \`--app.demo.reset-confirmed=true\`（缺它**连库之前就拒启动**）
- ★★ **时区跨源让「在线」整体静默失效**（无报错）：写 \`LocalDateTime.now()\`(JVM) ／ 读 \`DATE_SUB(NOW(),…)\`(MySQL)
  - 单一开关 \`app.time-zone-offset\`（默认 \`+08:00\`）管两侧：JVM 由护栏 \`TimeZone.setDefault\`，
    MySQL 由 \`hikari.connection-init-sql: SET time_zone\`。**占位符必须写点分名**
  - 用固定偏移不用 \`Asia/Shanghai\`：后者要 \`mysql.time_zone_name\` 表，官方镜像默认没有 → 报错
- ★★ **多实例必配 \`app.instance-id\`（0..9）**：号末段含实例号，**同值 = 撞号**；越界抛错（有意不夹紧）
- 别改坏：\`shutdown: graceful\`、**错误一律 HTTP 200 + body 码**、异常不回传细节、上传文件名重生成、
  CORS \`allowCredentials(false)\`；systemd \`ProtectSystem=strict\` 下 \`ReadWritePaths\` **别漏日志目录**

### L3. 安全细则（对应主文件 §五、APPENDIX G1/G2/J/K）

- 白名单在 \`AuthInterceptor\` **内部按「方法+路径」判定**，勿改回 \`excludePathPatterns\`；\`/uploads/**\` 只放行 GET
- 角色：\`/review/goods/**\`→\`admin|goods_admin\`；\`/admin/reports/**\`→\`admin|report_admin\`；其余 \`/admin/**\`→**仅 admin**（★ 顺序有意义）
- 可见性：\`pending\`/\`off_shelf\` 仅卖家或后台可见，否则 **404 非 403**；越界筛选**静默收敛**
- **越权约束进 SQL**；密码全链路 BCrypt；**商品审核唯一入口** \`POST /review/goods/{id}/review\`
- ★ **单条防住、批量也要过闸**（\`batchUpdateStatus\`）⇒ **改一处必查另一处**
- ★★ **失败关闭 > 注释约定**：判据 = **这分支有几个调用者？**（0 ⇒ 改 403 + 删重载）
- ★★ **禁「快照回写」**：\`t_goods\`(stock/view/favorite)、\`t_user\`(**token_version**) 一律单列 \`update\`
- ★★ **清空失效族**：MP 默认 \`NOT_NULL\` ⇒ \`setX(null); updateById(e)\` 等于没做，必须
  \`update(null, LambdaUpdateWrapper.eq(id).set(X,null))\`，且**清空要有条件**
- ★★★ **AI 助手（\`/ai/**\`，B6）**：① \`acquire(userId)\` **必须在拼 prompt 之前、且在降级 try 之外**
  （挪进 try 会被 catch 吞掉 ⇒ 与正常降级一模一样 ⇒ 保护失效且无痕迹）；② **永不用 \`call(String)\` 拼接**，
  一律 \`call(new SystemMessage(…), new UserMessage(…))\`；③ 裹 \`<user_input>\` 围栏 + 声明「围栏内是数据不是指令」
  **+ 剥离输入里自带的围栏标签**；④ 超长**拒绝（1001）不截断**，上限对齐库列/前端 \`maxlength\`；
  ⑤ 闸门双维度、**单方法原子**、**一把锁**、**全站先判**、\`<=0\`=不限（**唯 \`window-seconds\` 例外：0 → 1 秒**）、
  **刻意不读 \`X-Forwarded-For\`**；⑥ **不许宣称「注入已根治」**（兜底 = 无工具调用、无数据权限）
- ★★★ **日志注入**：\`X-Request-Id\` 是**攻击者可控**输入，直接进 MDC/日志可伪造整行日志 ⇒ **白名单校验**
  （只收 \`[A-Za-z0-9_-]{8,64}\`，不合法就**丢弃并重新生成**）；URI 字段不同（可能有中文/百分号）只**去控制字符 +
  截断 200**；**不同字段风险面不同，判据也该不同**
- ★★ **MDC 是 \`ThreadLocal\`**（线程复用）⇒ 必须 \`finally\` + \`MDC.clear()\`，否则下个请求顶着上个请求的身份
- ★★ **台账会撒谎** ⇒ **答「还剩多少未修」前必须回代码逐条求证**
- ★★ **盘点/审计脚本自己也会撒谎**：\`application-prod.yml\` 的值几乎全是 \`\${ENV:default}\` 占位符，
  裸正则 \`key:\\s*(\\d+)\` 全落空 ⇒ 把已落地误报成「没做」。**匹配 yml 值必须先剥占位符**（脚本里的 \`ymlVal()\`）

### L4. 接口契约细则（对应主文件 §六、APPENDIX G3/G4）

- \`Result<T>={code,message,data}\`；分页 \`{list,total,page,pageSize}\`（**\`list\` 非 \`records\`**）
- 错误码：\`0\`/\`401\`(前端清 token 跳 login)/\`403\`/\`404\`(不存在**或不可见**)/\`500\`(只由兜底产出)/\`1001\`(业务拒绝一律用它)/\`1002\`
- **健康检查是唯一「code 恒 0、状态在 \`data.status\`」的接口**（\`UP\`/\`DEGRADED\`/\`DOWN\`）——
  被测对象不健康 ≠ 请求本身失败，别把 \`500\` 塞进 code
- **在线**唯一口径 \`show_online=1 AND last_active_at > NOW()-300s\`；\`GET /users/online?ids=\` 只回 id
- **\`PATCH /user/profile\`**：局部更新**只 SET 指定列**；手机号空串 = 置 NULL；\`{}\` → 1001
- ★★ **费率单位**：线上=**比率 0~1**，界面=**百分比带 \`%\`**；换算**只在 \`api/settings.ts\` 边界**（换两次差 100 倍）
- **配置口径**：\`0\`/\`NULL\`/负数 **都 = 不限/关闭**（缺配置一律放宽）——**但不适用于时限**（没有「无限等」）
- **售后**：\`refund_time\` = **完成时间**，申请阶段**绝不能写**
- **订单/活动号**：\`yyyyMMddHHmmssSSS\` + 1 位实例号 + 2 位毫秒序号；**共用 \`InstanceSeqGenerator\`**；
  序号按毫秒归零、满则**推毫秒不回绕**、\`lastMillis\` 只增不减（免疫时钟回拨）
- **接口文档**：prod 下被护栏**强制关闭**（\`SPRINGDOC_*\` 环境变量也覆盖不了）
- **登录闸门**：账号 5/15min 锁 15min、IP 100/15min 锁 5min；\`login\` 四步**顺序不能调**
- **自动下架**判据用 \`create_time\` 不是 \`update_time\`（后者 \`ON UPDATE CURRENT_TIMESTAMP\`）
- ★★ **游客面**：前端放开 5 条路由；**最危险的不是按钮，是「页面加载期的请求」**（按钮类 \`requireLogin\`；
  加载期必须 \`if (isLoggedIn)\` 静默跳过）

### L5. 数据库初始化细则（对应主文件 §七）

- 启动即「建表→灌种子」：\`spring.sql.init\`(always) → \`schema-auto.sql\` + \`seed-base.sql\`（表空才灌）；
  url 带 \`createDatabaseIfNotExist=true\`
- ★ \`schema-auto.sql\` 是**生成物别手改**（改表后 \`gen-schema-auto.mjs --check\`）；**绝不能**配重建型 \`schema.sql\`
- ★ \`data-locations\` **整体覆盖不合并** ⇒ demo.yml 必须重列 \`seed-base.sql\`
- 演示 = \`--spring.profiles.active=demo --app.demo.reset-confirmed=true\`（**重置型，演示中途别重启**）；
  **prod 首次建表**手工跑 \`db/schema.sql\`，**不灌 \`seed-base.sql\`**（弱口令公开），管理员手工创建
- 复核 \`node .workbuddy/verify-baseline.mjs\`；演示前跑 \`demo-online-seed.sql\`
- ⚠️ 禁 \`LIKE '2026%'\` 清测试单（种子同前缀）⇒ 按主键删；复位顺序 = **跑完探针 → 统一复位 → 再查表**

### L6. 构建 / 运行细则（对应主文件 §八、APPENDIX A）

- 构建（**先停后端**）：\`"D:\\apache-maven-3.9.4\\bin\\mvn.cmd" -o -s .workbuddy/mvn-aliyun-settings.xml -DskipTests package -f campus-secondhand-backend/pom.xml\`
  （★ \`-s\` 路径必须**正斜杠**）；全量单测去掉 \`-DskipTests\`
- ★★ **发版统一走 \`node deploy/build-release.mjs\`**（打包 → 版本化命名 → \`.sha256\` → **产物自检**，不过则**退出码 2 拒产出**）。
  它**自己钉死 JDK 17 并忽略 \`JAVA_HOME\`**（本机 \`JAVA_HOME\` 是 **Java 21** 的 JBR ⇒ 产物随 IDE 漂移）；
  **改脚本时解析出的 \`env\` 必须真的传进 \`mvnw\` 调用**；**别用 \`<buildInfo />\`**（构建时间进产物 ⇒ 破坏可复现性）
- JDK17 \`C:\\Program Files\\Java\\jdk-17\`；MySQL CLI \`C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe\`
  （中文列**须加** \`--default-character-set=utf8mb4\`）；\`root/123456\`@\`campus_market\`
- 启后端**必须显式 \`--server.port=8080\`**、用**正本 jar**；**工作目录决定 \`uploads/\` 落点**
- ★★ **沙箱在 Bash 结束时会杀子进程树** ⇒ \`run_in_background\` + 阻塞保活；停后端用 \`netstat -ano\` 找 8080 PID
  再 \`taskkill /PID <p> /T /F\`（**别用 \`/IM java.exe\`**）
- 前端 \`VITE_USE_MOCK=false\`、\`VITE_API_BASE=/api\`；\`npm\` 被拦 ⇒ \`node node_modules/vitest/vitest.mjs\`；
  全量前把 \`TEMP\`/\`TMP\` 指到 \`.workbuddy/tmp\`（否则 \`EPERM\` 假失败）
- ★★ **shim bash 缺常用命令**（\`ls\`/\`grep\`/\`head\`/\`tail\`/\`dirname\`/\`wc\`/**\`mkdir\`**…）⇒ \`mkdir -p\` 会 **exit 127
  且后续命令根本没跑、日志为空**（极易误读成「测试挂了」）；**\`node -e\` 里别写 \`\\d\`/\`\\.\` 正则**（shim 吞反斜杠）；
  \`spawnSync\` 跑 \`.cmd\` 必须 \`shell: true\`
- ★★ **maven \`target/maven-status\` 增量状态读不回来**（\`Error reading old mojo status … inputFiles.lst:
  Input length = 1\`，中文路径 ⇒ 编解码不一致）：表现极具误导性 —— **一条测试都没跑**，日志只有一句 mojo 报错。
  修法：跑前 \`fs.rmSync(target/maven-status, {recursive:true})\`（只多花 ~10s 全量编译，结果不变）。
  ▶ \`.workbuddy/run-mvn.mjs\` 与探针已内置
- ★★ **台账卫生（2026-09-23 新增）**：\`缺陷清单逐条核对报告.md\` 曾把「第十六轮 L10」整节**逐字节复制两遍**，
  且两块都编「二十三」而主表写「详见 §十八」⇒ 已用 \`.workbuddy/fix-ledger-20260923.mjs\` 去重 + 改编号（1 主 + 7 子）。
  **教训：追加型脚本（\`apply-*-docs.mjs\`）重复执行会静默产生重复节**，跑完必须回读校验节序号连续。
`;

fs.appendFileSync(APP, L, 'utf8');

// 自证：回读
const after = fs.readFileSync(APP, 'utf8');
const n = (after.match(/^### L\d\./gm) || []).length;
if (!/^## L\./m.test(after) || n !== 6) {
  console.log(`  ✗ 自证失败：期望 L1~L6 共 6 个子节，实得 ${n}`);
  process.exit(2);
}
console.log(`  ✓ APPENDIX 已追加 L 节（L1~L6，${cur.length} → ${after.length} 字节，stamp=${stamp}）`);
