# NEXUS · 网络安全态势感知平台

以**网络安全**为主题的全栈产品站:Editorial Noir 艺术风落地页 + 真实后端(SQLite / 会话认证 / REST API / SSE)驱动的安全运营控制台。

> 灵感来自 [Aura](https://www.aura.build/browse/components) 模板广场,全部代码为原创实现。
> ⚠️ 安全提示:内置的认证与存储机制用于产品演示,直接上生产前需补充 HTTPS 强制、CSRF 防护、审计日志与专业安全评审。

## ✨ 两种运行模式(前端自动探测)

| 模式 | 触发条件 | 数据存储 | 认证 |
| --- | --- | --- | --- |
| **真实模式** | `npm start` 启动后端 | SQLite(`data/nexus.db`,WAL) | scrypt 口令散列 + HTTP-only 会话 Cookie |
| **演示模式** | 纯静态托管(如 GitHub Pages) | localStorage | 演示会话 |

前端通过探测 `api/auth/me` 自动切换(200/401 = 后端存在;404 = 静态托管),同一套代码 both 可用。

## 🎨 落地页

- **开场动画**:盾牌描边 → NEXUS 字母点亮 → 安全通道加载计数 → 幕布升起 → Hero 逐行入场(可点击跳过,尊重 prefers-reduced-motion)
- **日食主视觉**:Canvas 黑洞圆盘 + 青色电弧边缘 + 620 颗轨道粒子(前后排遮挡)+ 星空,鼠标视差
- **Editorial Noir 设计系统**:空心描边大字、等宽标签、胶片噪点、情报跑马灯、编号章节、细线网格
- 威胁事件流终端、数字滚动、滚动入场、响应式 + 移动端抽屉导航

## 🔐 认证(login / register)

- 注册:邮箱校验、密码强度评分、SHA/scrypt 散列存储(每用户独立盐)
- 登录:错误提示、演示账号一键登录、`?next=` 回跳、**登录限速(10 分钟 8 次/IP)**
- 会话:随机 256-bit token,数据库只存 SHA-256 哈希,HTTP-only + SameSite=Lax,7 天有效期

## 🖥️ 安全运营控制台(dashboard,需登录)

- **总览**:KPI、**安全健康分仪表**、趋势图(7/14/30 日切换)、攻击类型环形图、**攻击雷达**(实时光点扫描)、SSE 实时事件流(多标签页同步)
- **告警中心**:筛选/搜索(防抖)、24 小时分布条形图、**批量选择与批量处置**、**行点击详情抽屉**(证据链 + 处置动作 + **分析师备注**)、封禁/隔离/忽略/解决(服务端权威执行)、注入测试告警、CSV 导出
- **资产管理**:风险评分、**详情抽屉**(端口服务/关联告警)、隔离/恢复/扫描、CSV 导出
- **处置剧本**:**创建/删除自定义剧本**、启停开关、立即执行
- **报表中心**:合规达标率、风险 Top 5、**攻击来源 Top 5**、**IP 封禁名单(一键解封)**、**安全周报一键生成下载(Markdown)**
- **通知中心**:铃铛 + 未读数 + **桌面通知**(后台严重告警弹窗)
- **账号设置**:资料编辑、修改密码、**最近登录记录**、**JSON 备份导出/导入恢复**
- **体验细节**:键盘快捷键(1-6 切视图、? 帮助、Esc 关闭)、实时连接状态指示、gzip 压缩、自定义 404 页
- 登录守卫:api 模式由服务端 401 驱动跳转;demo 模式由前端守卫

## 🚀 运行

**真实模式(推荐)**:

```bash
npm install
npm start          # → http://localhost:3000
```

演示账号:`demo@nexus.sec` / `demo1234`(也可注册任意新账号,自动生成独立数据)

**演示模式**:直接静态托管根目录(或双击 index.html),无需任何构建。

## 📁 结构

```
nexus-security/
├── index.html / login.html / register.html / dashboard.html
├── css/  style.css · app.css · intro.css
├── js/   main.js · intro.js · backend.js · auth.js · auth-pages.js · dashboard.js
├── server/
│   ├── server.js   # Express:认证 / REST / SSE / 静态托管 / 安全头 / 限速
│   └── db.js       # node:sqlite:建表 / scrypt / 会话 / 种子数据
├── data/           # nexus.db(gitignore)
└── package.json
```

## 🌍 部署

- **后端**:任意 Node 主机 `npm start`(PORT 环境变量可改)
- **纯静态**:推到 GitHub Pages 即自动进入演示模式
