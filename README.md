# 在线选课系统（Web 应用与开发 课程作业）

基于 B/S 三层架构的在线选课系统，实现文档《选课系统系统设计文档（优化版 V3.0）》中的全部必做功能：
四类角色的权限体系、课程查询、选课 / 退课 / 换课、时间冲突检测、容量与防超卖、候补与自动递补、
学分与类别校验、先修校验、选课批次错峰、通知中心、审计日志与运行监控。

## 0. 在线演示与界面预览

| 入口 | 地址 |
| --- | --- |
| **在线演示**（免安装，点开即用） | <https://tanyunx.github.io/course-selection-system/> |
| 代码仓库 | <https://github.com/Tanyunx/course-selection-system> |

> 在线演示为单文件版：业务引擎与数据全部内嵌在页面里，保存在浏览器内存中，刷新即恢复初始状态。
> 完整的数据库版（Express + MySQL）请按[第 3 章](#3-快速开始)在本地部署，两者界面与业务规则完全一致。

**登录页**（右侧演示账号可一键填入）

![登录页](screenshots/01-login.png)

**学生课表（全天 13 节：上午 1~5 / 下午 6~10 / 晚上 11~13）与选课规则页**

![学生课表与选课规则](screenshots/02-timetable.png)

## 1. 技术栈

| 层次 | 选型 |
| --- | --- |
| 表现层 | HTML5 + CSS3 + 原生 JavaScript（ES Module，无构建步骤） |
| 业务逻辑层 | Node.js 18+ / Express 4 |
| 数据访问层 | MySQL 8.0（mysql2 连接池 + 事务）；密码哈希用 bcrypt |
| 接口风格 | REST + JSON，统一返回体 `{ code, message, data }` |
| 部署 | 应用服务托管静态资源，单机即可运行 |

## 2. 目录结构

```
course-selection-system/
├─ config/config.js            # 集中配置（数据库、令牌、限速阈值、业务参数）
├─ db/
│  ├─ schema.sql               # 建库建表：18 张表 + 唯一约束 + 索引 + 外键
│  └─ seed.sql                 # 种子数据（学期、用户、课程、开课、排课、批次、规则）
├─ scripts/init-db.js          # 一键初始化数据库
├─ server/
│  ├─ app.js                   # 应用入口（路由挂载、指标采集、启动自检）
│  ├─ db.js                    # 连接池与事务封装
│  ├─ middleware/
│  │  ├─ auth.js               # 令牌鉴权 + RBAC 角色校验
│  │  ├─ guards.js             # 写操作幂等 + 防脚本限速
│  │  └─ student.js            # 学生/教师上下文加载
│  ├─ services/
│  │  ├─ ruleService.js        # 规则引擎：批次、冲突检测、学分、先修、退课截止
│  │  ├─ courseService.js      # 课程查询与选课状态标注
│  │  ├─ enrollmentService.js  # 选课 / 退课 / 换课核心流程
│  │  ├─ waitlistService.js    # 候补与自动递补
│  │  ├─ accountService.js     # 账号与身份
│  │  ├─ notice.js / audit.js  # 通知与审计
│  ├─ routes/                  # auth / courses / enrollments / waitlist / notices / teacher / admin / sys
│  └─ store/                   # 会话、幂等缓存、限速桶、运行指标
├─ public/                     # 前端（原生 JS 多页单页混合式，按角色生成菜单）
│  ├─ index.html
│  ├─ css/app.css
│  └─ js/{api,ui,app,scheduleEditor}.js + js/views/{student,teacher,admin,sys}.js
├─ tests/
│  ├─ smoke.js                 # 接口冒烟测试（19 项）
│  └─ acceptance.js            # 端到端验收测试（对应文档表 28 的 TC-01 ~ TC-15）
├─ web-build/                  # 单文件网页版构建工具（免安装演示版的全部源码）
│  ├─ export-data.js           # 从本机 MySQL 导出 18 张表种子数据 → mock/data.js
│  ├─ build.js                 # 把前端 + 内嵌引擎打包为单个 .html，并同步产出 docs/index.html
│  ├─ test-engine.js           # 单文件版引擎回归测试（74 项）
│  └─ mock/                    # 内嵌业务引擎：core（基础设施）/ rules（规则）/ services / routes
├─ docs/index.html           # 【部署产物】纯静态站点入口，可直接上传到任意静态托管
├─ 选课系统-单文件版.html        # 【交付物】免安装单文件网页，双击即用
├─ 云服务器部署指南.md          # 【部署文档】静态托管 / 云服务器两条路线的完整步骤
├─ screenshots/                # 界面截图（README 展示：登录页 / 课表 / 选课规则）
├─ .env.example                # 配置模板（真实环境变量 > .env > 代码默认值）
└─ .uicheck/                   # 开发期前端集成验证（jsdom），不参与线上运行
   ├─ ui-check.js              # 数据库版前端验证：四角色登录 + 菜单 + 逐页渲染（53 项）
   ├─ static-check.js          # 单文件版验证：加载构建产物真实执行（51 项）
   ├─ diag-conflict.js         # 诊断：单个学生的课表冲突排查
   ├─ diag-all-conflict.js     # 诊断：全量学生课表冲突扫描
   ├─ diag-layout.js           # 诊断：排课全景（课程/教师/时段/教室/选课学生）
   └─ perm-probe.js            # 探针：验证部署指南中的 MySQL 专用账号授权是否够用
```

## 3. 快速开始

### 3.0 方式一：单文件网页版（免安装，双击即用）

工程根目录的 **`选课系统-单文件版.html`** 是一个完全自包含的网页：

- **无需 Node、无需 MySQL、无需任何安装**，双击用浏览器打开即可完整演示
- 内嵌了与数据库版同源的全部演示数据（18 张表）与业务规则引擎
  （批次准入、时间冲突、单双周、学分上限、先修校验、候补自动递补、幂等、限速均已实现）
- 四类角色登录、选课 / 退课 / 换课 / 候补 / 课表 / 通知 / 教务管理 / 系统监控全部可用
- 数据保存在浏览器内存中，刷新页面即恢复初始状态；页面底部有「重置演示数据」按钮
- 演示账号与口令直接显示在登录页

适合课堂演示、发给同学老师、拷到 U 盘随时打开。若修改了种子数据或业务逻辑，重新构建：

```bash
node web-build/export-data.js   # 可选：从数据库重新导出演示数据
node web-build/build.js         # 重新打包单文件
node web-build/test-engine.js   # 引擎回归测试（74 项）
```

### 3.1 方式二：数据库完整版（Node + MySQL）

#### 环境要求

- Node.js 18 及以上
- MySQL 8.0 已启动

#### 配置数据库连接

数据库连接参数在 `config/config.js` 中，可通过环境变量覆盖：

```bash
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的密码
DB_NAME=course_selection
```

参数优先级：环境变量 > 配置文件默认值。除数据库口令外，令牌密钥、限速阈值、候补确认期等也支持环境变量注入，不硬编码在业务代码中。

#### 初始化数据库与启动

```bash
cd course-selection-system
npm install          # 安装 express / mysql2 / bcryptjs
npm run db:init      # 建库、建表、导入种子数据（会先删除同名旧表）
npm start            # 启动服务
```

浏览器访问 <http://127.0.0.1:3000>

**Windows 一键启动（推荐）**：直接双击工程根目录下的 `启动选课系统.bat`，
脚本会自动安装缺失的依赖并启动服务，然后在浏览器打开上面的地址即可。
关闭该命令行窗口即停止服务。

> 注意：**不要直接双击 `public/index.html`**。前端需要调用后端接口，
> 必须以 `http://127.0.0.1:3000` 的方式通过服务访问；用 `file://` 打开会因接口不可用而无法登录。

#### 演示账号

全部演示账号的登录口令统一为：`123456`

| 角色 | 账号 | 姓名 | 说明 |
| --- | --- | --- | --- |
| 学生 | `2024001` | 陈嘉禾 | 2024 级，已选 2 门课，有 1 条候补 |
| 学生 | `2024002` | 林知遥 | 2024 级 |
| 学生 | `2024003` | 吴子墨 | 未通过《程序设计基础》，用于验证先修拦截 |
| 学生 | `2023001` | 黄一诺 | 2023 级，高年级优先批次 |
| 学生 | `2025001` | 郑亦然 | 2025 级，学分上限 20 |
| 教师 | `teacher001` | 张明远 | 维护本人开课的排课与地点 |
| 教师 | `teacher002` | 李佳琪 | |
| 教务管理员 | `academic` | 周教务 | 课程目录、开课计划、批次、学分规则、名额、公告 |
| 系统管理员 | `sysadmin` | 孙运维 | 用户与权限、审计日志、运行监控 |

登录页提供了账号快捷填入按钮，点击即可填入账号，口令需手动输入。

## 4. 功能清单

### 学生端
- **选课中心**：按课程名称/代码搜索，按类别、上课星期、校区筛选，支持"仅看可选"与热度/已选人数排序；
  每条开课展示教师、上课时间与地点、学分、类别、`已选/容量`、热度标签、先修要求与实时状态。
- **开课详情**：课程简介、排课时段、先修满足情况、候补队列前 10 位、本学期学分进度、当前生效批次。
- **选课 / 候补 / 退课**：按钮状态严格对应文档表 6（可选 / 已满 / 时间冲突 / 条件不符 / 批次外 / 已选 / 候补中）。
- **换课**：单一事务"先占后放"，目标课程不可选时整体不生效。
- **我的课表**：周视图，支持单双周切换（全周课程在任一视图均显示）、打印导出。
- **我的选课**：学分与类别进度、退课（二次确认）、换课入口。
- **我的候补**：当前排位、前方人数、递补确认。
- **通知中心**：按类型筛选、标记已读、未读角标。
- **选课规则**：展示当前批次、学分与类别要求、全部规则说明与教务公告。

### 节次时间（全校统一《课时表》）

每天 13 节、每节 40 分钟；课表、排课编辑器、冲突检测与课时表展示均以此为准。
常量定义在 `server/utils/period.js`（服务端）与 `public/js/ui.js`（前端），两处保持同源。

| 时段 | 大节 | 小节 | 起止时间 |
| --- | --- | --- | --- |
| 上午 | 一 | 1 / 2 | 08:00~08:40 / 08:45~09:25 |
| 上午 | 二 | 3 / 4 / 5 | 09:45~10:25 / 10:30~11:10 / 11:15~11:55 |
| 下午 | 三 | 6 / 7 | 13:00~13:40 / 13:45~14:25 |
| 下午 | 四 | 8 / 9 / 10 | 14:45~15:25 / 15:30~16:10 / 16:15~16:55 |
| 晚上 | 五 | 11 / 12 / 13 | 18:00~18:40 / 18:45~19:25 / 19:30~20:10 |

- 学生「我的课表」左侧标注时段（上午/下午/晚上）与每节起止时间；
- 学生「选课规则」页展示完整课时表；
- 排课时段编辑器（教师/教务）节次上限为 13，选项中带起止时间；
- 课程/选课列表中的上课时间文案含节次起止时间，如「周一 第 1-2 节 08:00~09:25」。

### 教师端
- 我的开课列表（含已选/容量、候补人数、热度）；维护上课时间与地点（支持多时段）；容量由教务设定，教师不可修改。
- 选课名单与候补队列查看。

### 教务管理端
- 数据概览：开课数、选课记录、容量利用率、候补人数、已满开课、热门开课 TOP 8、批次时间线。
- 课程目录：增删改查、类别与学分维护、先修关系维护（支持"与 / 或"两种关系）。
- 开课计划：新增开课（课程、教师、容量、校区、多时段排课）、编辑、停开/开放。
- 名额管理：查看已选与候补人数、人工调整容量（写入审计日志），容量扩大后自动触发候补递补。
- 选课批次：新增、编辑、删除；目标年级/学院、优先级、起止时间。
- 学分规则：各年级学分上下限、各课程类别学分要求。
- 公告发布：发布并投递站内通知（可指定年级）或存为草稿。

### 系统管理端
- 用户与权限：账号查询、新增（按角色自动创建学生/教师扩展档案）、编辑、重置密码、启用/禁用。
- 审计日志：按操作类型、操作人、结果筛选，分页浏览。
- 运行监控：接口成功率、选课写接口 P95 与平均耗时、在线人数、队列长度、缓存差值、
  告警阈值检查、错误码分布、接口调用统计。

## 5. 核心规则实现要点

| 规则 | 实现位置与做法 |
| --- | --- |
| 时间冲突检测 | `ruleService.detectConflict`：星期相同 + 节次区间相交 + 单双周不互斥，纯 SQL 一次比对全部排课时段；一门课任一时段冲突即整体冲突 |
| 防超卖 | `enrollmentService.occupySeat`：`UPDATE t_course_offering SET enrolled = enrolled + 1 WHERE id = ? AND enrolled < capacity AND status <> 0`，影响行数为 0 即视为已满；配合 `uk_student_offering` 唯一约束形成最后防线 |
| 校验顺序 | 鉴权 → 幂等 → 批次(2005) → 重复(2006/2007) → 占名额(2001) → 冲突(2002) → 学分(2003) → 先修(2004) → 落库；第 6~8 步失败整个事务回滚，已占名额自动归还 |
| 退课 | 截止时间校验(2008) → 记录置为已退 → 释放名额 → 写审计与通知 → 触发候补递补 |
| 换课 | 单一事务：预占目标名额 → 冲突/学分/先修校验（冲突校验排除即将释放的原课程）→ 释放原名额 → 重建记录；任一步失败返回 2009 且原课程不变 |
| 候补递补 | 名额释放后取 `queue_no` 最小者，重新执行完整校验：通过则占名额、生成来源为"候补递补"的记录、置为已递补并设 24 小时确认期；不通过则置为已失效、发"递补失败"通知并顺延下一名 |
| 幂等 | 写接口要求携带 `requestId`，服务端缓存 5 分钟，重复请求直接返回首次结果 |
| 防脚本刷课 | 60 秒内同一账号超过 10 次写请求返回 9001，超过 20 次要求安全验证 |
| 权限矩阵 | `middleware/auth.js` 的 `requireRole`，越权访问返回 1003 并写入审计日志 |

## 6. 接口清单

完整清单见设计文档表 4，实现与文档一致：

```
POST   /api/auth/login                    匿名        登录，返回令牌与用户信息
POST   /api/auth/logout                   登录用户    注销并使令牌失效
GET    /api/auth/me                       登录用户    当前用户信息与角色
GET    /api/auth/captcha                  匿名        连续失败 5 次后的安全验证

GET    /api/terms/current                 登录用户    当前学期
GET    /api/meta/filters                  登录用户    筛选项元数据
GET    /api/courses                       登录用户    课程查询（keyword/categoryId/weekday/available/campus/sort/page/size）
GET    /api/courses/{offeringId}          登录用户    开课详情

POST   /api/enrollments                   student     选课
DELETE /api/enrollments/{offeringId}      student     退课
POST   /api/enrollments/switch            student     换课
GET    /api/enrollments/mine              student     我的已选课程
GET    /api/timetable                     student     我的课表（parity 单双周切换）

POST   /api/waitlist                      student     加入候补
DELETE /api/waitlist/{offeringId}         student     取消候补
POST   /api/waitlist/{offeringId}/confirm student     确认递补名额
GET    /api/waitlist/mine                 student     我的候补与排位

GET    /api/notices                      登录用户    通知列表
POST   /api/notices/{id}/read            登录用户    标记已读
POST   /api/notices/read-all             登录用户    全部已读
GET    /api/announcements                登录用户    公告列表

GET    /api/teacher/offerings            teacher     我的开课
PUT    /api/teacher/offerings/{id}       teacher     维护上课时间与地点
GET    /api/teacher/offerings/{id}/students teacher  选课学生名单

GET/POST/PUT/DELETE /api/admin/courses   academic    课程目录与先修关系
GET/POST/PUT        /api/admin/offerings academic    开课计划与容量
GET/POST/PUT/DELETE /api/admin/batches   academic    选课批次
GET/POST            /api/admin/credit-rules academic 学分与类别规则
GET                 /api/admin/statistics academic   名额管理
GET/POST/PUT        /api/admin/announcements academic 公告
GET                 /api/admin/dashboard academic    数据概览

GET/POST/PUT        /api/admin/users     sys_admin   用户与权限管理
GET                 /api/admin/audit-logs sys_admin  审计日志
GET                 /api/admin/monitor   sys_admin   运行监控
```

错误码与设计文档表 5 一致（0 成功、1001~1003 认证与权限、2001~2010 选课业务、9001~9002 限流与系统），
另补充 2011 未选该课程、2012 开课已停开、2013 不在候补队列、2014 开课不存在、9003 参数有误等扩展码。

## 7. 测试

### 7.1 后端测试

先启动服务，再执行测试脚本：

```bash
npm start                 # 终端 A
node tests/smoke.js       # 终端 B：接口冒烟测试，19 项
node tests/acceptance.js  # 终端 B：验收测试，对应文档表 28 的 TC-01 ~ TC-15
```

验收测试覆盖：并发不超卖、重复选课、幂等、全周冲突、单双周不冲突、多时段冲突、
超学分、先修未满足、批次外、候补自动递补、递补二次校验失败顺延、换课目标已满、
退课截止、越权访问、防刷限速。测试数据使用 `ZZTEST` / `ZZC` / `ZZTEACH` 前缀，执行后自动清理。

### 7.2 前端集成验证

`.uicheck/ui-check.js` 用 jsdom 加载真实页面 `public/index.html`，并把 `fetch` 指向真实后端，
真正执行 `public/js` 下的前端模块，验证：四类角色登录、按角色生成的菜单项、逐页渲染无报错、
选课中心课程卡片与状态标签、课表周视图、开课详情弹窗、破坏性操作的二次确认，
同时统计未捕获异常与控制台错误。

```bash
cd .uicheck && npm install   # 仅首次，安装 jsdom
npm start                    # 回到工程根目录启动服务
cd .uicheck && node ui-check.js
```

该目录属于开发期验证工具，不参与服务端运行，删除后不影响工程。

### 7.3 单文件网页版验证

单文件版有两层独立验证，均不需要启动任何服务：

```bash
node web-build/test-engine.js    # 引擎回归测试：74 项，覆盖全部核心业务规则
node .uicheck/static-check.js    # 端到端验证：加载构建产物真实执行，51 项
```

`test-engine.js` 在 Node 中直接驱动内嵌引擎，用与数据库版验收测试相同的场景
（并发抢占、幂等、冲突、学分、先修、批次、候补递补、换课、退课截止、越权、限速、通知公告）
逐项断言；`static-check.js` 则把构建产出的 .html 交给 jsdom 真实执行，
验证四类角色登录、菜单、逐页渲染与学生端交互，并统计未捕获异常与控制台错误。

## 8. 与设计文档的对应关系

| 文档章节 | 实现落点 |
| --- | --- |
| 2.2 技术选型（必做档） | HTML5 + CSS3 + 原生 JS / Node.js + Express / MySQL 8.0 |
| 2.4 接口设计与表 4 | `server/routes/*`，统一返回体与分页结构 |
| 2.5 错误码表 5 | `server/utils/errors.js`，前端 `public/js/api.js` 中映射为提示文案 |
| 第 3 章 界面设计 | `public/`，顶栏 + 左侧栏 + 主体区布局，响应式与无障碍要点 |
| 4.2 / 4.3 / 4.4 / 4.6 / 4.7 规则 | `server/services/ruleService.js` |
| 5.2 ~ 5.6 数据库设计 | `db/schema.sql`（18 张表、约束、索引、数据字典取值） |
| 6.1 / 6.2 / 6.3 / 6.5 核心流程 | `server/services/enrollmentService.js`、`waitlistService.js` |
| 表 26 角色权限矩阵 | `server/middleware/auth.js` 的 `requireRole` |
| 表 28 关键验收用例 | `tests/acceptance.js` |
| 8.3 落地优先级 | 第一、二优先全部实现；第三优先全部实现；可选增强（Redis、消息队列、排队、CDN）未引入，见下节 |

## 9. 未实现项与说明

设计文档 8.3 中标注为"可选增强"的能力未纳入本次实现，系统按文档描述退化为
"数据库条件更新 + 单机限流"，功能与正确性不受影响：

- **Redis 余量缓存与预扣**：运行监控页的"缓存与数据库余量差值"恒为 0。
- **消息队列削峰**：选课在请求线程内同步落库，未做异步化。
- **网关排队机制**：运行监控页的"排队队列长度"恒为 0。
- **CDN 分发**：静态资源由应用服务直接托管。
- **会话存储**：登录会话保存在服务端内存，进程重启后需要重新登录（生产环境应替换为 Redis 或数据库）。

此外，按文档 1.3 的系统边界，本系统不与教务系统、统一认证、支付等外部系统对接，
学籍与成绩数据以本地数据表维护。

## 10. 部署上线

想让别人用网址打开，有两条路，详细步骤见 **[云服务器部署指南.md](./云服务器部署指南.md)**：

| 路线 | 上传什么 | 成本 | 数据 |
| --- | --- | --- | --- |
| **A. 静态托管**（推荐先做） | `docs/index.html`（= 单文件版） | 0 元，5 分钟 | 浏览器内存，刷新重置 |
| **B. 云服务器** | 整个工程（Node + MySQL） | 约 50~120 元/月 | MySQL 持久化，支持并发 |

**路线 A** 无需后端，可直接放到 GitHub Pages、腾讯云 COS、阿里云 OSS、Vercel、Netlify，
或使用 WorkBuddy 内置的一键发布能力。`npm run build` 之外，构建脚本每次都会自动同步产出
`docs/index.html` 作为静态站点入口。

**路线 B** 的关键注意点（详见指南）：

- 服务器上必须把 `.env` 里的 `HOST` 改成 `0.0.0.0`，否则只有服务器本机能访问；
- 云控制台**安全组要放行端口**（80 / 3000），这一步最容易漏；
- 用 `pm2` 常驻并设置开机自启，别直接 `npm start` 挂在终端上；
- MySQL 使用专用账号而非 root，`AUTH_SECRET` 要换成随机串。

配置文件加载顺序：**真实环境变量 > 项目根目录 `.env` 文件 > 代码内置默认值**。
`.env` 由 `config/config.js` 以零依赖方式读取，模板见 `.env.example`（该文件仅作模板，不含真实口令）。

