/**
 * P0 真机探针：部署护栏（DeploymentGuard）＋ prod profile ＋ 时区对齐
 * ============================================================================
 * 全程真实 java 进程 + 真实 MySQL，不做源码推断。证明五件事：
 *
 * 【一】护栏真的挂上了（不是"文件写了但没生效"）
 *       spring.factories 写错文件名/路径时，EnvironmentPostProcessor 会**静默失效** ——
 *       单测（直接 new DeploymentGuard）全绿也发现不了。所以这里必须真起进程。
 *
 * 【二】护栏跑在 DataSource 之前（★ 这是它唯一的存在理由 ★）
 *       判定方法：护栏生效时进程根本不会连库，所以一次性库里**一张表都不会建**。
 *       如果哪天护栏被挪到 @Component 里，库会被 demo 脚本重置 —— 那时这里会立刻变红。
 *
 * 【三】prod 的凭据闸门依次生效（缺 JWT_SECRET / 兜底密钥 / 默认库口令）。
 *
 * 【四】prod 下接口文档被**强制**关闭：即使环境变量写着 SPRINGDOC_*_ENABLED=true 也是 404。
 *
 * 【五】★ 时区对齐真的生效，且这条断言有判别力 ★
 *       刻意让 JVM 侧偏移比 MySQL 服务器默认偏移**差 1 小时**：
 *         · 若 connection-init-sql 真的执行 → MySQL 会话被改成同一个偏移 → 在线 ✓
 *         · 若它没执行（写错名字/被忽略）→ 会话停在服务器默认 → 差 1 小时 → 离线 ✗
 *       即：单靠"在线"这一个结果就能区分"修好了"和"没修"，不需要额外打点。
 *       并按红绿规矩：先临时去掉 init-sql 跑一次必须**红**，还原后再跑必须**绿**。
 *
 * 数据安全：全程只碰一次性库 campus_guard_probe 与一次性账号 guard_probe，
 * 收尾 DROP 掉。**不碰演示主库 campus_market**（护栏若失效也只会毁这个一次性库）。
 *
 * 用法：node .workbuddy/e2e-p0-guard.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'

const ROOT = 'C:/Users/刘宝杰/Desktop/软件开发项目实践/软件开发/实践任务3：后端开发(前后端分离)'
const JAR = path.join(ROOT, 'campus-secondhand-backend/target/campus-secondhand-backend-1.0.0.jar')
/**
 * ★ 为什么要把 jar 解开再跑，而不是直接 java -jar ★
 * 【五】的红绿用例需要**在运行时改掉 application-prod.yml**（去掉 connection-init-sql）。
 * 但 java -jar 读的是 jar 里的那份 yml，改 src/main/resources 下的源码文件对运行**毫无影响** ——
 * 那样跑出来的"红"是假的，等于没做红绿。解开之后就能直接改 classes 里那一份。
 */
const EXPLODED = path.join(ROOT, '.workbuddy/tmp/p0-exploded')
const CLASSES = path.join(EXPLODED, 'BOOT-INF/classes')
/**
 * ★ classpath 必须把「jar 根目录」也带上，不能只给 BOOT-INF/classes ★
 * spring-boot-maven-plugin 的 repackage 把 META-INF/** **留在 fat jar 的根目录**，
 * 不会复制进 BOOT-INF/classes（实测 jar tf：META-INF/spring.factories 在根，
 * BOOT-INF/classes 下连 META-INF 目录都没有）。
 * 于是只用 '-cp BOOT-INF/classes' 跑时，SpringFactoriesLoader 找不到 spring.factories，
 * 护栏**静默失效** —— 单测全绿、日志无任何异常，就是不起作用。
 * 而 'java -jar' 的类加载器同时能看到 jar 根与 BOOT-INF/classes，所以部署时是好的。
 * 这里把根目录一并放进 classpath，就是为了让探针的视图与真实部署一致。
 */
const CP = [EXPLODED, CLASSES, path.join(EXPLODED, 'BOOT-INF/lib/*')].join(';')
const MAIN = 'com.campus.market.CampusMarketApplication'
const PROD_YML = path.join(CLASSES, 'application-prod.yml')
const JAVA = 'C:/Program Files/Java/jdk-17/bin/java.exe'
const MYSQL = 'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe'
const BASE = 'http://127.0.0.1:8080/api'

/* 一次性环境：护栏一旦失效，被 demo 脚本重置的也只会是这里 */
const SDB = 'campus_guard_probe'
const SUSER = 'guard_probe'
const SPASS = 'ProbePass-9f3a!x'
const SURL = `jdbc:mysql://127.0.0.1:3306/${SDB}?useUnicode=true&characterEncoding=utf-8&useSSL=false&allowPublicKeyRetrieval=true&createDatabaseIfNotExist=true`
const GOOD_SECRET = 'Zq3F7u9Lp2Xc8Vn5Tb1Rw6Yh4Km0Ds9Ag2Jf5Hc7Ne1Bv3Xz8'
const FALLBACK_SECRET = 'campus-secondhand-market-jwt-secret-key-2024'

for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) process.env[k] = ''

/* ---------------- 断言 ---------------- */
let pass = 0, fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

/* ---------------- MySQL 助手 ---------------- */
function mysqlAs(user, pass, db, sql) {
  return execFileSync(MYSQL,
    ['-h127.0.0.1', '-u' + user, '-p' + pass, '--default-character-set=utf8mb4', db],
    { input: sql + '\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}
const mysqlRoot = (sql, db = '') => mysqlAs('root', '123456', db, sql)
function scalarRoot(sql, db = '') {
  const out = mysqlRoot(sql, db).replace(/\r/g, '').trimEnd().split('\n')
  if (out.length < 2) return null
  return out[1].split('\t')[0]
}

/* ---------------- 进程助手 ---------------- */
function killPort8080() {
  try {
    const net = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
    const pids = new Set()
    for (const l of net.split(/\r?\n/)) {
      if (!/:8080\s/.test(l) || !/LISTENING/i.test(l)) continue
      const p = l.trim().split(/\s+/).pop()
      if (/^\d+$/.test(p)) pids.add(p)
    }
    for (const pid of pids) {
      try { execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已退出 */ }
    }
  } catch { /* 没有占用 */ }
}

/**
 * ★ 控制台输出是 GBK，不是 UTF-8 ★
 * Windows 中文环境下 java 的 System.out 用平台默认字符集（CP936/GBK）。
 * 按 UTF-8 解码会得到乱码，于是**所有含中文的断言都会静默失败** ——
 * 看起来像"护栏没打印那句话"，其实是探针自己读错了。
 * 这里统一按 GBK 解码（Node 22 自带 full-icu，支持 'gbk'）。
 */
let DECODER
try { DECODER = new TextDecoder('gbk') } catch { DECODER = new TextDecoder('utf-8') }
/**
 * ★ 必须先把所有 chunk 拼成一整块再解码，不能逐块解码 ★
 * GBK 是多字节编码，一个汉字可能被切在两个 chunk 边界上；逐块用 TextDecoder.decode()
 * 且不加 stream 选项时，边界处会吐出替换字符 —— 中文断言就会随机失败，
 * 而且失败得毫无规律（正是最难查的那种）。
 */
const decode = (bufs) => DECODER.decode(Buffer.concat(bufs))

/** 起一次 java，等它自己退出（用于「必须启动失败」的用例） */
function runToExit(args, { timeoutMs = 90000, env = {} } = {}) {
  const t0 = Date.now()
  const bufs = []
  const child = spawn(JAVA, args, {
    cwd: path.join(ROOT, 'campus-secondhand-backend'),
    env: { ...process.env, ...env },
  })
  child.stdout.on('data', (d) => bufs.push(d))
  child.stderr.on('data', (d) => bufs.push(d))
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: 'TIMEOUT', out: decode(bufs), ms: Date.now() - t0 }) }, timeoutMs)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out: decode(bufs), ms: Date.now() - t0 }) })
  })
}

/** 起一次 java 并等它 ready（用于「必须启动成功」的用例） */
async function boot(args, { timeoutMs = 120000, env = {} } = {}) {
  // ★ 先把 8080 清干净再起 ★ 否则上一轮实例还活着时，boot() 会因为"能访问到接口"
  // 而误判成"这次启动成功了"，后面所有 HTTP 断言其实打在旧实例上。
  killPort8080()
  await new Promise((r) => setTimeout(r, 500))
  const bufs = []
  const child = spawn(JAVA, args, {
    cwd: path.join(ROOT, 'campus-secondhand-backend'),
    env: { ...process.env, ...env },
  })
  child.stdout.on('data', (d) => bufs.push(d))
  child.stderr.on('data', (d) => bufs.push(d))
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const out = decode(bufs)
    if (out.includes('APPLICATION FAILED TO START') || out.includes('启动被拒绝')) break
    try {
      const r = await fetch(BASE + '/goods?page=1&pageSize=1')
      if (r.ok) return { child, out, ready: true }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 800))
  }
  return { child, out: decode(bufs), ready: false }
}
async function shutdown(child) {
  try {
    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 2500))
    if (!child.killed) child.kill('SIGKILL')
  } catch { /* ignore */ }
  killPort8080()
}

/* ---------------- HTTP 助手 ---------------- */
async function call(method, p, { token, body } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers['Authorization'] = 'Bearer ' + token
  const res = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { http: res.status, code: json?.code, data: json?.data, raw: text.slice(0, 160) }
}
async function login(u, pw) {
  const r = await call('POST', '/user/login', { body: { username: u, password: pw } })
  return r.data?.token ?? null
}

/* ---------------- 主流程 ---------------- */
function setupScratchDb() {
  mysqlRoot(`CREATE DATABASE IF NOT EXISTS ${SDB} DEFAULT CHARSET utf8mb4;`)
  try { mysqlRoot(`CREATE USER IF NOT EXISTS '${SUSER}'@'%' IDENTIFIED BY '${SPASS}';`) } catch (e) { console.log('  (建用户跳过: ' + e.message.slice(0, 80) + ')') }
  try { mysqlRoot(`GRANT ALL PRIVILEGES ON ${SDB}.* TO '${SUSER}'@'%';`) } catch (e) { console.log('  (授权跳过: ' + e.message.slice(0, 80) + ')') }
  mysqlRoot('FLUSH PRIVILEGES;')
}
function tableCount() {
  return Number(scalarRoot('SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=\'' + SDB + '\';'))
}
function cleanupScratchDb() {
  try { mysqlRoot(`DROP DATABASE IF EXISTS ${SDB};`) } catch { /* ignore */ }
  try { mysqlRoot(`DROP USER IF EXISTS '${SUSER}'@'%';`) } catch { /* ignore */ }
}

async function main() {
  console.log('=== P0 真机探针：部署护栏 / prod profile / 时区对齐 ===\n')
  if (!fs.existsSync(JAR)) { console.log('打包产物不存在：' + JAR); process.exit(2) }
  if (!fs.existsSync(JAVA)) { console.log('JDK 不存在：' + JAVA); process.exit(2) }

  /* 解开 jar（见 EXPLODED 处的说明），并自检解出来的确实含本轮新增的东西 */
  fs.rmSync(EXPLODED, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(EXPLODED), { recursive: true })
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory('${JAR.replace(/\\/g, '\\\\')}', '${EXPLODED.replace(/\\/g, '\\\\')}')`],
    { stdio: 'ignore' })
  check('jar 已解开到 ' + path.relative(ROOT, EXPLODED), fs.existsSync(PROD_YML))
  check('解出的 classes 含 DeploymentGuard.class',
    fs.existsSync(path.join(CLASSES, 'com/campus/market/config/DeploymentGuard.class')))
  // spring.factories 在 fat jar 的**根目录**（不是 BOOT-INF/classes 下），
  // 所以这里按真实布局去找；找不到就说明 classpath 视图搭错了，后面全是假的。
  const factoriesPath = path.join(EXPLODED, 'META-INF/spring.factories')
  const factories = fs.existsSync(factoriesPath) ? fs.readFileSync(factoriesPath, 'utf8') : ''
  check('fat jar 根目录有 META-INF/spring.factories 且注册了 DeploymentGuard',
    factories.includes('DeploymentGuard'),
    '未找到或内容不含 DeploymentGuard（spring.factories 是护栏唯一的注册入口）')

  killPort8080()
  cleanupScratchDb()
  setupScratchDb()
  const before = tableCount()
  check('前置：一次性库 ' + SDB + ' 是空库', before === 0, '实际表数 ' + before)
  if (before !== 0) { cleanupScratchDb(); process.exit(1) }

  /**
   * ★ 所有配置一律走**环境变量**，不通过 --xxx= 命令行传 ★
   * 两方面的原因：
   *   1. 生产就是这么跑的（systemd EnvironmentFile），探针该与部署形态一致；
   *   2. 命令行参数**不做宽松绑定**：`--APP_TIME_ZONE_OFFSET=+07:00` 只会被
   *      占位符 ${APP_TIME_ZONE_OFFSET:...} 看见，而护栏读的 app.time-zone-offset
   *      读不到它 —— 两端各拿各的值，"一个开关"被悄悄拆成两个。
   *      改成环境变量后，SystemEnvironmentPropertySource 的点→下划线宽松匹配
   *      保证两种写法都指向同一个键。
   */
  const baseEnv = () => ({ DB_URL: SURL, DB_USERNAME: SUSER, DB_PASSWORD: SPASS })

  try {
    /* ---------- 【一】【二】demo 未确认 → 必须拒绝，且不许连库 ---------- */
    console.log('\n--- PART 1  demo 未显式确认 ---')
    {
      const r = await runToExit(['-Duser.timezone=UTC', '-cp', CP, MAIN,
        '--server.port=8080', '--spring.profiles.active=demo'], { env: baseEnv() })
      check('demo 未确认 → 进程非零退出', r.code !== 0, '退出码 ' + r.code)
      check('日志给出「启动被拒绝」', r.out.includes('启动被拒绝'))
      check('日志说清会 DELETE FROM t_goods', r.out.includes('DELETE FROM t_goods'))
      check('日志给出确认开关名', r.out.includes('app.demo.reset-confirmed'))
      check('★ 护栏跑在 DataSource 之前 → 一次库仍为空', tableCount() === 0,
        '表数 ' + tableCount() + '（非 0 说明护栏没拦住建表，库已被重置）')
    }

    /* ---------- 【一-RED】把 spring.factories 拿掉，护栏必须消失 ---------- */
    /*
     * ★ 这一段是 PART 1 那批断言的「红」★
     * 没有它，PART 1 全绿只能说明"这次跑通了"，说明不了"这些断言真能抓到护栏没挂上"
     * —— 而"护栏没挂上"恰恰是本轮最容易发生、且最安静的一种失败：
     * spring.factories 写错文件名/路径时，不报错、不告警，护栏就是不存在。
     * 判据：拿掉它之后，demo 必须**真的把库重置掉**（一次性库里出现表）。
     * 用一次性库做这件事是安全的：最坏情况也只是把 campus_guard_probe 灌成演示数据。
     */
    console.log('\n--- PART 1-RED  去掉 spring.factories（护栏必须消失）---')
    {
      const factories = path.join(EXPLODED, 'META-INF/spring.factories')
      const backup = fs.readFileSync(factories)
      const sha = crypto.createHash('sha256').update(backup).digest('hex')
      fs.rmSync(factories)
      try {
        const { child, ready } = await boot(['-Duser.timezone=UTC', '-cp', CP, MAIN,
          '--server.port=8080', '--spring.profiles.active=demo'], { env: baseEnv() })
        check('[RED] 去掉 spring.factories 后 demo 能正常启动（护栏确实没挂上）', ready)
        const tables = tableCount()
        check('[RED] 库被 demo 脚本重置了 → PART 1 的「库仍为空」断言确实有判别力',
          tables > 0, '表数 ' + tables + '（若为 0，说明断言在护栏缺失时也通过 = 假绿）')
        await shutdown(child)
      } finally {
        fs.writeFileSync(factories, backup)
        const back = crypto.createHash('sha256').update(fs.readFileSync(factories)).digest('hex')
        check('[RED] spring.factories 已逐字节还原', back === sha)
        // 复原一次性库，别让这一轮的"故意破坏"污染后面的判据
        cleanupScratchDb()
        setupScratchDb()
        check('[RED] 一次性库已重建为空库', tableCount() === 0, '表数 ' + tableCount())
      }
    }

    /* ---------- 【三】prod 凭据闸门 ---------- */
    console.log('\n--- PART 2  prod 凭据闸门 ---')
    const prodArgs = () => ['-Duser.timezone=UTC', '-cp', CP, MAIN,
      '--server.port=8080', '--spring.profiles.active=prod']

    {
      const r = await runToExit(prodArgs(), { env: baseEnv() })
      check('prod 缺 JWT_SECRET → 拒绝', r.code !== 0 && r.out.includes('JWT_SECRET 未设置'),
        '退出码 ' + r.code + '；日志尾部：' + r.out.split(/\r?\n/).slice(-2).join(' | '))
      check('PART 2a 仍未连库', tableCount() === 0, '表数 ' + tableCount())
    }
    {
      const r = await runToExit(prodArgs(), { env: { ...baseEnv(), JWT_SECRET: FALLBACK_SECRET } })
      check('prod 用仓库兜底密钥 → 拒绝', r.code !== 0 && r.out.includes('默认兜底值'), '退出码 ' + r.code)
    }
    {
      const r = await runToExit(prodArgs(), { env: { ...baseEnv(), JWT_SECRET: GOOD_SECRET, DB_PASSWORD: '123456' } })
      check('prod 用默认库口令 123456 → 拒绝', r.code !== 0 && r.out.includes('默认库口令'), '退出码 ' + r.code)
    }
    check('PART 2 全程未连库（三道闸门都在 DataSource 之前）', tableCount() === 0, '表数 ' + tableCount())

    /* ---------- 【四】【五】prod 正常启动 ---------- */
    /* 先算出 MySQL 服务器默认偏移，再取一个**差 1 小时**的偏移做判据 */
    const serverOffsetRaw = scalarRoot('SELECT TIME_FORMAT(TIMEDIFF(NOW(), UTC_TIMESTAMP()), \'%H:%i\');')
    const sign = serverOffsetRaw && serverOffsetRaw.startsWith('-') ? -1 : 1
    const [sh, sm] = (serverOffsetRaw || '00:00').replace('-', '').split(':').map(Number)
    const serverMinutes = sign * (sh * 60 + sm)
    let testMinutes = serverMinutes - 60            // 比服务器默认早 1 小时
    if (testMinutes < -12 * 60) testMinutes = serverMinutes + 60
    const tz = (m) => `${m < 0 ? '-' : '+'}${String(Math.abs(Math.floor(m / 60))).padStart(2, '0')}:${String(Math.abs(m % 60)).padStart(2, '0')}`
    const TEST_OFFSET = tz(testMinutes)
    console.log(`\n--- PART 3  prod 正常启动（MySQL 服务器默认偏移 ${serverOffsetRaw}，本轮 JVM/会话偏移取 ${TEST_OFFSET}）---`)

    /* ---- RED：临时去掉 connection-init-sql，两侧必然差 1 小时 → 必须「离线」 ---- */
    const INIT_SQL_LINE = /^[ \t]*connection-init-sql:.*$/m
    const originalYml = fs.readFileSync(PROD_YML, 'utf8')
    const originalSha = crypto.createHash('sha256').update(originalYml).digest('hex')
    if (!INIT_SQL_LINE.test(originalYml)) { console.log('application-prod.yml 里找不到 connection-init-sql 行'); process.exit(2) }
    const redYml = originalYml.replace(INIT_SQL_LINE, '')
    fs.writeFileSync(PROD_YML, redYml)

    let redOnline = null
    try {
      const { child, out, ready } = await boot(prodArgs(), {
        env: { ...baseEnv(), JWT_SECRET: GOOD_SECRET, APP_TIME_ZONE_OFFSET: TEST_OFFSET, SQL_INIT_MODE: 'always' },
      })
      check('[RED] 去掉 init-sql 后仍能启动（只改时区，不影响可用性）', ready,
        out.split(/\r?\n/).filter((l) => /ERROR|启动被拒绝/.test(l)).slice(-3).join(' | '))
      if (ready) {
        const token = await login('admin', 'admin123')
        const adminId = Number(scalarRoot("SELECT id FROM t_user WHERE username='admin';", SDB))
        await call('POST', '/user/heartbeat', { token })
        const r = await call('GET', `/users/online?ids=${adminId}`)
        redOnline = Array.isArray(r.data) && r.data.some((x) => Number(x === Object(x) ? x.id : x) === adminId)
        console.log(`  [RED] 心跳后在线判定 = ${redOnline}（期望 false：JVM ${TEST_OFFSET} vs 会话 ${serverOffsetRaw}）`)
      }
      await shutdown(child)
    } finally {
      fs.writeFileSync(PROD_YML, originalYml)
      const backSha = crypto.createHash('sha256').update(fs.readFileSync(PROD_YML, 'utf8')).digest('hex')
      check('[RED] application-prod.yml 已逐字节还原', backSha === originalSha)
    }
    check('[RED] 去掉 init-sql → 必须判定为离线（证明这条断言有判别力）', redOnline === false,
      '实际 ' + redOnline)

    /* ---- GREEN：还原后同样偏移 → 必须「在线」 ---- */
    let greenOnline = null, swaggerUi = null, apiDocs = null, tzLog = null
    {
      const { child, out, ready } = await boot(prodArgs(), {
        env: { ...baseEnv(), JWT_SECRET: GOOD_SECRET, APP_TIME_ZONE_OFFSET: TEST_OFFSET, SQL_INIT_MODE: 'always' },
      })
      check('[GREEN] prod 凭据齐备 → 启动成功', ready,
        out.split(/\r?\n/).filter((l) => /ERROR|启动被拒绝/.test(l)).slice(-3).join(' | '))
      if (!ready) { console.log('\n汇总: ' + pass + ' PASS / ' + fail + ' FAIL'); process.exit(1) }

      tzLog = /JVM 默认时区已钉为 (GMT[+-]\d{2}:\d{2})/.exec(out)?.[1] ?? null
      check('[GREEN] 护栏把 JVM 时区钉住（覆盖 -Duser.timezone=UTC）', tzLog === 'GMT' + TEST_OFFSET, '实际 ' + tzLog)

      const token = await login('admin', 'admin123')
      check('[GREEN] 种子账号可登录（seed-base 在一次性库落库）', !!token)
      const adminId = Number(scalarRoot("SELECT id FROM t_user WHERE username='admin';", SDB))
      await call('POST', '/user/heartbeat', { token })
      const r = await call('GET', `/users/online?ids=${adminId}`)
      greenOnline = Array.isArray(r.data) && r.data.some((x) => Number(x === Object(x) ? x.id : x) === adminId)
      check('[GREEN] connection-init-sql 生效 → 心跳后判定为在线', greenOnline === true, '实际 ' + greenOnline)

      // 【四】接口文档被强制关闭
      // ★ 断言必须看**响应体**，不能看 HTTP 状态码 ★
      // 本项目的约定是「错误一律 HTTP 200 + body 业务码」，且 GlobalExceptionHandler 把
      // NoResourceFoundException 也兜成了 200 —— 所以 springdoc 关掉之后这里仍是 200。
      // 只断言 404 会得到一个永远为假、却看不出问题的用例。
      const uiRes = await fetch(BASE + '/swagger-ui/index.html')
      const uiText = await uiRes.text()
      const docsRes = await fetch(BASE + '/v3/api-docs')
      const docsText = await docsRes.text()
      swaggerUi = `HTTP ${uiRes.status} body=${uiText.slice(0, 60)}`
      apiDocs = `HTTP ${docsRes.status} body=${docsText.slice(0, 60)}`
      check('[GREEN] prod 下 Swagger UI 拿不到页面（不是 swagger 内容）',
        !/swagger-ui/i.test(uiText), swaggerUi)
      check('[GREEN] prod 下 OpenAPI JSON 拿不到文档（不是 openapi 文档）',
        !/"openapi"\s*:/.test(docsText) && !/"paths"\s*:/.test(docsText), apiDocs)
      // 打不出来就说明护栏根本没跑到 hardenProdDefaults，上面两条也只会是假绿
      check('[GREEN] 日志留下「已强制关闭 springdoc」的痕迹', out.includes('已强制关闭'),
        '日志中未找到该行 → 护栏的 prod 加固没执行；日志前 30 行：\n'
        + out.split(/\r?\n/).slice(0, 30).join('\n'))

      await shutdown(child)
    }

    /* ---------- 【六】真实部署形态 java -jar 的冒烟 ---------- */
    console.log('\n--- PART 4  java -jar（真实部署形态）冒烟 ---')
    {
      // ★ 前一轮 GREEN 已经在一次性库里建过表了，这里必须换一个**全新的空库**，
      //   否则「没连库」这条断言在两种情况都说得通，等于没断言。
      cleanupScratchDb()
      setupScratchDb()
      check('PART 4 前置：一次性库已重建为空库', tableCount() === 0, '表数 ' + tableCount())

      const r = await runToExit(['-Duser.timezone=UTC', '-jar', JAR,
        '--server.port=8080', '--spring.profiles.active=demo'], { env: baseEnv(), timeoutMs: 90000 })
      check('java -jar 形态下 demo 未确认同样被拒绝（spring.factories 从 jar 根目录被读到）',
        r.code !== 0 && r.out.includes('启动被拒绝'),
        '退出码 ' + r.code + '；日志尾部：' + r.out.split(/\r?\n/).slice(-2).join(' | '))
      check('java -jar 形态下同样没连库', tableCount() === 0, '表数 ' + tableCount())
    }

    console.log('\n--- PART 5  收尾 ---')
    killPort8080()
  } finally {
    cleanupScratchDb()
    const left = (() => { try { return Number(scalarRoot("SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='" + SDB + "';")) } catch { return -1 } })()
    check('一次性库已 DROP', left === 0, '残留 ' + left)
    try { fs.rmSync(EXPLODED, { recursive: true, force: true }) } catch { /* 下次跑会重建 */ }
  }

  console.log(`\n汇总: ${pass} PASS / ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.log('探针异常: ' + (e && e.stack || e)); killPort8080(); process.exit(2) })
