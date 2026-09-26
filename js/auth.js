/* ═══════════════════════════════════════════════
   NEXUS · 用户与数据层(纯前端演示,localStorage 模拟后端)
   —— 演示项目:请勿用于真实生产环境
   ═══════════════════════════════════════════════ */

(() => {
  "use strict";

  const K = {
    users: "nexus_users",
    session: "nexus_session",
    alerts: (u) => `nexus_alerts_${u}`,
    assets: (u) => `nexus_assets_${u}`,
    playbooks: (u) => `nexus_playbooks_${u}`,
    trend: (u) => `nexus_trend_${u}`,
    feed: (u) => `nexus_feed_${u}`,
  };

  const DEMO = { email: "demo@nexus.sec", password: "demo1234", name: "演示管理员", company: "NEXUS 演示环境" };

  /* ── 存取工具 ─────────────────────────────── */
  const read = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  };
  const write = (key, val) => {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch { return false; }
  };

  /* ── 密码摘要(演示:SHA-256,WebCrypto 不可用时降级) ── */
  async function hashPassword(pw) {
    const salted = "nexus::" + pw;
    try {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salted));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      let h = 5381;
      for (let i = 0; i < salted.length; i++) h = ((h << 5) + h + salted.charCodeAt(i)) >>> 0;
      return "djb2_" + h.toString(16);
    }
  }

  /* ── 用户体系 ─────────────────────────────── */
  async function registerUser({ name, company, email, password }) {
    const users = read(K.users, []);
    email = email.trim().toLowerCase();
    if (users.some((u) => u.email === email)) return { ok: false, error: "该邮箱已注册,请直接登录。" };
    const user = {
      email, name: name.trim(), company: (company || "").trim(),
      hash: await hashPassword(password), createdAt: Date.now(),
    };
    users.push(user);
    write(K.users, users);
    seedUserData(email);
    return { ok: true, user };
  }

  async function loginUser(email, password) {
    const users = read(K.users, []);
    email = email.trim().toLowerCase();
    const user = users.find((u) => u.email === email);
    if (!user) return { ok: false, error: "账号不存在,请先注册。" };
    const hash = await hashPassword(password);
    if (user.hash !== hash) return { ok: false, error: "密码不正确,请重试。" };
    return { ok: true, user };
  }

  function setSession(email) { write(K.session, email); }
  function clearSession() { try { localStorage.removeItem(K.session); } catch {} }

  function currentUser() {
    const email = read(K.session, null);
    if (!email) return null;
    return read(K.users, []).find((u) => u.email === email) || null;
  }

  /** 控制台页守卫:未登录跳转登录页 */
  function requireAuth() {
    const user = currentUser();
    if (!user) {
      location.replace("login.html?next=" + encodeURIComponent("dashboard.html"));
      return null;
    }
    return user;
  }

  function ensureDemoUser() {
    const users = read(K.users, []);
    if (!users.some((u) => u.email === DEMO.email)) {
      users.push({
        email: DEMO.email, name: DEMO.name, company: DEMO.company,
        hashSyncPlaceholder: true, createdAt: Date.now(),
      });
      // 演示账号的 hash 需要异步补写
      const email = DEMO.email;
      hashPassword(DEMO.password).then((hash) => {
        const list = read(K.users, []);
        const u = list.find((x) => x.email === email);
        if (u) { delete u.hashSyncPlaceholder; u.hash = hash; write(K.users, list); }
      });
      write(K.users, users);
      seedUserData(DEMO.email);
    }
  }

  /* ── 按用户隔离的演示数据 ─────────────────── */
  // 可复现伪随机(保证每个人看到的数据形态稳定且美观)
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const now = () => Date.now();
  const min = (n) => n * 60 * 1000;

  function seedUserData(email) {
    if (read(K.alerts(email), null)) return; // 已初始化

    const rnd = mulberry32(20260925);
    const assets = [
      { id: "a1", name: "web-cluster-01", type: "服务器", ip: "10.12.3.21", os: "Ubuntu 22.04", exposure: 4, risk: 32, status: "正常" },
      { id: "a2", name: "api-gateway-02", type: "服务器", ip: "10.12.3.22", os: "Ubuntu 22.04", exposure: 3, risk: 41, status: "告警" },
      { id: "a3", name: "db-primary", type: "数据库", ip: "10.12.5.10", os: "Debian 12", exposure: 1, risk: 18, status: "正常" },
      { id: "a4", name: "k8s-node-07", type: "容器节点", ip: "10.12.8.7", os: "Container Linux", exposure: 12, risk: 76, status: "已隔离" },
      { id: "a5", name: "k8s-node-12", type: "容器节点", ip: "10.12.8.12", os: "Container Linux", exposure: 9, risk: 58, status: "已隔离" },
      { id: "a6", name: "hr-wks-114", type: "工作站", ip: "10.20.1.114", os: "Windows 11", exposure: 2, risk: 64, status: "告警" },
      { id: "a7", name: "fin-wks-207", type: "工作站", ip: "10.20.1.207", os: "Windows 11", exposure: 2, risk: 22, status: "正常" },
      { id: "a8", name: "vpn-edge-7", type: "网关", ip: "10.12.9.7", os: "Linux 6.1", exposure: 2, risk: 35, status: "正常" },
      { id: "a9", name: "oss-bucket-logs", type: "云资源", ip: "-", os: "对象存储", exposure: 1, risk: 12, status: "正常" },
      { id: "a10", name: "cdn-metrics", type: "云资源", ip: "-", os: "CDN", exposure: 2, risk: 47, status: "正常" },
    ];

    const alertTpl = [
      ["crit", "暴力破解", "45.83.207.11", "vpn-edge-7", "检测到对 VPN 网关的持续性口令爆破,速率 1,200 次/分"],
      ["crit", "挖矿行为", "内生的", "k8s-node-12", "识别到 xmrig 挖矿进程,CPU 占用 94%,已自动隔离"],
      ["high", "SQL 注入", "91.240.118.6", "api-gateway-02", "拦截针对 /orders 接口的 UNION 注入载荷,已隔离请求"],
      ["high", "异常外联", "内生的", "hr-wks-114", "工作站向未知地址 2.3GB 外传流量,疑似数据泄露"],
      ["high", "恶意样本", "103.97.3.84", "fin-wks-207", "邮件附件检出 Emotet 变种,哈希已同步情报网络"],
      ["med", "端口扫描", "185.220.101.7", "web-cluster-01", "SYN 扫描 1,024 个端口,已触发限流"],
      ["med", "弱口令", "内生的", "db-primary", "服务账号 90 天未改密且命中弱口令字典"],
      ["med", "DNS 隧道", "内生的", "cdn-metrics", "检测到可疑子域连续解析,疑似数据外传通道"],
      ["med", "越权访问", "内生的", "api-gateway-02", "普通账号尝试访问管理接口 /admin/users"],
      ["low", "证书到期", "-", "vpn-edge-7", "TLS 服务器证书将于 14 天后到期"],
      ["low", "配置漂移", "-", "k8s-node-07", "检测到安全组规则被放宽(0.0.0.0/0)"],
      ["low", "爬虫行为", "66.249.66.1", "web-cluster-01", "疑似竞对爬虫高频抓取价格页"],
      ["high", "横向移动", "内生的", "k8s-node-07", "失陷容器尝试 SMB 连接同网段 3 台主机"],
      ["crit", "勒索软件", "内生的", "hr-wks-114", "检测到文件批量加密行为,已阻断并回滚 32 个文件"],
    ];
    const statuses = ["待处置", "待处置", "处理中", "已封禁", "已忽略", "已解决", "待处置", "处理中", "已解决", "已解决", "已忽略", "已解决", "处理中", "已隔离"];
    const alerts = alertTpl.map((t, i) => ({
      id: "ALT-" + String(10247 + i),
      level: t[0], type: t[1], src: t[2], asset: t[3], desc: t[4],
      status: statuses[i],
      ts: now() - min(8 + Math.floor(rnd() * 60 * 47)),
      handledBy: "",
    }));

    const playbooks = [
      { id: "PB-01", name: "IP 自动封禁", trigger: "告警等级 ≥ HIGH 且来源为外部 IP", action: "防火墙下发封禁策略 + 通知值班", enabled: true, runCount: 1284, lastRun: now() - min(23) },
      { id: "PB-02", name: "失陷主机隔离", trigger: "EDR 判定失陷(置信度 > 90%)", action: "断开网卡 + 内存取证 + 工单", enabled: true, runCount: 47, lastRun: now() - min(96) },
      { id: "PB-03", name: "勒索行为阻断", trigger: "批量文件加密行为特征", action: "进程冻结 + 文件回滚 + 全员通告", enabled: true, runCount: 3, lastRun: now() - min(310) },
      { id: "PB-04", name: "弱口令整改", trigger: "命中弱口令字典", action: "强制改密 + MFA 绑定提醒", enabled: true, runCount: 89, lastRun: now() - min(1440) },
      { id: "PB-05", name: "数据外传拦截", trigger: "出站流量 > 1GB 且目标未备案", action: "限速 10KB/s + 人工研判工单", enabled: false, runCount: 0, lastRun: 0 },
      { id: "PB-06", name: "证书到期换发", trigger: "证书剩余有效期 < 15 天", action: "ACME 自动续期 + 校验部署", enabled: true, runCount: 26, lastRun: now() - min(2880) },
    ];

    const days = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    let base = 320;
    const trend = days.map((d) => {
      base = Math.max(140, Math.round(base + (rnd() - 0.45) * 90));
      return { day: d, alerts: base, blocked: Math.round(base * (0.9 + rnd() * 0.08)) };
    });

    const feed = [
      { ts: now() - min(3), level: "ok", msg: "处置剧本「IP 自动封禁」执行成功,封禁 45.83.207.11" },
      { ts: now() - min(12), level: "warn", msg: "资产 k8s-node-12 进入隔离状态" },
      { ts: now() - min(26), level: "crit", msg: "检测到勒索软件行为,剧本「勒索行为阻断」已介入" },
      { ts: now() - min(58), level: "ok", msg: "全网资产扫描完成,1,284 个资产在线" },
    ];

    write(K.alerts(email), alerts);
    write(K.assets(email), assets);
    write(K.playbooks(email), playbooks);
    write(K.trend(email), trend);
    write(K.feed(email), feed);
  }

  /** 演示模式:修改密码(校验旧密码) */
  async function changePassword(email, oldPassword, newPassword) {
    const users = read(K.users, []);
    const u = users.find((x) => x.email === email);
    if (!u) return { ok: false, error: "账号不存在。" };
    const oldHash = await hashPassword(oldPassword);
    if (u.hash !== oldHash) return { ok: false, error: "当前密码不正确。" };
    if (newPassword.length < 8 || !(/[a-zA-Z]/.test(newPassword) && /\d/.test(newPassword)))
      return { ok: false, error: "新密码至少 8 位,且需同时包含字母与数字。" };
    if (oldPassword === newPassword) return { ok: false, error: "新密码不能与当前密码相同。" };
    u.hash = await hashPassword(newPassword);
    write(K.users, users);
    return { ok: true };
  }

  /** 演示模式:重置演示账号口令(保证"一键体验"始终可用) */
  async function resetDemoPassword() {
    const users = read(K.users, []);
    const u = users.find((x) => x.email === DEMO.email);
    if (!u) { ensureDemoUser(); return; }
    u.hash = await hashPassword(DEMO.password);
    write(K.users, users);
  }

  window.NEXUS = {
    K, read, write, hashPassword,
    registerUser, loginUser, setSession, clearSession,
    currentUser, requireAuth, ensureDemoUser, seedUserData, changePassword, resetDemoPassword,
    DEMO,
  };
})();
