/* ═══════════════════════════════════════════════
   NEXUS · API 集成测试(零依赖,Node 内置运行)
   运行:node tests/api.test.js
   覆盖:注册/登录/CSRF/RBAC/Ingest/检测/审计/路径屏蔽
   ═══════════════════════════════════════════════ */

"use strict";

process.env.PORT = "3210";
process.env.NEXUS_DATA_DIR = require("node:fs").mkdtempSync(
  require("node:path").join(require("node:os").tmpdir(), "nexus-test-")
);

const assert = require("node:assert");
require("../server/server.js");

const BASE = "http://localhost:3210";
let passed = 0, failed = 0;
const jars = {}; // name -> cookie string

function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

function cookiesFrom(res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return set.map((c) => c.split(";")[0]).join("; ");
}
function csrfFrom(jar) {
  const m = (jar || "").match(/nexus_csrf=([^;]+)/);
  return m ? m[1] : "";
}
async function call(jar, method, path, body, extraHeaders) {
  const headers = { ...(body ? { "Content-Type": "application/json" } : {}), ...(extraHeaders || {}) };
  const csrf = csrfFrom(jar);
  if (csrf && ["POST", "PUT", "DELETE", "PATCH"].includes(method)) headers["X-CSRF-Token"] = csrf;
  const res = await fetch(BASE + path, {
    method,
    headers: jar ? { cookie: jar, ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, res };
}

(async () => {
  console.log("\n■ NEXUS API 集成测试\n");

  await new Promise((r) => setTimeout(r, 400)); // 等服务监听

  /* 1. 注册:新用户默认 analyst(管理员由预置账号担任或提升) */
  let r = await call(null, "POST", "/api/auth/register", { name: "管理员", email: "admin@t.dev", password: "Passw0rd1" });
  check("注册用户成功(默认 analyst)", r.status === 200 && r.json.user.role === "analyst", JSON.stringify(r.json));
  jars.admin = cookiesFrom(r.res);

  /* 2. 预置管理员(demo)登录;注册第二个用户 → analyst */
  r = await call(null, "POST", "/api/auth/login", { email: "demo@nexus.sec", password: "demo1234" });
  check("预置管理员登录成功", r.status === 200 && r.json.user.role === "admin");
  jars.admin = cookiesFrom(r.res);
  r = await call(null, "POST", "/api/auth/register", { name: "分析师", email: "analyst@t.dev", password: "Passw0rd1" });
  check("注册分析师(默认 analyst)", r.status === 200 && r.json.user.role === "analyst");
  jars.analyst = cookiesFrom(r.res);

  /* 3. 未登录访问受保护资源 */
  r = await call(null, "GET", "/api/bootstrap");
  check("未登录 bootstrap → 401", r.status === 401);

  /* 4. CSRF:剥离 csrf cookie 后的变更请求 → 403 */
  const jarNoCsrf = jars.admin.replace(/nexus_csrf=[^;]+;?/g, "");
  r = await call(jarNoCsrf, "POST", "/api/alerts/simulate");
  check("缺少 CSRF 头 → 403", r.status === 403);

  /* 5. 带 CSRF 头成功 */
  r = await call(jars.admin, "POST", "/api/alerts/simulate");
  check("带 CSRF 头注入告警成功", r.status === 200);

  /* 6. RBAC:analyst 访问审计 → 403 */
  r = await call(jars.analyst, "GET", "/api/audit");
  check("analyst 访问审计 → 403", r.status === 403);

  /* 7. admin 访问审计 → 200 */
  r = await call(jars.admin, "GET", "/api/audit");
  check("admin 访问审计 → 200", r.status === 200 && Array.isArray(r.json.audit), JSON.stringify(r.json).slice(0, 80));

  /* 8. admin 降级 analyst → viewer,然后其批量处置 → 403 */
  r = await call(jars.admin, "PUT", "/api/users/role", { name: "analyst@t.dev", role: "viewer" });
  check("admin 变更角色成功", r.status === 200);
  r = await call(jars.analyst, "POST", "/api/alerts/batch", { action: "ignore", ids: ["ALT-10247"] });
  check("viewer 批量处置 → 403", r.status === 403);
  r = await call(jars.admin, "PUT", "/api/users/role", { name: "analyst@t.dev", role: "analyst" });
  check("恢复 analyst 角色", r.status === 200);

  /* 9. 采集器 + Ingest + 检测(5 次同源 SSH 失败 → 聚合严重告警) */
  r = await call(jars.analyst, "POST", "/api/agents", { name: "测试探针" });
  check("创建采集器(返回一次性 Token)", r.status === 200 && !!r.json.token);
  const token = r.json.token;

  r = await call(null, "POST", "/api/ingest/logs", { logs: [{ message: "test" }] });
  check("无 Token ingest → 401", r.status === 401);

  const srcIp = "203.0.113.66";
  for (let i = 0; i < 5; i++) {
    await call(null, "POST", "/api/ingest/logs", {
      logs: [{ ts: Date.now(), host: "lab-ssh", program: "auth", message: `sshd[9${i}]: Failed password for invalid user root from ${srcIp} port 5100${i} ssh2` }],
    }, { Authorization: "Bearer " + token });
  }
  await new Promise((r2) => setTimeout(r2, 200));
  r = await call(jars.analyst, "GET", "/api/alerts");
  const det = (r.json.alerts || []).filter((a) => a.id.startsWith("DET-"));
  const bf = det.find((a) => a.ruleId === "ssh-bruteforce");
  check("检测引擎产出 DET 告警(≥2 条)", det.length >= 2, `实际 ${det.length}`);
  check("暴力破解聚合规则触发(严重)", !!bf && bf.level === "crit");
  check("告警带原始日志摘录", !!bf && bf.logExcerpt.includes("Failed password"));

  /* 10. 溯源字段 */
  check("告警带命中规则 ID", !!bf && bf.ruleId === "ssh-bruteforce");

  /* 11. 导出与路径屏蔽 */
  r = await call(jars.analyst, "GET", "/api/export/alerts.csv");
  check("CSV 导出 → 200", r.status === 200);
  r = await call(jars.analyst, "GET", "/server/db.js");
  check("服务端源码路径屏蔽 → 404", r.status === 404);

  /* 12. 审计有记录 */
  r = await call(jars.admin, "GET", "/api/audit");
  const hasRoleAudit = (r.json.audit || []).some((a) => a.action === "role.change");
  check("审计包含角色变更记录", hasRoleAudit);

  console.log(`\n■ 结果:${passed} 通过 / ${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("测试执行异常:", e);
  process.exit(1);
});
