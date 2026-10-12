# 校园二手集市 · campus-market

一个面向校园场景的二手交易平台，**前后端完全分离**：后端 Spring Boot 3 提供 REST 接口，前端 Vue 3 单页应用消费。

> 软件工程实践课作品（计算机科学与技术 2023 级）
> 项目不只是「能跑」——它同时是一套**可追溯的工程纪律实践**：静态审计、红绿探针、缺陷台账、记忆文件都在仓库里（见 [工程方法论](#工程方法论)）。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | Spring Boot **3.2.5** · JDK **17** · MyBatis-Plus **3.5.6** · MySQL **8.0** · JWT (jjwt 0.12.5) · Spring AI · SpringDoc OpenAPI |
| 前端 | Vue **3.4** · Vite **5** · TypeScript **5.4** · Element Plus **2.7** · Pinia **2** (持久化) · Vue Router **4** · ECharts **5** · Axios |
| 测试 | JUnit 5 + Mockito（后端） · Vitest + Vue Test Utils + happy-dom（前端） |
| 部署 | Nginx（静态资源 + 反向代理 + 登录限流）· systemd（后端服务）· MySQL 8 |

---

## 功能一览

**用户侧**
- 注册 / 登录（BCrypt 哈希 + JWT 走 **HttpOnly Cookie**，前端不持有 token）、个人资料、公开主页
- **钱包**：余额充值、充值流水、幂等键防重复入账（数据库唯一索引兜底）
- 商品：发布（图片上传）、列表 / 搜索 / 分类筛选、详情、收藏、购物车、我的商品上下架
- 订单：下单 → 支付 → 发货 → 收货 → 评价全流程；**三种支付渠道**（支付宝沙箱 / 演示渠道 / 余额支付）、退款、物流轨迹
- 站内消息、通知公告、举报

**管理侧**（`/admin` 后台 10 个面板）
- 数据概览、用户管理、商品管理、订单管理、分类管理、公告管理、内容管理、活动管理、举报处理、**系统设置**、审计日志、经营分析

**AI 能力**
- 接入 Spring AI，支持多供应商**自动降级链**（主供应商不可用时自动切备用，业务代码零改动）

---

## 项目结构

```
实践任务3：后端开发(前后端分离)/
├── campus-secondhand-backend/          # 后端服务
│   ├── src/main/java/com/campus/market/
│   │   ├── controller/     15 个 REST 控制器
│   │   ├── service/        21 个业务服务
│   │   ├── mapper/         20 个 MyBatis 映射接口
│   │   ├── entity/         19 个实体
│   │   ├── dto/            16 个传输对象
│   │   ├── common/         统一响应体、异常、密码工具等
│   │   ├── config/         安全、跨域、Swagger、异步等配置
│   │   ├── interceptor/    认证拦截器（JWT + token_version 校验）
│   │   ├── job/            定时任务（商品自动下架等）
│   │   └── security/       鉴权相关
│   ├── src/main/resources/db/          # schema / 种子 / 升级脚本
│   └── src/test/                       # 539 个测试用例
│
├── campus-secondhand-frontend/         # 前端应用
│   ├── src/views/          22 条路由 · 31 个页面组件
│   ├── src/components/     通用组件 + 业务组件
│   ├── src/api/            接口层（含 mock 开关）
│   ├── src/stores/         Pinia 状态（user / app / goods / cart）
│   └── src/__tests__/      680 个测试用例
│
├── .workbuddy/                          # 工程纪律载体
│   ├── memory/             项目长期记忆 + 逐日工作日志
│   ├── audit-tools/        静态审计与红绿探针脚本
│   └── *.mjs               前后端副本同步与一致性校验脚本
│
├── 项目缺陷检查与修复清单.md             # 缺陷台账（主文档）
├── 缺陷清单逐条核对报告.md               # 逐条核对记录
└── 缺陷修复方案.md                       # 修复方案设计
```

**规模**：后端 181 个 Java 文件 / 约 30,600 行；前端 133 个 Vue+TS 文件 / 约 43,400 行。

---

## 快速开始

### 环境要求
JDK 17 · Maven 3.9+ · Node.js 18+ · MySQL 8.0

### 1. 数据库
```bash
mysql -u root -p -e "CREATE DATABASE campus_market DEFAULT CHARACTER SET utf8mb4;"
mysql -u root -p campus_market < campus-secondhand-backend/src/main/resources/db/schema.sql
mysql -u root -p campus_market < campus-secondhand-backend/src/main/resources/db/seed-base.sql
```

### 2. 启动后端
```bash
cd campus-secondhand-backend
mvn spring-boot:run
# 接口地址 http://localhost:8080/api ，Swagger UI 见 springdoc 配置
```
数据库连接默认 `localhost:3306/campus_market`，可用环境变量覆盖：
`DB_URL` / `DB_USERNAME` / `DB_PASSWORD` / `JWT_SECRET`

### 3. 启动前端
```bash
cd campus-secondhand-frontend
npm install
npm run dev          # http://localhost:5173
```
前端通过 `.env.development` 指定接口地址与是否使用 Mock（`VITE_USE_MOCK`）。

---

## 测试与质量

| 范围 | 结果 |
|---|---|
| 后端测试 | **539 passed** / 0 failures / 0 errors |
| 前端测试 | **680 passed**（29 个测试文件） |
| TypeScript 类型检查 | `vue-tsc --noEmit` 零错误 |

```bash
# 后端
cd campus-secondhand-backend && mvn test

# 前端
cd campus-secondhand-frontend && npm run test
```

---

## ⚠️ 关于演示账号

数据库种子脚本会创建一批**本地演示账号**（如 `admin / admin123`），用于零配置启动后直接体验完整功能。

> **这些口令只适用于本地开发环境。**
> 任何对外部署都必须**第一时间修改**，且不要把生产环境的口令写进配置文件或提交到仓库。
> 本项目生产环境的凭据一律通过环境变量注入（`/etc/campus-market/env`，权限 600），仓库内只保留 `.template` 模板。

---

## 工程方法论

这个仓库比较特别的一点：**开发过程中的工程纪律本身是留档的**。

- **静态审计脚本**：`.workbuddy/audit-tools/` 归档了可复用的审计器 —— MyBatis 参数绑定越界扫描、接口 ↔ XML 双向一致性检查、语义常量零引用扫描、导出与列表排序一致性比对
- **红绿探针**：修 bug 前先写一个「修复前必报红、修复后必变绿」的探针，证明测试真的抓得住这个缺陷，而不是恰好通过
- **缺陷台账**：每个缺陷的现象、根因、修复、验证证据都记录在 `项目缺陷检查与修复清单.md`，可追溯
- **记忆文件**：`.workbuddy/memory/` 保存跨会话的项目上下文与踩坑记录，避免同一个坑踩第二次
- **副本同步校验**：工作区存在副本时用脚本做无偏全量比对，防止改了一边忘了另一边

这些方法论中的一部分已抽象为可复用的 Skill（配置项静默失效审计、快照回写审计、签名回调真机验证、部署容量实测等），存放在 WorkBuddy 的用户级 skills 目录中，不在本仓库。

---

## 部署

生产部署形态：**Nginx**（静态资源 + `/api` 反向代理 + `/uploads` 静态映射 + 登录接口限流）+ **systemd**（后端 jar 常驻）+ **MySQL 8**。

关键实践：
- 后端 jar 用 systemd 托管，凭据走 `EnvironmentFile`（600 权限），不进 `ExecStart`
- 前端用 Vite 构建后直接由 Nginx 托管，SPA history 路由回退到 `index.html`
- 数据库结构变更一律写**幂等升级脚本**（`db/upgrade-*.sql`），不用「重建库」了事
- 发布前跑 `deploy/assemble-release.mjs` 打包并做产物自检

---

## 相关文档

| 文档 | 内容 |
|---|---|
| `campus-secondhand-backend/README.md` | 后端架构、分层设计、接口约定 |
| `campus-secondhand-backend/docs/后端设计说明.md` | 详细设计说明（含各模块决策依据） |
| `campus-secondhand-frontend/README.md` | 前端结构、组件体系、状态管理 |
| `项目缺陷检查与修复清单.md` | 完整缺陷台账与修复记录 |
