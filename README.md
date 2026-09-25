# NEXUS · 网络安全态势感知平台

一个以**网络安全**为主题、前端功能完整的产品站:深色科技风落地页 + 可登录的安全运营控制台(SOC)。

> 灵感来自 [Aura](https://www.aura.build/browse/components) 模板广场中的 **Network Security SaaS Landing Page Template** 风格,全部代码为原创实现。
> 纯前端演示:用户体系与业务数据存储于浏览器 localStorage,**请勿用于真实生产环境**。

## ✨ 功能

### 落地页(index.html)
- 🌐 Canvas 线框网络球体:斐波那契球面布点 + 近邻连线 + 鼠标视差
- 🖥️ 威胁事件流终端:CRIT / HIGH / MED / OK 分级告警自动滚动
- 📊 数字滚动、滚动入场动画、响应式布局、移动端抽屉导航
- 全部 CTA 已接入真实页面(注册 / 登录 / 控制台)

### 认证(login.html / register.html)
- 注册:邮箱校验、密码强度评分、二次确认、条款勾选
- 登录:错误提示、演示账号一键登录、`?next=` 登录后回跳
- 密码 SHA-256 摘要存储(WebCrypto,不可用时自动降级)

### 安全运营控制台(dashboard.html,需登录)
- **总览**:KPI 卡片、近 7 日告警趋势(面积/折线)、攻击类型分布环形图、实时事件流
- **告警中心**:14 条种子告警;按等级/状态/关键词筛选;封禁、隔离(带确认弹窗)、忽略、解决、重新处理等处置动作,全部持久化
- **资产管理**:10 个资产;风险评分条、暴露端口;隔离 / 恢复上线 / 发起扫描
- **处置剧本**:6 个自动化剧本;启用开关、立即执行(自动处置一条待办告警并写入事件流)
- **报表中心**:合规基线达标率动画、风险 Top 5 资产、周报归档
- 登录守卫:未登录访问自动跳转 `login.html?next=dashboard.html`

## 📁 结构

```
nexus-security/
├── index.html          # 落地页
├── login.html          # 登录
├── register.html       # 注册
├── dashboard.html      # 安全运营控制台(单页多视图)
├── css/
│   ├── style.css       # 设计系统与落地页样式
│   └── app.css         # 认证页 + 控制台样式
└── js/
    ├── auth.js         # 用户与数据层(localStorage 模拟后端)
    ├── auth-pages.js   # 登录/注册表单逻辑
    ├── dashboard.js    # 控制台:状态、图表、处置动作
    └── main.js         # 落地页:球体动画 / 交互
```

## 🚀 本地运行

直接双击 `index.html`,或:

```bash
npx serve .
```

## 🌍 部署

推送至 GitHub 后,在仓库 **Settings → Pages** 选择 `main` 分支 / 根目录即可。

## 🔑 演示账号

| 邮箱 | 密码 |
| --- | --- |
| `demo@nexus.sec` | `demo1234` |

注册任意账号同样会获得一份独立的演示数据。
