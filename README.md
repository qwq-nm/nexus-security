# NEXUS · 网络安全态势感知平台(Landing Page)

一个以**网络安全**为主题的静态落地页:深色科技风、发光线框网络球体、实时威胁事件流演示。

> 灵感来自 [Aura](https://www.aura.build/browse/components) 模板广场中的 **Network Security SaaS Landing Page Template** 风格,全部代码为原创实现。

## ✨ 特性

- 🌐 **Canvas 网络球体** — 斐波那契球面布点 + 近邻连线 + 鼠标视差,零依赖
- 🖥️ **威胁事件流** — 模拟 SOC 实时告警终端,自动分级(CRIT / HIGH / MED / OK)
- 📊 **数字滚动** — 拦截率、响应时间等指标入场动画
- 📱 **响应式** — 桌面 / 平板 / 手机全覆盖,移动端抽屉导航
- ⚡ **零依赖、零构建** — 纯 HTML / CSS / JS,直接静态托管

## 📁 结构

```
nexus-security/
├── index.html      # 单页结构(导航/Hero/数据/流程/能力/威胁中心/定价/FAQ/CTA)
├── css/style.css   # 深色主题样式
└── js/main.js      # 球体动画 / 日志流 / 交互
```

## 🚀 本地运行

直接双击 `index.html`,或:

```bash
npx serve .
```

## 🌍 部署

推送至 GitHub 后,在仓库 **Settings → Pages** 选择 `main` 分支 / 根目录即可。
