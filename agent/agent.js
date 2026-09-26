#!/usr/bin/env node
/* ═══════════════════════════════════════════════
   NEXUS · 采集器 Agent(真实进程)
   用法:
     node agent/agent.js --url http://localhost:3000 --token <TOKEN> --file <日志文件路径>
     node agent/agent.js --url http://localhost:3000 --token <TOKEN> --generator   # 内置压力生成器
   行为:
     - tail 模式:增量读取真实日志文件新增行(每秒轮询文件大小,跨平台)
     - generator 模式:按真实日志格式生成压力流(SSH 暴破 / Web 攻击 / 系统日志)
     - 每 2 秒批量 POST /api/ingest/logs(Authorization: Bearer <token>)
   ═══════════════════════════════════════════════ */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

/* ── 参数解析 ─────────────────────────────── */
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i].replace(/^--/, "");
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args[k] = next; i++; }
  else args[k] = true;
}
const URL_BASE = (args.url || "http://localhost:3000").replace(/\/$/, "");
const TOKEN = args.token || "";
const FILE = args.file || "";
const GENERATOR = !!args.generator;
const INTERVAL = Math.max(500, parseInt(args.interval || "2000", 10));
const HOST = args.host || require("node:os").hostname();

if (!TOKEN) {
  console.error("缺少 --token <采集器Token>(在控制台「设置 → 数据接入」创建)");
  process.exit(1);
}
if (!FILE && !GENERATOR) {
  console.error("请指定 --file <日志文件> 或 --generator(压力生成器)");
  process.exit(1);
}

console.log(`NEXUS Agent 已启动 → ${URL_BASE}`);
console.log(`  主机: ${HOST}`);
console.log(`  模式: ${GENERATOR ? "压力生成器" : "tail " + FILE}`);

/* ── 批量上报 ─────────────────────────────── */
const queue = [];
let sending = false;

function sendBatch() {
  if (sending || !queue.length) return;
  sending = true;
  const batch = queue.splice(0, queue.length);
  const body = JSON.stringify({ logs: batch });
  const u = new URL(URL_BASE + "/api/ingest/logs");
  const req = http.request({
    hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN, "Content-Length": Buffer.byteLength(body) },
  }, (res) => {
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => {
      if (res.statusCode === 200) {
        const d = JSON.parse(b || "{}");
        if (d.alerts && d.alerts.length) console.log(`  ↑ 上报 ${batch.length} 条 · 检出告警 ${d.alerts.length} 条: ${d.alerts.join(", ")}`);
      } else if (res.statusCode === 401) {
        console.error("  ✗ Token 无效或已被吊销,Agent 退出。");
        process.exit(1);
      } else {
        console.error(`  ✗ 上报失败 ${res.statusCode}: ${b.slice(0, 100)}`);
        queue.unshift(...batch); // 失败回队重试
      }
      sending = false;
    });
  });
  req.on("error", (e) => {
    console.error("  ✗ 连接失败:", e.message, "(将重试)");
    queue.unshift(...batch);
    sending = false;
  });
  req.end(body);
}
setInterval(sendBatch, INTERVAL);

function push(program, message, ts) {
  queue.push({ ts: ts || Date.now(), host: HOST, program, message: String(message).slice(0, 480) });
  if (queue.length > 5000) queue.splice(0, queue.length - 5000);
}

/* ── 模式一:tail 真实日志文件 ─────────────── */
function tailFile(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`  ✗ 文件不存在: ${abs}`);
    process.exit(1);
  }
  let pos = 0;
  console.log(`  tail: ${abs}(从当前末尾开始)`);
  pos = fs.statSync(abs).size;

  setInterval(() => {
    let stat;
    try { stat = fs.statSync(abs); } catch { return; }
    if (stat.size < pos) pos = 0; // 文件被轮转
    if (stat.size === pos) return;
    const fd = fs.openSync(abs, "r");
    const buf = Buffer.alloc(stat.size - pos);
    fs.readSync(fd, buf, 0, buf.length, pos);
    fs.closeSync(fd);
    pos = stat.size;
    for (const line of buf.toString("utf8").split(/\r?\n/)) {
      if (line.trim()) push(detectProgram(line), line);
    }
  }, 1000);
}
function detectProgram(line) {
  if (/sshd|sudo/i.test(line)) return "auth";
  if (/nginx|apache|http/i.test(line)) return "httpd";
  if (/DNS|named/i.test(line)) return "dns";
  return "syslog";
}

/* ── 模式二:压力生成器(真实日志格式)────── */
function generator() {
  console.log("  压力生成器已开启(每 1.2 秒产出真实格式的日志行)");
  let tick = 0;
  const ips = () => `${45 + Math.floor(Math.random() * 180)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${1 + Math.floor(Math.random() * 253)}`;
  const scenarios = [
    // 0:SSH 暴力破解(连续失败,聚合规则会升级为严重告警)
    () => push("auth", `sshd[${1000 + tick}]: Failed password for invalid user admin${tick % 3} from ${ips()} port ${20000 + tick} ssh2`),
    () => push("auth", `sshd[${1000 + tick}]: Invalid user root${tick % 5} from ${ips()} port 40000`),
    // 1:Web 攻击(注入/穿越/XSS)
    () => push("httpd", `${ips()} - - "GET /api/orders?id=1' UNION SELECT username,password FROM users-- HTTP/1.1" 400`),
    () => push("httpd", `${ips()} - - "GET /download?file=../../../etc/passwd HTTP/1.1" 404`),
    () => push("httpd", `${ips()} - - "GET /search?q=<script>alert(1)</script> HTTP/1.1" 200`),
    // 2:可疑命令执行
    () => push("httpd", `${ips()} - - "POST /upload.cgi?cmd=whoami HTTP/1.1" 200`),
    // 3:恶意文件
    () => push("syslog", `clamd[220]: FOUND EICAR test signature in file uploads/sample${tick % 7}.exe`),
    // 4:C2 / 隧道
    () => push("syslog", `suricata[331]: C2 beacon callback detected to ${ips()} interval 60s`),
    () => push("dns", `named[88]: possible DNS tunnel base64 label query tunnel${tick}.mal.example`),
    // 5:勒索 / 横向移动
    () => push("syslog", `kernel: ransom note README_FOR_DECRYPT created in /share/docs, files encrypted`),
    () => push("auth", `impacket-psexec admin login denied from ${ips()} target k8s-node-07`),
    // 6:基线噪音(正常日志,构成真实背景)
    () => push("syslog", `systemd[1]: Finished Daily apt upgrade and clean activities.`),
    () => push("auth", `sshd[2200]: Accepted publickey for deploy from 10.12.3.21 port 55222 ssh2`),
    () => push("cron", `CRON[3300]: (root) CMD (/usr/local/bin/backup.sh)`),
  ];
  const normalFirst = [11, 12, 13];
  setInterval(() => {
    tick++;
    // 前 3 拍先跑基线噪音,建立"正常"背景,再混入攻击场景
    if (tick <= 3) { scenarios[normalFirst[tick - 1]](); return; }
    if (Math.random() < 0.35) {
      scenarios[normalFirst[Math.floor(Math.random() * normalFirst.length)]]();
    }
    scenarios[Math.floor(Math.random() * (scenarios.length - 3))]();
  }, 1200);
}

if (GENERATOR) generator();
else tailFile(FILE);

/* ── 优雅退出:冲刷队列 ────────────────────── */
process.on("SIGINT", () => {
  console.log("\nAgent 退出前上报剩余 " + queue.length + " 条…");
  sendBatch();
  setTimeout(() => process.exit(0), 800);
});
