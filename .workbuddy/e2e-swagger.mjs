/**
 * 真机探针：接口文档（缺陷清单 L2 · springdoc + Swagger UI）
 *
 * 为什么单测不够：springdoc 是「运行时扫描 + 注册静态资源 + 生成 JSON」三件事，
 * 单测（不启动容器）对它一点约束力都没有。真机必须验证四条：
 *   ① 匿名打开 Swagger UI 拿到的是**页面**，不是一段 {"code":401} 的 JSON；
 *   ② /v3/api-docs 真的能生成、且接口是**本项目自己的**（不是 Spring Boot 内置的 /error 之类）；
 *   ③ 放行只对 **GET** 生效 —— 本项目拦截器是按「方法+路径」判定的，
 *      若有人图省事把它挪回 excludePathPatterns（只看路径），就变成整条路径全放行；
 *   ④ 两个 enabled 开关**真的能关掉文档**（生产部署的兜底，必须实测，不能只看配置写了）。
 *
 * 用法：
 *   node .workbuddy/e2e-swagger.mjs on     # 默认，验证「文档可用」
 *   node .workbuddy/e2e-swagger.mjs off    # 需先用 SPRINGDOC_*_ENABLED=false 启动后端，验证「关得掉」
 */
const BASE = 'http://127.0.0.1:8080/api';
const MODE = (process.argv[2] || 'on').toLowerCase();

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name} :: ${detail}`); console.log(`  FAIL  ${name}  -> ${detail}`); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

async function raw(method, path, { token, accept } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(accept ? { Accept: accept } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, type: res.headers.get('content-type') || '', text, json };
}

const login = async (u, p) => {
  const r = await fetch(BASE + '/user/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  });
  const j = await r.json();
  return j?.data?.token;
};

// ==================== 一、文档可用 ====================
if (MODE === 'on') {
  section('一、OpenAPI JSON（匿名可读）');

  const docs = await raw('GET', '/v3/api-docs');
  check('A1 GET /v3/api-docs 匿名可达（不是 401 的 JSON 信封）',
    docs.json?.code === undefined && !!docs.json?.openapi,
    `status=${docs.status} type=${docs.type} 前 120 字=${docs.text.slice(0, 120)}`);
  check('A2 是合法的 OpenAPI 3 文档', /^3\./.test(docs.json?.openapi || ''),
    `openapi=${docs.json?.openapi}`);
  check('A3 有标题信息（swagger-ui 顶部会显示）',
    !!docs.json?.info?.title, `info=${JSON.stringify(docs.json?.info)}`);

  const paths = Object.keys(docs.json?.paths || {});
  console.log(`  文档收录 ${paths.length} 条路径`);
  check('A4 收录量看起来是本项目全量接口（> 20 条）', paths.length > 20, `实际 ${paths.length}`);
  for (const p of ['/user/login', '/goods', '/admin/settings', '/admin/goods/auto-offline']) {
    check(`A5 收录 ${p}`, paths.includes(p), `未找到；示例=${paths.slice(0, 8).join(' ')}`);
  }
  check('A6 ★ 只扫本项目：不含 Spring Boot 内置的 /error',
    !paths.includes('/error'), `paths 里出现了 /error`);
  check('A7 刚补的自动下架入口连方法一起登记了',
    JSON.stringify(docs.json?.paths?.['/admin/goods/auto-offline'] || {}).includes('post'),
    `实际=${JSON.stringify(docs.json?.paths?.['/admin/goods/auto-offline'])}`);

  section('二、Swagger UI 页面（匿名可读）');

  const ui = await raw('GET', '/swagger-ui/index.html', { accept: 'text/html' });
  check('B1 GET /swagger-ui/index.html 返回 HTML 而不是 401 JSON',
    ui.type.includes('text/html'), `type=${ui.type} 前 120 字=${ui.text.slice(0, 120)}`);
  check('B2 页面确实是 Swagger UI（含标识字符串）',
    /swagger/i.test(ui.text), `前 200 字=${ui.text.slice(0, 200)}`);
  check('B3 页面里引用了 swagger-ui 的资源（否则是空壳）',
    /swagger-ui(-bundle)?\.(js|css)/.test(ui.text), `前 400 字=${ui.text.slice(0, 400)}`);

  const redirect = await raw('GET', '/swagger-ui.html');
  check('B4 /swagger-ui.html 也能到达（老书签 / 文档里最常见的那个地址）',
    redirect.status === 200 && !redirect.json?.code,
    `status=${redirect.status} type=${redirect.type}`);

  section('三、放行只对 GET 生效（不能退回 excludePathPatterns）');

  /*
   * ★ 这里刻意打 POST /v3/api-docs ★
   * 它同时覆盖两件事：
   *   ① 文档路径只对 GET 放行（否则任何人 POST 也能进来）；
   *   ② 「HTTP 方法不对」不能被报成 500。
   * 后者是本轮在验证接口文档时**顺带撞出来的真实缺陷**：
   * HttpRequestMethodNotSupportedException 原先没有专门的处理器，落到兜底分支变 500
   * 「服务器内部错误」，让人以为是后端挂了。已修（GlobalExceptionHandler 补两个分支）。
   * ★ 注意：这个异常在**拦截器之前**抛出（DispatcherServlet 查 handler 时就抛了），
   * 所以这里的预期是 1001 而不是 401 —— 断言别想当然。
   */
  const postDocs = await raw('POST', '/v3/api-docs');
  check('C1 ★ POST /v3/api-docs → 1001 + 提示支持的方法（既没被放行，也不是 500）',
    postDocs.json?.code === 1001 && /方法/.test(postDocs.json?.message || ''),
    `code=${postDocs.json?.code} msg=${postDocs.json?.message}`);
  check('C1b 且没有返回 OpenAPI 文档（放行确实只对 GET 生效）',
    !postDocs.json?.openapi, `返回了 openapi=${postDocs.json?.openapi}`);

  const postUi = await raw('POST', '/swagger-ui/index.html');
  check('C2 POST /swagger-ui/index.html 未被放行 → 401（静态资源处理器接受任意方法，所以拦截器会跑到）',
    postUi.json?.code === 401, `code=${postUi.json?.code} msg=${postUi.json?.message}`);

  const postGoods = await raw('POST', '/goods');
  check('C3 ★ POST /goods 未登录 → 401（同一路径 GET 公开、POST 不公开，放行没有串到写操作上）',
    postGoods.json?.code === 401, `code=${postGoods.json?.code} msg=${postGoods.json?.message}`);

  section('四、文档本身没把别的接口带松');

  const token = await login('admin', 'admin123');
  check('D0 前置：admin 仍能登录（改 pom/拦截器没有把登录链路弄坏）', !!token);
  const noToken = await raw('GET', '/admin/settings');
  check('D1 ★ /admin/settings 仍然需要登录（放行文档没有顺带放开业务接口）',
    noToken.json?.code === 401, `code=${noToken.json?.code} msg=${noToken.json?.message}`);
  const withToken = await raw('GET', '/admin/settings', { token });
  check('D2 带 admin token 仍可正常访问', withToken.json?.code === 0,
    `code=${withToken.json?.code} msg=${withToken.json?.message}`);
}

// ==================== 五、开关真的关得掉（生产兜底） ====================
if (MODE === 'off') {
  section('五、enabled=false 时文档不可达（生产部署的兜底）');

  const docs = await raw('GET', '/v3/api-docs');
  check('E1 ★ /v3/api-docs 不再是 OpenAPI 文档（开关生效）',
    !docs.json?.openapi, `仍返回 openapi=${docs.json?.openapi}`);
  check('E2 状态不是 200 的正常文档内容（应为 404 或错误信封）',
    docs.status !== 200 || !docs.type.includes('application/json') || !docs.json?.openapi,
    `status=${docs.status} type=${docs.type}`);

  const ui = await raw('GET', '/swagger-ui/index.html', { accept: 'text/html' });
  check('E3 ★ /swagger-ui/index.html 不再是文档页面',
    !/swagger-ui(-bundle)?\.(js|css)/.test(ui.text),
    `type=${ui.type} 前 160 字=${ui.text.slice(0, 160)}`);

  section('六、关掉文档不影响业务接口');

  const token = await login('admin', 'admin123');
  check('F1 admin 仍能登录', !!token);
  const g = await raw('GET', '/goods');
  check('F2 公开商品列表仍可达', g.json?.code === 0, `code=${g.json?.code}`);
  const s = await raw('GET', '/admin/settings', { token });
  check('F3 受保护的 /admin/settings 仍可正常访问', s.json?.code === 0,
    `code=${s.json?.code} msg=${s.json?.message}`);
}

console.log('\n==================== 结果 ====================');
console.log(`MODE=${MODE}  PASS=${pass}  FAIL=${fail}`);
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail === 0 ? 0 : 1);
