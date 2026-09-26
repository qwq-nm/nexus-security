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
function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie",
    `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 3600}`);
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
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "未登录或会话已过期。" });
  req.user = user;
  next();
}

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
  setSessionCookie(res, store.createSession(user.id));
  res.json({ ok: true, user: store.publicUser(user) });
});

/* ── 登录历史 ─────────────────────────────── */
app.get("/api/auth/logins", requireUser, (req, res) => {
  res.json({ logins: store.getLogins(req.user.id, 5) });
});

app.post("/api/auth/logout", (req, res) => {
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
    user: store.publicUser(req.user),
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

app.post("/api/alerts/:id/action", requireUser, (req, res) => {
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
  res.json({ ok: true, feed, alert: toAlertJson(store.getAlert(uid, a.id)) });
});
function dbSetAlert(uid, id, fields) {
  const a = store.getAlert(uid, id);
  const v = { status: a.status, handled_by: a.handled_by, ...fields };
  store.db.prepare("UPDATE alerts SET status = ?, handled_by = ? WHERE user_id = ? AND id = ?")
    .run(v.status, v.handled_by, uid, id);
}

/* ── 资产操作 ─────────────────────────────── */
app.post("/api/assets/:id/action", requireUser, (req, res) => {
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
app.post("/api/playbooks/:id/toggle", requireUser, (req, res) => {
  const uid = req.user.id;
  const p = store.getPlaybook(uid, req.params.id);
  if (!p) return res.status(404).json({ error: "剧本不存在。" });
  const enabled = !!(req.body || {}).enabled;
  store.db.prepare("UPDATE playbooks SET enabled = ? WHERE user_id = ? AND id = ?").run(enabled ? 1 : 0, uid, p.id);
  const feed = store.appendFeed(uid, enabled ? "ok" : "warn", `剧本「${p.name}」已${enabled ? "启用" : "停用"}`);
  ssePush(uid, feed);
  res.json({ ok: true, feed, playbook: store.getPlaybooks(uid).find((x) => x.id === p.id) });
});

app.post("/api/playbooks/:id/run", requireUser, (req, res) => {
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
app.post("/api/alerts/simulate", requireUser, (req, res) => {
  const uid = req.user.id;
  const alert = store.simulateAlert(uid);
  const feed = store.appendFeed(uid, "crit", `红队演练:注入新告警 ${alert.id}(${alert.type})`);
  ssePush(uid, feed);
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
app.put("/api/auth/password", requireUser, (req, res) => {
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
  res.json({ total: online.length, online });
});

/* ── 资料编辑 ─────────────────────────────── */
app.put("/api/auth/profile", requireUser, (req, res) => {
  const { name, company } = req.body || {};
  if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: "称呼不能为空。" });
  const updated = store.updateProfile(req.user.id, { name, company });
  sseBroadcastPresence();
  res.json({ ok: true, user: store.publicUser(updated) });
});

/* ── 批量处置 ─────────────────────────────── */
app.post("/api/alerts/batch", requireUser, (req, res) => {
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
app.post("/api/alerts/:id/note", requireUser, (req, res) => {
  const uid = req.user.id;
  const a = store.getAlert(uid, req.params.id);
  if (!a) return res.status(404).json({ error: "告警不存在。" });
  const note = String((req.body || {}).note || "").slice(0, 500);
  store.db.prepare("UPDATE alerts SET note = ? WHERE user_id = ? AND id = ?").run(note, uid, a.id);
  res.json({ ok: true, alert: store.alertJson(store.getAlert(uid, a.id)) });
});

/* ── 剧本创建 / 删除 ──────────────────────── */
app.post("/api/playbooks", requireUser, (req, res) => {
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
  res.json({ ok: true, feed, playbooks: store.getPlaybooks(uid) });
});
app.delete("/api/playbooks/:id", requireUser, (req, res) => {
  const uid = req.user.id;
  const p = store.getPlaybook(uid, req.params.id);
  if (!p) return res.status(404).json({ error: "剧本不存在。" });
  store.deletePlaybook(uid, p.id);
  const feed = store.appendFeed(uid, "warn", `删除处置剧本「${p.name}」`);
  ssePush(uid, feed);
  res.json({ ok: true, feed, playbooks: store.getPlaybooks(uid) });
});

/* ── 备份导入 ─────────────────────────────── */
app.post("/api/import", requireUser, (req, res) => {
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

/* ── 演示账号(启动时确保存在)────────────── */
function ensureDemoUser() {
  const email = "demo@nexus.sec";
  let user = store.getUserByEmail(email);
  if (!user) {
    user = store.createUser({ name: "演示管理员", company: "NEXUS 演示环境", email, pass: "demo1234" });
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

store.purgeExpiredSessions();
store.migrateTrends();
ensureDemoUser();
app.listen(PORT, () => {
  console.log(`NEXUS 后端已启动 → http://localhost:${PORT}`);
  console.log(`演示账号:demo@nexus.sec / demo1234`);
});
