/* ═══════════════════════════════════════════════
   NEXUS · 真实后端
   Express + node:sqlite:
   - 会话认证(HTTP-only Cookie + scrypt 口令散列)
   - REST API(告警处置 / 资产 / 剧本 / 总览)
   - SSE 实时事件流(多标签页同步)
   - 静态托管(屏蔽服务端与数据目录)
   ═══════════════════════════════════════════════ */

"use strict";

const express = require("express");
const compression = require("compression");
const path = require("node:path");
const store = require("./db");
const detect = require("./detect");

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIE = "nexus_session";

app.disable("x-powered-by");
// gzip 压缩(SSE 流除外,否则事件会被缓冲导致实时通道卡死)
app.use(compression({
  filter: (req, res) => {
    if (req.path === "/api/stream") return false;
    return compression.filter(req, res);
  },
}));
app.use(express.json({ limit: "32kb" }));

/* ── 安全响应头 ───────────────────────────── */
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; base-uri 'self'; form-action 'self'");
  next();
});

/* ── Cookie 解析(无第三方依赖)───────────── */
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const csrfOf = (token) => require("node:crypto").createHash("sha256").update("csrf::" + token).digest("hex").slice(0, 32);
function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", [
    `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 3600}`,
    `nexus_csrf=${csrfOf(token)}; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 3600}`,
  ]);
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

/* ── 登录限速(每 IP 10 分钟 8 次)────────── */
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return false;
  }
  rec.count += 1;
  return rec.count > 8;
}

/* ── 会话中间件 ───────────────────────────── */
function currentUser(req) {
  return store.getUserByToken(parseCookies(req)[COOKIE]);
}
function requireUser(req, res, next) {
  const token = parseCookies(req)[COOKIE];
  const user = store.getUserByToken(token);
  if (!user) return res.status(401).json({ error: "未登录或会话已过期。" });
  req.user = user;
  req.sessionToken = token;
  next();
}
// CSRF 双提交校验(仅会话鉴权的变更请求;Agent Bearer 路由走 agentAuth 不经过这里)
function csrfGuard(req, res, next) {
  if (!["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) return next();
  const expected = csrfOf(parseCookies(req)[COOKIE] || "");
  if (!expected) return next();
  if (req.headers["x-csrf-token"] !== expected) {
    return res.status(403).json({ error: "CSRF 校验失败,请刷新页面重试。" });
  }
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role || "analyst"))
      return res.status(403).json({ error: `权限不足(需要 ${roles.join("/")})。` });
    next();
  };
}
const ROLE_A = ["admin", "analyst"];
const audit = (req, action, detail) => store.recordAudit(req.user.id, action, detail, req.socket.remoteAddress);

/* ── SSE 实时事件流 ───────────────────────── */
const sseClients = new Map(); // userId -> Set<res>
function ssePush(userId, event) {
  const set = sseClients.get(userId);
  if (!set) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) res.write(payload);
}
app.get("/api/stream", requireUser, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(":ok\n\n");
  const userId = req.user.id;
  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId).add(res);
  const heartbeat = setInterval(() => res.write(":hb\n\n"), 25000);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.get(userId)?.delete(res);
    if (sseClients.get(userId)?.size === 0) sseClients.delete(userId);
  });
});

// 服务器侧环境事件:周期推送给所有在线用户
const AMBIENT = [
  ["ok", "威胁情报库已同步,新增 IOC 1,024 条"],
  ["warn", "资产 fin-wks-207 出站流量小幅升高,持续观察"],
  ["ok", "探针心跳正常 · 1,284 个资产在线"],
  ["warn", "检测到 3 次失败的 SSH 登录,已记录"],
  ["ok", "日志管道延迟 0.8s,运行正常"],
  ["crit", "情报命中:外部 IP 命中勒索软件 C2 名单,已自动封禁"],
  ["ok", "合规基线快照完成,达标率 92.4%"],
];
let ambientIdx = 0;
function sseBroadcastPresence() {
  for (const [uid] of sseClients) {
    const u = store.getUserById(uid);
    if (u) ssePush(uid, { presence: true });
  }
}
setInterval(() => {
  const [level, msg] = AMBIENT[ambientIdx++ % AMBIENT.length];
  for (const userId of sseClients.keys()) {
    const event = store.appendFeed(userId, level, msg);
    ssePush(userId, event);
    ssePush(userId, { presence: true }); // 顺带刷新在线状态,避免初始竞态
    webhookPush(userId, event);
  }
}, 12000);

/* ── 认证 API ─────────────────────────────── */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

app.post("/api/auth/register", (req, res) => {
  const { name, company, email, password } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "请填写你的称呼。" });
  if (!EMAIL_RE.test(String(email || ""))) return res.status(400).json({ error: "请输入有效的邮箱地址。" });
  const pw = String(password || "");
  if (pw.length < 8 || !(/[a-zA-Z]/.test(pw) && /\d/.test(pw)))
    return res.status(400).json({ error: "密码至少 8 位,且需同时包含字母与数字。" });

  const normEmail = String(email).trim().toLowerCase();
  if (store.getUserByEmail(normEmail)) return res.status(409).json({ error: "该邮箱已注册,请直接登录。" });

  const user = store.createUser({ name: String(name).trim().slice(0, 40), company: String(company || "").trim().slice(0, 60), email: normEmail, pass: pw });
  const anyAdmin = store.db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
  if (!anyAdmin) store.setUserRole(user.id, "admin");
  store.recordAudit(user.id, "register", `账号注册(${normEmail})`, req.socket.remoteAddress);
  store.seedUserData(user.id);
  setSessionCookie(res, store.createSession(user.id));
  res.json({ ok: true, user: store.publicUser(user) });
});

app.post("/api/auth/login", (req, res) => {
  const ip = req.socket.remoteAddress || "unknown";
  if (rateLimited(ip)) return res.status(429).json({ error: "尝试过于频繁,请 10 分钟后再试。" });
  const { email, password } = req.body || {};
  const user = store.getUserByEmail(String(email || "").trim().toLowerCase());
  if (!user || !store.verifyPassword(String(password || ""), user.pass))
    return res.status(401).json({ error: "邮箱或密码不正确。" });
  store.recordLogin(user.id, req.socket.remoteAddress, req.headers["user-agent"]);
  store.recordAudit(user.id, "login", "账号登录", req.socket.remoteAddress);
  setSessionCookie(res, store.createSession(user.id));
  res.json({ ok: true, user: store.publicUser(user) });
});

/* ── 登录历史 ─────────────────────────────── */
app.get("/api/auth/logins", requireUser, (req, res) => {
  res.json({ logins: store.getLogins(req.user.id, 5) });
});

app.post("/api/auth/logout", (req, res) => {
  store.recordAudit(currentUser(req)?.id ?? null, "logout", "退出登录", req.socket.remoteAddress);
  store.deleteSession(parseCookies(req)[COOKIE]);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "未登录" });
  res.json(store.publicUser(user));
});

/* ── 数据引导(控制台一次拉全)─────────────── */
app.get("/api/bootstrap", requireUser, (req, res) => {
  const uid = req.user.id;
  res.json({
    user: store.publicUser(req.user), // 含 role
    alerts: store.getAlerts(uid),
    assets: store.getAssets(uid),
    playbooks: store.getPlaybooks(uid),
    trend: store.getTrend(uid),
    feed: store.getFeed(uid).reverse(),
  });
});

/* ── 告警处置 ─────────────────────────────── */
function toAlertJson(r) {
  return { id: r.id, level: r.level, type: r.type, src: r.src, asset: r.asset, desc: r.desc, status: r.status, ts: r.ts, handledBy: r.handled_by };
}

app.post("/api/alerts/:id/action", requireUser, requireRole("admin", "analyst"), csrfGuard, (req, res) => {
  const uid = req.user.id;
  const a = store.getAlert(uid, req.params.id);
  if (!a) return res.status(404).json({ error: "告警不存在。" });
  const act = String((req.body || {}).action || "");
  const name = req.user.name;
  let feed;
  switch (act) {
    case "ban":
      dbSetAlert(uid, a.id, { status: "已封禁", handled_by: name });
      feed = store.appendFeed(uid, "ok", `告警 ${a.id} 来源 IP 已封禁(${a.src})`);
      break;
    case "isolate": {
      dbSetAlert(uid, a.id, { status: "已隔离", handled_by: name });
      const asset = Object.values(store.getAssets(uid)).find((x) => x.name === a.asset);
      if (asset) dbSetAsset(uid, asset.id, { status: "已隔离" });
      feed = store.appendFeed(uid, "crit", `告警 ${a.id} 触发主机隔离:${a.asset}`);
      break;
    }
    case "ignore":
      dbSetAlert(uid, a.id, { status: "已忽略" });
      feed = store.appendFeed(uid, "warn", `告警 ${a.id} 被标记为忽略(${a.type})`);
      break;
    case "resolve":
      dbSetAlert(uid, a.id, { status: "已解决", handled_by: name });
      feed = store.appendFeed(uid, "ok", `告警 ${a.id} 已由 ${name} 处理完毕`);
      break;
    case "unban":
      dbSetAlert(uid, a.id, { status: "已解决" });
      feed = store.appendFeed(uid, "ok", `封禁策略已解除:${a.src}`);
      break;
    case "release": {
      dbSetAlert(uid, a.id, { status: "处理中" });
      const asset = Object.values(store.getAssets(uid)).find((x) => x.name === a.asset && x.status === "已隔离");
      if (asset) dbSetAsset(uid, asset.id, { status: "告警" });
      feed = store.appendFeed(uid, "warn", `主机 ${a.asset} 解除隔离,进入持续观察`);
      break;
    }
    case "reopen":
      dbSetAlert(uid, a.id, { status: "待处置" });
      feed = store.appendFeed(uid, "warn", `告警 ${a.id} 重新进入待处置队列`);
      break;
    default:
      return res.status(400).json({ error: "未知操作。" });
  }
  ssePush(uid, feed);
  webhookPush(uid, feed);
  audit(req, `alert.${act}`, `${a.id}(${a.type}) 状态 → ${a.status || ""}`);
  res.json({ ok: true, feed, alert: toAlertJson(store.getAlert(uid, a.id)) });
});
function dbSetAlert(uid, id, fields) {
  const a = store.getAlert(uid, id);
  const v = { status: a.status, handled_by: a.handled_by, ...fields };
  store.db.prepare("UPDATE alerts SET status = ?, handled_by = ? WHERE user_id = ? AND id = ?")
    .run(v.status, v.handled_by, uid, id);
}

/* ── 资产操作 ─────────────────────────────── */
app.post("/api/assets/:id/action", requireUser, requireRole("admin", "analyst"), csrfGuard, (req, res) => {
  const uid = req.user.id;
  const a = store.getAsset(uid, req.params.id);
  if (!a) return res.status(404).json({ error: "资产不存在。" });
  const act = String((req.body || {}).action || "");
  let feed;
  switch (act) {
    case "isolate":
      dbSetAsset(uid, a.id, { status: "已隔离" });
      store.db.prepare("UPDATE alerts SET status = '已隔离' WHERE user_id = ? AND asset = ? AND status = '处理中'")
        .run(uid, a.name);
      feed = store.appendFeed(uid, "crit", `资产 ${a.name} 已被 ${req.user.name} 手动隔离`);
      break;
    case "release":
      dbSetAsset(uid, a.id, { status: "正常" });
      feed = store.appendFeed(uid, "ok", `资产 ${a.name} 解除隔离,恢复上线`);
      break;
    case "rescan": {
      const risk = Math.max(5, Math.min(95, a.risk + Math.round((Math.random() - 0.6) * 14)));
      dbSetAsset(uid, a.id, { risk });
      feed = store.appendFeed(uid, "ok", `资产 ${a.name} 完成一轮安全扫描`);
      var newRisk = risk;
      break;
    }
    default:
      return res.status(400).json({ error: "未知操作。" });
  }
  ssePush(uid, feed);
  const updated = store.getAsset(uid, a.id);
  res.json({ ok: true, feed, asset: { ...updated, risk: typeof newRisk === "number" ? newRisk : updated.risk } });
});
function dbSetAsset(uid, id, fields) {
  const a = store.getAsset(uid, id);
  const v = { status: a.status, risk: a.risk, ...fields };
  store.db.prepare("UPDATE assets SET status = ?, risk = ? WHERE user_id = ? AND id = ?")
    .run(v.status, v.risk, uid, id);
}

/* ── 处置剧本 ─────────────────────────────── */
app.post("/api/playbooks/:id/toggle", requireUser, requireRole("admin", "analyst"), csrfGuard, (req, res) => {
  const uid = req.user.id;
  const p = store.getPlaybook(uid, req.params.id);
  if (!p) return res.status(404).json({ error: "剧本不存在。" });
  const enabled = !!(req.body || {}).enabled;
  store.db.prepare("UPDATE playbooks SET enabled = ? WHERE user_id = ? AND id = ?").run(enabled ? 1 : 0, uid, p.id);
  const feed = store.appendFeed(uid, enabled ? "ok" : "warn", `剧本「${p.name}」已${enabled ? "启用" : "停用"}`);
  ssePush(uid, feed);
  res.json({ ok: true, feed, playbook: store.getPlaybooks(uid).find((x) => x.id === p.id) });
});

app.post("/api/playbooks/:id/run", requireUser, requireRole("admin", "analyst"), csrfGuard, (req, res) => {
  const uid = req.user.id;
  const p = store.getPlaybook(uid, req.params.id);
  if (!p) return res.status(404).json({ error: "剧本不存在。" });
  if (!p.enabled) return res.status(400).json({ error: "剧本已停用,请先开启开关再执行。" });

  const target = store.db.prepare("SELECT id FROM alerts WHERE user_id = ? AND status = '待处置' ORDER BY ts DESC LIMIT 1").get(uid);
  const runCount = p.run_count + 1;
  store.db.prepare("UPDATE playbooks SET run_count = ?, last_run = ? WHERE user_id = ? AND id = ?")
    .run(runCount, Date.now(), uid, p.id);

  let feed, handled = null;
  if (target) {
    const status = p.name.includes("封禁") ? "已封禁" : "已解决";
    dbSetAlert(uid, target.id, { status, handled_by: `剧本:${p.name}` });
    feed = store.appendFeed(uid, "ok", `剧本「${p.name}」已自动处置告警 ${target.id}`);
    handled = target.id;
  } else {
    feed = store.appendFeed(uid, "ok", `剧本「${p.name}」空跑演练完成,无待处置告警`);
  }
  ssePush(uid, feed);
  res.json({ ok: true, feed, handled, playbook: store.getPlaybooks(uid).find((x) => x.id === p.id) });
});

/* ── 模拟新告警(红队演练)─────────────────── */
app.post("/api/alerts/simulate", requireUser, requireRole("admin", "analyst"), csrfGuard, (req, res) => {
  const uid = req.user.id;
  const alert = store.simulateAlert(uid);
  const feed = store.appendFeed(uid, "crit", `红队演练:注入新告警 ${alert.id}(${alert.type})`);
  ssePush(uid, feed);
  webhookPush(uid, feed);
  res.json({ ok: true, feed, alert: toAlertJson(alert) });
});

/* ── CSV 导出(带 BOM,Excel 友好)────────── */
app.get("/api/export/:what.csv", requireUser, (req, res) => {
  const uid = req.user.id;
  const q = String(req.query.q || "").toLowerCase();
  const level = String(req.query.level || "");
  const status = String(req.query.status || "");
  let rows, header;
  if (req.params.what === "alerts") {
    header = ["告警ID", "等级", "类型", "来源", "目标资产", "状态", "时间", "处置人"];
    rows = store
      .getAlerts(uid)
      .filter((a) => {
        if (level && a.level !== level) return false;
        if (status && a.status !== status) return false;
        if (q && ![a.id, a.src, a.asset, a.type, a.desc].join(" ").toLowerCase().includes(q)) return false;
        return true;
      })
      .map((a) => [a.id, a.level, a.type, a.src, a.asset, a.status, new Date(a.ts).toLocaleString("zh-CN"), a.handledBy]);
  } else if (req.params.what === "assets") {
    header = ["资产名称", "类型", "IP", "系统", "暴露端口", "风险评分", "状态"];
    rows = store.getAssets(uid).map((a) => [a.name, a.type, a.ip, a.os, a.exposure, a.risk, a.status]);
  } else {
    return res.status(404).json({ error: "未知导出类型。" });
  }
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = "\uFEFF" + [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="nexus-${req.params.what}.csv"`);
  res.send(csv);
});

/* ── 修改密码 ─────────────────────────────── */
app.put("/api/auth/password", requireUser, csrfGuard, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!store.verifyPassword(String(oldPassword || ""), req.user.pass))
    return res.status(400).json({ error: "当前密码不正确。" });
  const pw = String(newPassword || "");
  if (pw.length < 8 || !(/[a-zA-Z]/.test(pw) && /\d/.test(pw)))
    return res.status(400).json({ error: "新密码至少 8 位,且需同时包含字母与数字。" });
  if (store.verifyPassword(pw, req.user.pass))
    return res.status(400).json({ error: "新密码不能与当前密码相同。" });
  store.db.prepare("UPDATE users SET pass = ? WHERE id = ?").run(store.hashPassword(pw), req.user.id);
  res.json({ ok: true });
});

/* ── 在线分析师(基于 SSE 连接)────────────── */
app.get("/api/presence", requireUser, (req, res) => {
  const online = [];
  for (const [uid, set] of sseClients) {
    if (!set.size) continue;
    const u = store.getUserById(uid);
    if (u) online.push({ name: u.name, company: u.company });
  }
  const totalUsers = store.db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  res.json({ total: online.length, online, totalUsers });
});

/* ── 团队成员(演示:本组织全部账号)──────── */
app.get("/api/team", requireUser, (req, res) => {
  const users = store.db.prepare("SELECT id, name, company, created_at FROM users ORDER BY created_at").all();
  const members = users.map((u) => ({
    name: u.name,
    company: u.company,
    role: u.role || "analyst",
    createdAt: u.created_at,
    online: (sseClients.get(u.id)?.size || 0) > 0,
  }));
  res.json({ members, online: members.filter((m) => m.online).length });
});

/* ── 资料编辑 ─────────────────────────────── */
app.put("/api/auth/profile", requireUser, csrfGuard, (req, res) => {
  const { name, company } = req.body || {};
  if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: "称呼不能为空。" });
  const updated = store.updateProfile(req.user.id, { name, company });
  sseBroadcastPresence();
  res.json({ ok: true, user: store.publicUser(updated) });
});

/* ── 批量处置 ─────────────────────────────── */
app.post("/api/alerts/batch", requireUser, requireRole("admin", "analyst"), csrfGuard, (req, res) => {
  const uid = req.user.id;
  const { action, ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "未选择任何告警。" });
  const map = { resolve: ["已解决", "ok"], ignore: ["已忽略", "warn"] };
  if (!map[action]) return res.status(400).json({ error: "批量操作仅支持:标记解决 / 忽略。" });
  const [status, level] = map[action];
  const stmt = store.db.prepare("UPDATE alerts SET status = ?, handled_by = ? WHERE user_id = ? AND id = ?");
  let n = 0;
  for (const id of ids.slice(0, 100)) {
    if (store.getAlert(uid, id)) { stmt.run(status, req.user.name, uid, id); n++; }
  }
  const actName = action === "resolve" ? "标记解决" : "忽略";
  const feed = store.appendFeed(uid, level, `${req.user.name} 批量${actName}了 ${n} 条告警`);
  ssePush(uid, feed);
  res.json({ ok: true, count: n, feed, alerts: store.getAlerts(uid) });
});

/* ── 告警备注 ─────────────────────────────── */
app.post("/api/alerts/:id/note", requireUser, requireRole("admin", "analyst"), csrfGuard, (req, res) => {
  const uid = req.user.id;
  const a = store.getAlert(uid, req.params.id);
  if (!a) return res.status(404).json({ error: "告警不存在。" });
  const note = String((req.body || {}).note || "").slice(0, 500);
  store.db.prepare("UPDATE alerts SET note = ? WHERE user_id = ? AND id = ?").run(note, uid, a.id);
  res.json({ ok: true, alert: store.alertJson(store.getAlert(uid, a.id)) });
});

/* ── 剧本创建 / 删除 ──────────────────────── */
app.post("/api/playbooks", requireUser, requireRole("admin", "analyst"), csrfGuard, (req, res) => {
  const uid = req.user.id;
  const { name, trigger, action } = req.body || {};
  if (!String(name || "").trim() || !String(trigger || "").trim() || !String(action || "").trim())
    return res.status(400).json({ error: "名称、触发条件与执行动作均不能为空。" });
  const id = store.insertPlaybook(uid, {
    name: String(name).trim().slice(0, 40),
    trigger: String(trigger).trim().slice(0, 120),
    action: String(action).trim().slice(0, 120),
  });
  const feed = store.appendFeed(uid, "ok", `新建处置剧本「${String(name).trim()}」`);
  ssePush(uid, feed);
  audit(req, "playbook.create", String(name).trim().slice(0, 40));
  res.json({ ok: true, feed, playbooks: store.getPlaybooks(uid) });
});
app.delete("/api/playbooks/:id", requireUser, requireRole("admin", "analyst"), csrfGuard, (req, res) => {
  const uid = req.user.id;
  const p = store.getPlaybook(uid, req.params.id);
  if (!p) return res.status(404).json({ error: "剧本不存在。" });
  store.deletePlaybook(uid, p.id);
  const feed = store.appendFeed(uid, "warn", `删除处置剧本「${p.name}」`);
  ssePush(uid, feed);
  res.json({ ok: true, feed, playbooks: store.getPlaybooks(uid) });
});

/* ── 备份导入 ─────────────────────────────── */
app.post("/api/import", requireUser, requireRole("admin"), csrfGuard, (req, res) => {
  const uid = req.user.id;
  const d = req.body || {};
  const okArr = Array.isArray;
  if (!okArr(d.alerts) || !okArr(d.assets) || !okArr(d.playbooks))
    return res.status(400).json({ error: "备份文件格式不正确(缺少 alerts/assets/playbooks)。" });
  for (const a of d.alerts) {
    if (!a.id || !a.level || !a.type || !a.status) return res.status(400).json({ error: "备份中的告警数据不完整。" });
  }
  try {
    store.replaceUserData(uid, { alerts: d.alerts, assets: d.assets, playbooks: d.playbooks });
  } catch {
    return res.status(400).json({ error: "备份导入失败:数据无法写入。" });
  }
  const feed = store.appendFeed(uid, "warn", `${req.user.name} 导入了数据备份(${d.alerts.length} 条告警)`);
  ssePush(uid, feed);
  res.json({ ok: true, feed, alerts: store.getAlerts(uid), assets: store.getAssets(uid), playbooks: store.getPlaybooks(uid) });
});

/* ── 采集器(Agent)鉴权与数据接入 ──────────── */
function agentAuth(req, res, next) {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  const agent = m && store.getAgentByToken(m[1].trim());
  if (!agent) return res.status(401).json({ error: "无效的采集器 Token。" });
  store.touchAgent(agent.id);
  req.agentInfo = agent;
  next();
}
app.post("/api/ingest/logs", agentAuth, (req, res) => {
  const uid = req.agentInfo.user_id;
  const arr = Array.isArray(req.body && req.body.logs) ? req.body.logs.slice(0, 500) : [];
  if (!arr.length) return res.status(400).json({ error: "logs 数组为空。" });
  const inserted = [];
  for (const l of arr) {
    if (!l || !l.message) continue;
    inserted.push({
      ts: Number(l.ts) > 0 ? Number(l.ts) : Date.now(),
      host: String(l.host || "").slice(0, 80),
      program: String(l.program || "").slice(0, 40),
      message: String(l.message).slice(0, 500),
    });
  }
  if (!inserted.length) return res.status(400).json({ error: "无有效日志。" });
  for (const l of inserted) store.insertLog(uid, req.agentInfo.id, l);
  store.trimLogs(uid, 20000);

  // 检测引擎:真实日志 → 真实告警
  const customRules = store.listCustomRules(uid);
  const created = [];
  for (const a of detect.detectLogs(uid, inserted, customRules)) {
    const id = "DET-" + String(1000 + store.alertCount(uid));
    const saved = store.insertAlert(uid, {
      id, level: a.level, type: a.type, src: a.src, asset: a.asset,
      desc: a.desc, status: "待处置", ts: Date.now(), handledBy: "",
      ruleId: a.ruleId, logExcerpt: a.logExcerpt,
    });
    created.push(saved);
    const feed = store.appendFeed(uid, a.level === "crit" ? "crit" : a.level === "high" ? "warn" : "med",
      `检测引擎命中「${a.type}」→ ${id}(来源 ${a.src})`);
    ssePush(uid, feed);
    webhookPush(uid, feed);
  }
  store.recordAudit(uid, "ingest", `采集器接入 ${inserted.length} 条日志,检出 ${created.length} 条告警`, "-");
  ssePush(uid, { reload: true }); // 通知控制台刷新告警列表
  res.json({ accepted: inserted.length, alerts: created.map((a) => a.id) });
});

app.get("/api/agents", requireUser, (req, res) => {
  res.json({ agents: store.listAgents(req.user.id) });
});
app.post("/api/agents", requireUser, requireRole("admin", "analyst"), csrfGuard, (req, res) => {
  const name = String((req.body || {}).name || "").trim() || "采集器";
  const { id, token } = store.createAgent(req.user.id, name);
  const feed = store.appendFeed(req.user.id, "ok", `创建采集器「${name}」,请妥善保存 Token`);
  ssePush(req.user.id, feed);
  res.json({ ok: true, id, token }); // Token 仅此一次明文返回
});
app.delete("/api/agents/:id", requireUser, requireRole("admin", "analyst"), csrfGuard, (req, res) => {
  store.revokeAgent(req.user.id, Number(req.params.id));
  audit(req, "agent.revoke", `采集器 #${req.params.id} 吊销`);
  res.json({ ok: true, agents: store.listAgents(req.user.id) });
});
app.get("/api/rules", requireUser, (req, res) => {
  res.json({ rules: detect.listRules(), custom: store.listCustomRules(req.user.id) });
});
app.post("/api/detect/rules", requireUser, requireRole("admin", "analyst"), csrfGuard, (req, res) => {
  const { name, level, type, pattern } = req.body || {};
  if (!String(name || "").trim() || !String(type || "").trim() || !String(pattern || "").trim())
    return res.status(400).json({ error: "名称、类型与匹配模式均不能为空。" });
  if (!["crit", "high", "med", "low"].includes(level)) return res.status(400).json({ error: "等级无效。" });
  if (String(pattern).length > 300) return res.status(400).json({ error: "匹配模式过长(≤300)。" });
  try { new RegExp(String(pattern), "i"); }
  catch { return res.status(400).json({ error: "正则表达式无效,请检查语法。" }); }
  if (store.customRuleCount(req.user.id) >= 20) return res.status(400).json({ error: "自定义规则已达上限(20 条)。" });
  const rule = store.insertCustomRule(req.user.id, {
    name: String(name).trim().slice(0, 40), level, type: String(type).trim().slice(0, 30),
    pattern: String(pattern).trim(),
  });
  audit(req, "rule.create", `${rule.id} ${rule.name}`);
  res.json({ ok: true, rule, custom: store.listCustomRules(req.user.id) });
});
app.delete("/api/detect/rules/:id", requireUser, requireRole("admin", "analyst"), csrfGuard, (req, res) => {
  store.deleteCustomRule(req.user.id, req.params.id);
  audit(req, "rule.delete", req.params.id);
  res.json({ ok: true, custom: store.listCustomRules(req.user.id) });
});
app.get("/api/alerts", requireUser, (req, res) => {
  res.json({ alerts: store.getAlerts(req.user.id) });
});

/* ── RBAC 角色管理(仅管理员)──────────────── */
app.put("/api/users/:id/role", requireUser, requireRole("admin"), csrfGuard, (req, res) => {
  const role = String((req.body || {}).role || "");
  if (!["admin", "analyst", "viewer"].includes(role)) return res.status(400).json({ error: "角色必须是 admin / analyst / viewer。" });
  const id = Number(req.params.id);
  if (id === req.user.id && role !== "admin") return res.status(400).json({ error: "不能降级自己的管理员角色。" });
  const u = store.getUserById(id);
  if (!u) return res.status(404).json({ error: "用户不存在。" });
  store.setUserRole(id, role);
  audit(req, "role.change", `${u.email} → ${role}`);
  res.json({ ok: true, users: store.listUsers() });
});
app.get("/api/audit", requireUser, requireRole("admin"), (req, res) => {
  res.json({ audit: store.getAudit(null, 50) });
});
app.put("/api/users/role", requireUser, requireRole("admin"), csrfGuard, (req, res) => {
  const { name, role } = req.body || {};
  if (!["admin", "analyst", "viewer"].includes(role)) return res.status(400).json({ error: "角色无效。" });
  const u = store.getUserByEmail(String(name || "").trim().toLowerCase());
  if (!u) return res.status(404).json({ error: "用户不存在。" });
  if (u.id === req.user.id && role !== "admin") return res.status(400).json({ error: "不能降级自己的管理员角色。" });
  store.setUserRole(u.id, role);
  audit(req, "role.change", `${u.email} → ${role}`);
  res.json({ ok: true });
});

/* ── Webhook 告警推送 ─────────────────────── */
function webhookPayload(url, event) {
  const text = `[NEXUS ${event.level.toUpperCase()}] ${event.msg}`;
  // 自动识别 IM 平台推送格式
  if (url.includes("open.feishu.cn")) return { msg_type: "text", content: { text } };
  if (url.includes("oapi.dingtalk.com")) return { msgtype: "text", text: { content: text } };
  if (url.includes("hooks.slack.com")) return { text };
  return { source: "NEXUS", level: event.level, msg: event.msg, ts: event.ts };
}

// Webhook 签名:HMAC-SHA256(secret, rawBody) → X-NEXUS-Signature 头,接收端可验真
const crypto = require("node:crypto");
function webhookDeliver(user, event, attempt = 1) {
  if (!user.webhook) return;
  const body = JSON.stringify(webhookPayload(user.webhook, event));
  const sig = "sha256=" + crypto.createHmac("sha256", user.webhook_secret || "").update(body).digest("hex");
  fetch(user.webhook, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-NEXUS-Signature": sig,
      "X-NEXUS-Event": event.level,
      "User-Agent": "NEXUS-Webhook/1.0",
    },
    body,
  }).then((r) => {
    if (!r.ok && attempt < 3) webhookRetry(user, event, attempt);
  }).catch(() => {
    if (attempt < 3) webhookRetry(user, event, attempt); // 失败重试:最多 3 次
  });
}
const webhookQueue = [];
function webhookRetry(user, event, attempt) {
  webhookQueue.push({ userId: user.id, event, attempt: attempt + 1 });
}
// 重试队列消费:指数退避(30s → 60s → 120s 由轮次近似)
setInterval(() => {
  const item = webhookQueue.shift();
  if (item) {
    const u = store.getUserById(item.userId);
    if (u && u.webhook) webhookDeliver(u, item.event, item.attempt);
  }
}, 30000);

function webhookPush(userId, event) {
  const user = store.getUserById(userId);
  if (!user || !user.webhook) return;
  if (!["crit", "high"].includes(event.level)) return;
  webhookDeliver(user, event);
}
app.put("/api/auth/webhook", requireUser, csrfGuard, (req, res) => {
  const url = String((req.body || {}).url || "").trim();
  if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Webhook 地址必须以 http(s):// 开头。" });
  const updated = store.updateUserWebhook(req.user.id, url);
  audit(req, "webhook.set", url || "(清除)");
  res.json({ ok: true, webhook: url, webhookSecret: updated.webhook_secret || "" });
});
app.post("/api/webhook/test", requireUser, async (req, res) => {
  const user = store.getUserById(req.user.id);
  if (!user.webhook) return res.status(400).json({ error: "请先保存 Webhook 地址。" });
  const payload = webhookPayload(user.webhook, { level: "crit", msg: "这是一条 Webhook 测试推送", ts: Date.now() });
  const body = JSON.stringify(payload);
  const sig = "sha256=" + crypto.createHmac("sha256", user.webhook_secret || "").update(body).digest("hex");
  try {
    await fetch(user.webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-NEXUS-Signature": sig, "X-NEXUS-Event": "crit" },
      body,
      signal: AbortSignal.timeout(5000),
    });
    res.json({ ok: true, msg: "测试推送已发送,请检查接收端。" });
  } catch {
    res.status(502).json({ error: "推送失败:目标地址不可达或超时(5 秒)。" });
  }
});

/* ── 演示账号(启动时确保存在)────────────── */
function ensureDemoUser() {
  const email = "demo@nexus.sec";
  let user = store.getUserByEmail(email);
  if (!user) {
    user = store.createUser({ name: "演示管理员", company: "NEXUS 演示环境", email, pass: "demo1234", role: "admin" });
  }
  store.seedUserData(user.id);
}

/* ── 静态资源(屏蔽服务端与数据)───────────── */
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api")) return next();
  const blocked = /^\/(server|data|node_modules|\.git)(\/|$)|^\/(package(-lock)?\.json|\.gitignore)$/i;
  if (blocked.test(req.path)) return res.status(404).end("Not Found");
  next();
});
app.use(express.static(path.join(__dirname, ".."), { index: "index.html", maxAge: "5m", setHeaders: (res, file) => {
  if (file.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
} }));

app.use((req, res) => {
  if (req.method === "GET" && !req.path.startsWith("/api") && req.accepts("html")) {
    return res.status(404).sendFile(path.join(__dirname, "..", "404.html"));
  }
  res.status(404).end("Not Found");
});
// 统一错误处理(避免泄漏堆栈)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "服务器内部错误。" });
});

// 日志保留策略:清理 7 天前的原始日志
setInterval(() => {
  store.db.prepare("DELETE FROM logs WHERE ts < ?").run(Date.now() - 7 * 86400000);
}, 6 * 3600 * 1000);
store.db.prepare("DELETE FROM logs WHERE ts < ?").run(Date.now() - 7 * 86400000);

store.purgeExpiredSessions();
store.migrateTrends();
ensureDemoUser();
app.listen(PORT, () => {
  console.log(`NEXUS 后端已启动 → http://localhost:${PORT}`);
  console.log(`演示账号:demo@nexus.sec / demo1234`);
});
