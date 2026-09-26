/* ═══════════════════════════════════════════════
   NEXUS · 数据库层(node:sqlite)
   真实持久化:data/nexus.db(WAL 模式)
   ═══════════════════════════════════════════════ */

"use strict";

const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = process.env.NEXUS_DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "nexus.db"));
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    company    TEXT DEFAULT '',
    email      TEXT NOT NULL UNIQUE,
    pass       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id         TEXT NOT NULL,
    user_id    INTEGER NOT NULL,
    level      TEXT NOT NULL,
    type       TEXT NOT NULL,
    src        TEXT NOT NULL,
    asset      TEXT NOT NULL,
    desc       TEXT NOT NULL,
    status     TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    handled_by TEXT DEFAULT '',
    PRIMARY KEY (user_id, id)
  );
  CREATE TABLE IF NOT EXISTS assets (
    id       TEXT NOT NULL,
    user_id  INTEGER NOT NULL,
    name     TEXT NOT NULL,
    type     TEXT NOT NULL,
    ip       TEXT NOT NULL,
    os       TEXT NOT NULL,
    exposure INTEGER NOT NULL,
    risk     INTEGER NOT NULL,
    status   TEXT NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE TABLE IF NOT EXISTS playbooks (
    id        TEXT NOT NULL,
    user_id   INTEGER NOT NULL,
    name      TEXT NOT NULL,
    trigger   TEXT NOT NULL,
    action    TEXT NOT NULL,
    enabled   INTEGER NOT NULL,
    run_count INTEGER NOT NULL,
    last_run  INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE TABLE IF NOT EXISTS trend (
    user_id INTEGER NOT NULL,
    idx     INTEGER NOT NULL,
    day     TEXT NOT NULL,
    alerts  INTEGER NOT NULL,
    blocked INTEGER NOT NULL,
    PRIMARY KEY (user_id, idx)
  );
  CREATE TABLE IF NOT EXISTS feed (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    ts      INTEGER NOT NULL,
    level   TEXT NOT NULL,
    msg     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_feed_user ON feed(user_id, id);
`);

// 老库迁移:告警备注列 + 用户 Webhook 列 + 趋势四级分布
try { db.exec("ALTER TABLE alerts ADD COLUMN note TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN webhook TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN webhook_secret TEXT DEFAULT ''"); } catch {}
try {
  db.exec("ALTER TABLE alerts ADD COLUMN rule_id TEXT DEFAULT ''");
  db.exec("ALTER TABLE alerts ADD COLUMN log_excerpt TEXT DEFAULT ''");
} catch {}
try { db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'analyst'"); } catch {}
try { db.exec("CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, ts INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT DEFAULT '', ip TEXT DEFAULT '')"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_audit_user ON audit(user_id, id)"); } catch {}

// RBAC 迁移:最早的账号与演示账号设为 admin
try {
  db.prepare("UPDATE users SET role = 'admin' WHERE id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1)").run();
  db.prepare("UPDATE users SET role = 'admin' WHERE email = 'demo@nexus.sec'").run();
} catch {}
try {
  db.exec("ALTER TABLE trend ADD COLUMN crit INTEGER DEFAULT 0");
  db.exec("ALTER TABLE trend ADD COLUMN high INTEGER DEFAULT 0");
  db.exec("ALTER TABLE trend ADD COLUMN med INTEGER DEFAULT 0");
  db.exec("ALTER TABLE trend ADD COLUMN low INTEGER DEFAULT 0");
} catch {}
db.exec(`
  CREATE TABLE IF NOT EXISTS logins (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER NOT NULL,
    ts       INTEGER NOT NULL,
    ip       TEXT NOT NULL,
    ua       TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_logins_user ON logins(user_id, id);
  CREATE TABLE IF NOT EXISTS agents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    name       TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id);
  CREATE TABLE IF NOT EXISTS logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    agent_id INTEGER,
    ts      INTEGER NOT NULL,
    host    TEXT DEFAULT '',
    program TEXT DEFAULT '',
    message TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(user_id, id);
  CREATE TABLE IF NOT EXISTS detection_rules (
    id      TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    name    TEXT NOT NULL,
    level   TEXT NOT NULL,
    type    TEXT NOT NULL,
    pattern TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );
`);

/* ── 口令散列:scrypt + 每用户随机盐 ───────── */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  return `s2:${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  try {
    const [, salt, hash] = stored.split(":");
    const test = crypto.scryptSync(pw, salt, 64);
    const expect = Buffer.from(hash, "hex");
    return test.length === expect.length && crypto.timingSafeEqual(test, expect);
  } catch { return false; }
}

/* ── 用户与会话 ───────────────────────────── */
function createUser({ name, company, email, pass, role }) {
  const info = db
    .prepare("INSERT INTO users (name, company, email, pass, created_at, role) VALUES (?, ?, ?, ?, ?, ?)")
    .run(name, company || "", email, hashPassword(pass), Date.now(), role || "analyst");
  return getUserById(Number(info.lastInsertRowid));
}
function getUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email) || null;
}
function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) || null;
}
function publicUser(u) {
  return { name: u.name, company: u.company, email: u.email, createdAt: u.created_at, webhook: u.webhook || "", webhookSecret: u.webhook_secret || "", role: u.role || "analyst" };
}
function setUserRole(userId, role) {
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
  return getUserById(userId);
}
function listUsers() {
  return db.prepare("SELECT id, name, company, email, role, created_at FROM users ORDER BY created_at").all()
    .map((r) => ({ id: r.id, name: r.name, company: r.company, email: r.email, role: r.role, createdAt: r.created_at }));
}
function recordAudit(userId, action, detail, ip) {
  db.prepare("INSERT INTO audit (user_id, ts, action, detail, ip) VALUES (?, ?, ?, ?, ?)")
    .run(userId, Date.now(), action, String(detail || "").slice(0, 200), ip || "-");
}
function getAudit(userId, limit = 50) {
  // 管理员看全组织;普通角色看自己(由调用方决定传入 null)
  const q = userId
    ? "SELECT ts, action, detail, ip FROM audit WHERE user_id = ? ORDER BY id DESC LIMIT ?"
    : "SELECT ts, action, detail, ip, user_id FROM audit ORDER BY id DESC LIMIT ?";
  const rows = userId ? db.prepare(q).all(userId, limit) : db.prepare(q).all(limit);
  if (userId) return rows;
  return rows.map((r) => {
    const u = getUserById(r.user_id);
    return { ...r, who: u ? u.name : "未知" };
  });
}
function updateUserWebhook(userId, url) {
  const u = getUserById(userId);
  let secret = u.webhook_secret || "";
  if (url && !secret) secret = crypto.randomBytes(16).toString("hex");
  if (!url) secret = "";
  db.prepare("UPDATE users SET webhook = ?, webhook_secret = ? WHERE id = ?").run(url, secret, userId);
  return getUserById(userId);
}
function updateProfile(userId, { name, company }) {
  const u = getUserById(userId);
  const v = {
    name: (name ?? u.name).trim().slice(0, 40) || u.name,
    company: (company ?? u.company).trim().slice(0, 60),
  };
  db.prepare("UPDATE users SET name = ?, company = ? WHERE id = ?").run(v.name, v.company, userId);
  return getUserById(userId);
}

const SESSION_TTL = 7 * 24 * 3600 * 1000;
function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(tokenHash, userId, Date.now() + SESSION_TTL);
  return token;
}
function getUserByToken(token) {
  if (!token) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const row = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }
  return getUserById(row.user_id);
}
function deleteSession(token) {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?")
    .run(crypto.createHash("sha256").update(token).digest("hex"));
}
function purgeExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
}

/* ── 种子数据(与前端演示模式内容一致)────── */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const min = (n) => n * 60 * 1000;

function seedUserData(userId) {
  const exists = db.prepare("SELECT 1 FROM alerts WHERE user_id = ? LIMIT 1").get(userId);
  if (exists) return;

  const rnd = mulberry32(20260925);
  const now = Date.now();

  const assets = [
    ["a1", "web-cluster-01", "服务器", "10.12.3.21", "Ubuntu 22.04", 4, 32, "正常"],
    ["a2", "api-gateway-02", "服务器", "10.12.3.22", "Ubuntu 22.04", 3, 41, "告警"],
    ["a3", "db-primary", "数据库", "10.12.5.10", "Debian 12", 1, 18, "正常"],
    ["a4", "k8s-node-07", "容器节点", "10.12.8.7", "Container Linux", 12, 76, "已隔离"],
    ["a5", "k8s-node-12", "容器节点", "10.12.8.12", "Container Linux", 9, 58, "已隔离"],
    ["a6", "hr-wks-114", "工作站", "10.20.1.114", "Windows 11", 2, 64, "告警"],
    ["a7", "fin-wks-207", "工作站", "10.20.1.207", "Windows 11", 2, 22, "正常"],
    ["a8", "vpn-edge-7", "网关", "10.12.9.7", "Linux 6.1", 2, 35, "正常"],
    ["a9", "oss-bucket-logs", "云资源", "-", "对象存储", 1, 12, "正常"],
    ["a10", "cdn-metrics", "云资源", "-", "CDN", 2, 47, "正常"],
  ];
  const insAsset = db.prepare(
    "INSERT INTO assets (id, user_id, name, type, ip, os, exposure, risk, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  assets.forEach((a) => insAsset.run(a[0], userId, a[1], a[2], a[3], a[4], a[5], a[6], a[7]));

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
  const insAlert = db.prepare(
    "INSERT INTO alerts (id, user_id, level, type, src, asset, desc, status, ts, handled_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  alertTpl.forEach((t, i) =>
    insAlert.run("ALT-" + String(10247 + i), userId, t[0], t[1], t[2], t[3], t[4], statuses[i],
      now - min(8 + Math.floor(rnd() * 60 * 47)), "")
  );

  const playbooks = [
    ["PB-01", "IP 自动封禁", "告警等级 ≥ HIGH 且来源为外部 IP", "防火墙下发封禁策略 + 通知值班", 1, 1284, now - min(23)],
    ["PB-02", "失陷主机隔离", "EDR 判定失陷(置信度 > 90%)", "断开网卡 + 内存取证 + 工单", 1, 47, now - min(96)],
    ["PB-03", "勒索行为阻断", "批量文件加密行为特征", "进程冻结 + 文件回滚 + 全员通告", 1, 3, now - min(310)],
    ["PB-04", "弱口令整改", "命中弱口令字典", "强制改密 + MFA 绑定提醒", 1, 89, now - min(1440)],
    ["PB-05", "数据外传拦截", "出站流量 > 1GB 且目标未备案", "限速 10KB/s + 人工研判工单", 0, 0, 0],
    ["PB-06", "证书到期换发", "证书剩余有效期 < 15 天", "ACME 自动续期 + 校验部署", 1, 26, now - min(2880)],
  ];
  const insPb = db.prepare(
    "INSERT INTO playbooks (id, user_id, name, trigger, action, enabled, run_count, last_run) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  playbooks.forEach((p) => insPb.run(p[0], userId, p[1], p[2], p[3], p[4], p[5], p[6]));

  const days = 30;
  let base = 320;
  const insTrend = db.prepare("INSERT INTO trend (user_id, idx, day, alerts, blocked, crit, high, med, low) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (let i = 0; i < days; i++) {
    const d = new Date(now - (days - 1 - i) * 86400000);
    const label = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    base = Math.max(140, Math.round(base + (rnd() - 0.45) * 90));
    const crit = Math.round(base * (0.04 + rnd() * 0.04));
    const high = Math.round(base * (0.16 + rnd() * 0.08));
    const med = Math.round(base * (0.34 + rnd() * 0.1));
    const low = base - crit - high - med;
    insTrend.run(userId, i, label, base, Math.round(base * (0.9 + rnd() * 0.08)), crit, high, med, low);
  }

  const feedSeed = [
    [now - min(3), "ok", "处置剧本「IP 自动封禁」执行成功,封禁 45.83.207.11"],
    [now - min(12), "warn", "资产 k8s-node-12 进入隔离状态"],
    [now - min(26), "crit", "检测到勒索软件行为,剧本「勒索行为阻断」已介入"],
    [now - min(58), "ok", "全网资产扫描完成,1,284 个资产在线"],
  ];
  const insFeed = db.prepare("INSERT INTO feed (user_id, ts, level, msg) VALUES (?, ?, ?, ?)");
  feedSeed.forEach((f) => insFeed.run(userId, f[0], f[1], f[2]));
}

/* ── 数据读取(输出与前端演示模式同形)────── */
function getAlerts(userId) {
  return db.prepare("SELECT * FROM alerts WHERE user_id = ? ORDER BY ts DESC").all(userId)
    .map((r) => ({ id: r.id, level: r.level, type: r.type, src: r.src, asset: r.asset, desc: r.desc, status: r.status, ts: r.ts, handledBy: r.handled_by, note: r.note || "", ruleId: r.rule_id || "", logExcerpt: r.log_excerpt || "" }));
}
function getAlert(userId, id) {
  const r = db.prepare("SELECT * FROM alerts WHERE user_id = ? AND id = ?").get(userId, id);
  return r || null;
}
function alertJson(r) {
  return { id: r.id, level: r.level, type: r.type, src: r.src, asset: r.asset, desc: r.desc, status: r.status, ts: r.ts, handledBy: r.handled_by, note: r.note || "", ruleId: r.rule_id || "", logExcerpt: r.log_excerpt || "" };
}
function alertCount(userId) {
  return db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE user_id = ?").get(userId).c;
}
function insertAlert(userId, a) {
  db.prepare(
    "INSERT INTO alerts (id, user_id, level, type, src, asset, desc, status, ts, handled_by, note, rule_id, log_excerpt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(a.id, userId, a.level, a.type, a.src, a.asset, a.desc, a.status || "待处置", a.ts ?? Date.now(), a.handledBy || "", a.note || "", a.ruleId || "", a.logExcerpt || "");
  return getAlert(userId, a.id);
}

/* ── 模拟告警生成池 ───────────────────────── */
const SIM_POOLS = {
  types: ["端口扫描", "暴力破解", "SQL 注入", "恶意样本", "异常外联", "弱口令", "钓鱼邮件", "可疑登录"],
  levels: ["high", "high", "med", "crit", "med", "high", "low", "med"],
  descs: {
    "端口扫描": "SYN 全端口扫描,已触发限流策略",
    "暴力破解": "检测到分布式口令爆破,速率 800 次/分",
    "SQL 注入": "拦截针对 /api/query 的布尔盲注载荷",
    "恶意样本": "沙箱确认疑似 Cobalt Strike Beacon",
    "异常外联": "工作站在非工作时间向未知地址发起连接",
    "弱口令": "新增账号命中弱口令字典 top100",
    "钓鱼邮件": "用户收件箱检出伪装发票的钓鱼附件",
    "可疑登录": "异地 IP 登录成功,触发新设备提醒",
  },
};
function simulateAlert(userId) {
  const rnd = Math.random;
  const assets = getAssets(userId);
  const type = SIM_POOLS.types[Math.floor(rnd() * SIM_POOLS.types.length)];
  const level = SIM_POOLS.levels[Math.floor(rnd() * SIM_POOLS.levels.length)];
  const asset = assets.length ? assets[Math.floor(rnd() * assets.length)].name : "web-cluster-01";
  const src = rnd() > 0.4 ? `${45 + Math.floor(rnd() * 180)}.${Math.floor(rnd() * 255)}.${Math.floor(rnd() * 255)}.${1 + Math.floor(rnd() * 253)}` : "内生的";
  const id = "ALT-" + String(10247 + alertCount(userId));
  return insertAlert(userId, {
    id, level, type, src, asset,
    desc: SIM_POOLS.descs[type],
    status: "待处置", ts: Date.now(), handledBy: "",
  });
}
function getAssets(userId) {
  return db.prepare("SELECT * FROM assets WHERE user_id = ?").all(userId)
    .map((r) => ({ id: r.id, name: r.name, type: r.type, ip: r.ip, os: r.os, exposure: r.exposure, risk: r.risk, status: r.status }));
}
function getAsset(userId, id) {
  return db.prepare("SELECT * FROM assets WHERE user_id = ? AND id = ?").get(userId, id) || null;
}
function getPlaybooks(userId) {
  return db.prepare("SELECT * FROM playbooks WHERE user_id = ?").all(userId)
    .map((r) => ({ id: r.id, name: r.name, trigger: r.trigger, action: r.action, enabled: !!r.enabled, runCount: r.run_count, lastRun: r.last_run }));
}
function getPlaybook(userId, id) {
  return db.prepare("SELECT * FROM playbooks WHERE user_id = ? AND id = ?").get(userId, id) || null;
}
function getTrend(userId) {
  return db.prepare("SELECT day, alerts, blocked, crit, high, med, low FROM trend WHERE user_id = ? ORDER BY idx").all(userId);
}
function getFeed(userId, limit = 30) {
  return db.prepare("SELECT ts, level, msg FROM feed WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, limit)
    .reverse();
}
function appendFeed(userId, level, msg) {
  const ts = Date.now();
  db.prepare("INSERT INTO feed (user_id, ts, level, msg) VALUES (?, ?, ?, ?)").run(userId, ts, level, msg);
  return { ts, level, msg };
}

/** 迁移:老用户趋势数据补齐到 30 天 */
function migrateTrends() {
  const users = db.prepare("SELECT id FROM users").all();
  const count = db.prepare("SELECT COUNT(*) AS c FROM trend WHERE user_id = ?");
  for (const u of users) {
    const c = count.get(u.id).c;
    const sums = db.prepare("SELECT SUM(crit + high + med + low) AS l FROM trend WHERE user_id = ?").get(u.id);
    if (c < 30 || !sums.l) {
      db.prepare("DELETE FROM trend WHERE user_id = ?").run(u.id);
      seedTrendOnly(u.id);
    }
  }
}
function seedTrendOnly(userId) {
  const rnd = mulberry32(20260925 + userId);
  const now = Date.now();
  const days = 30;
  let base = 320;
  const insTrend = db.prepare("INSERT INTO trend (user_id, idx, day, alerts, blocked, crit, high, med, low) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (let i = 0; i < days; i++) {
    const d = new Date(now - (days - 1 - i) * 86400000);
    const label = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    base = Math.max(140, Math.round(base + (rnd() - 0.45) * 90));
    const crit = Math.round(base * (0.04 + rnd() * 0.04));
    const high = Math.round(base * (0.16 + rnd() * 0.08));
    const med = Math.round(base * (0.34 + rnd() * 0.1));
    const low = base - crit - high - med;
    insTrend.run(userId, i, label, base, Math.round(base * (0.9 + rnd() * 0.08)), crit, high, med, low);
  }
}

/* ── 采集器(Agent)与原始日志 ──────────────── */
function createAgent(userId, name) {
  const token = crypto.randomBytes(24).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const info = db.prepare("INSERT INTO agents (user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(userId, String(name).trim().slice(0, 40) || "采集器", tokenHash, Date.now());
  return { id: Number(info.lastInsertRowid), token };
}
function listAgents(userId) {
  return db.prepare("SELECT id, name, created_at, last_seen FROM agents WHERE user_id = ? ORDER BY id").all(userId)
    .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastSeen: r.last_seen }));
}
function touchAgent(agentId) {
  db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run(Date.now(), agentId);
}
function revokeAgent(userId, id) {
  db.prepare("DELETE FROM agents WHERE user_id = ? AND id = ?").run(userId, id);
}
function getAgentByToken(token) {
  if (!token) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  return db.prepare("SELECT * FROM agents WHERE token_hash = ?").get(tokenHash) || null;
}
function customRuleCount(userId) {
  return db.prepare("SELECT COUNT(*) AS c FROM detection_rules WHERE user_id = ?").get(userId).c;
}
function insertCustomRule(userId, r) {
  const id = "CR-" + String(customRuleCount(userId) + 1).padStart(2, "0") + "-" + Date.now().toString(36).slice(-4);
  db.prepare("INSERT INTO detection_rules (id, user_id, name, level, type, pattern, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, r.name, r.level, r.type, r.pattern, Date.now());
  return getCustomRule(userId, id);
}
function getCustomRule(userId, id) {
  return db.prepare("SELECT * FROM detection_rules WHERE user_id = ? AND id = ?").get(userId, id) || null;
}
function listCustomRules(userId) {
  return db.prepare("SELECT * FROM detection_rules WHERE user_id = ? ORDER BY created_at").all(userId)
    .map((r) => ({ id: r.id, name: r.name, level: r.level, type: r.type, pattern: r.pattern }));
}
function deleteCustomRule(userId, id) {
  db.prepare("DELETE FROM detection_rules WHERE user_id = ? AND id = ?").run(userId, id);
}
function insertLog(userId, agentId, l) {
  const info = db.prepare("INSERT INTO logs (user_id, agent_id, ts, host, program, message) VALUES (?, ?, ?, ?, ?, ?)")
    .run(userId, agentId, l.ts, l.host, l.program, l.message);
  return Number(info.lastInsertRowid);
}
function trimLogs(userId, keep = 20000) {
  db.prepare("DELETE FROM logs WHERE user_id = ? AND id <= (SELECT MAX(id) - ? FROM logs WHERE user_id = ?)").run(userId, keep, userId);
}

/* ── 登录历史 ─────────────────────────────── */
function recordLogin(userId, ip, ua) {
  db.prepare("INSERT INTO logins (user_id, ts, ip, ua) VALUES (?, ?, ?, ?)").run(userId, Date.now(), ip || "-", String(ua || "").slice(0, 180));
}
function getLogins(userId, limit = 5) {
  return db.prepare("SELECT ts, ip, ua FROM logins WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, limit);
}

/* ── 自定义剧本 ───────────────────────────── */
function insertPlaybook(userId, { name, trigger, action }) {
  const customCount = db.prepare("SELECT COUNT(*) AS c FROM playbooks WHERE user_id = ? AND id LIKE 'PB-C%'").get(userId).c;
  const id = "PB-C" + String(customCount + 1).padStart(2, "0");
  db.prepare("INSERT INTO playbooks (id, user_id, name, trigger, action, enabled, run_count, last_run) VALUES (?, ?, ?, ?, ?, 1, 0, 0)")
    .run(id, userId, name, trigger, action);
  return id;
}
function deletePlaybook(userId, id) {
  db.prepare("DELETE FROM playbooks WHERE user_id = ? AND id = ?").run(userId, id);
}

/* ── 备份导入(整表替换)───────────────────── */
function replaceUserData(userId, { alerts, assets, playbooks }) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM alerts WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM assets WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM playbooks WHERE user_id = ?").run(userId);
    const ia = db.prepare("INSERT INTO alerts (id, user_id, level, type, src, asset, desc, status, ts, handled_by, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const a of alerts) ia.run(a.id, userId, a.level, a.type, a.src, a.asset, a.desc, a.status, a.ts, a.handledBy || "", a.note || "");
    const is = db.prepare("INSERT INTO assets (id, user_id, name, type, ip, os, exposure, risk, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const a of assets) is.run(a.id, userId, a.name, a.type, a.ip, a.os, a.exposure, a.risk, a.status);
    const ip = db.prepare("INSERT INTO playbooks (id, user_id, name, trigger, action, enabled, run_count, last_run) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const p of playbooks) ip.run(p.id, userId, p.name, p.trigger, p.action, p.enabled ? 1 : 0, p.runCount || 0, p.lastRun || 0);
    db.exec("COMMIT");
    return true;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

module.exports = {
  db, hashPassword, verifyPassword,
  createUser, getUserByEmail, getUserById, publicUser, updateProfile, updateUserWebhook,
  createSession, getUserByToken, deleteSession, purgeExpiredSessions, migrateTrends,
  seedUserData, getAlerts, getAlert, alertJson, alertCount, insertAlert, simulateAlert, getAssets, getAsset,
  getPlaybooks, getPlaybook, insertPlaybook, deletePlaybook, getTrend, getFeed, appendFeed,
  createAgent, listAgents, touchAgent, revokeAgent, getAgentByToken, insertLog, trimLogs,
  insertCustomRule, listCustomRules, deleteCustomRule, getCustomRule, customRuleCount,
  setUserRole, listUsers, recordAudit, getAudit,
  recordLogin, getLogins, replaceUserData,
};
