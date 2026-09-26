/* ═══════════════════════════════════════════════
   NEXUS · 检测引擎(Sigma 风格规则子集)
   输入:真实接入的日志行 → 输出:真实告警
   ── 规则集内置于代码(可版本化管理),支持:
      1. 单行正则匹配(逐条规则)
      2. 聚合规则(时间窗内同源计数,如暴力破解)
      3. 冷却机制(同源同规则 10 分钟内不重复告警)
   ═══════════════════════════════════════════════ */

"use strict";

const RULES = [
  { key: "ssh-fail", name: "SSH 登录失败", level: "med", type: "暴力破解", phase: "初始访问",
    re: /sshd.*(?:Failed password|authentication failure|Invalid user)/i },
  { key: "sudo-root", name: "特权提升", level: "high", type: "越权访问", phase: "利用",
    re: /sudo:\s*\S+\s*:.*COMMAND=|su\b.*root|successfu?l\s+sudo/i },
  { key: "sql-injection", name: "SQL 注入尝试", level: "high", type: "SQL 注入", phase: "利用",
    re: /(union[\s+]+select|'\s*or\s*'?1'?\s*=\s*1|;\s*drop\s+table|sleep\(\d+\))/i },
  { key: "path-traversal", name: "路径穿越尝试", level: "high", type: "漏洞利用", phase: "利用",
    re: /(\.\.[\/\\]){2,}|\/etc\/passwd|\/etc\/shadow|win\.ini/i },
  { key: "xss", name: "XSS 注入尝试", level: "med", type: "漏洞利用", phase: "利用",
    re: /(<script[\s>]|javascript:|onerror\s*=)/i },
  { key: "webshell", name: "疑似 WebShell 访问", level: "crit", type: "恶意样本", phase: "利用",
    re: /(cmd=whoami|\bwhoami\b.*\bshell\b|eval\s*\(|system\s*\(|passthru\s*\()/i },
  { key: "eicar", name: "恶意文件检出", level: "crit", type: "恶意样本", phase: "投递与执行",
    re: /EICAR|X5O!P%@AP/i },
  { key: "c2-beacon", name: "疑似 C2 心跳外联", level: "crit", type: "异常外联", phase: "命令与控制",
    re: /(beacon|c2\s+callback|cobalt\s*strike)/i },
  { key: "dns-tunnel", name: "疑似 DNS 隧道", level: "high", type: "DNS 隧道", phase: "命令与控制",
    re: /dns.{0,20}(tunnel|base64|exfiltrat)/i },
  { key: "ransom-note", name: "疑似勒索行为", level: "crit", type: "勒索软件", phase: "影响扩散",
    re: /(ransom|encrypt.*files.*pay|README_FOR_DECRYPT)/i },
  { key: "lateral-smb", name: "疑似横向移动", level: "high", type: "横向移动", phase: "影响扩散",
    re: /(psexec|wmiexec|smb\s+login.*denied.*admin|\bimpacket\b)/i },
  { key: "scan-event", name: "端口扫描事件", level: "med", type: "端口扫描", phase: "侦察",
    event: "port_scan" },
  { key: "new-device", name: "新设备接入", level: "low", type: "可疑登录", phase: "初始访问",
    event: "new_device" },
];

const AGG_RULES = [
  // 聚合规则:窗口内同源计数达标 → 升级为高危/严重告警
  { base: "ssh-fail", key: "ssh-bruteforce", threshold: 5, windowMs: 5 * 60 * 1000,
    name: "暴力破解(聚合)", level: "crit", type: "暴力破解", phase: "初始访问" },
];

const COOLDOWN_MS = 10 * 60 * 1000;

const state = {
  cooldown: new Map(),   // `${userId}|${ruleKey}|${src}` -> lastAlertTs
  agg: new Map(),        // `${userId}|${src}` -> { count, windowStart, samples: [] }
};

function extractIp(text) {
  const m = String(text).match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  return m ? m[0] : "内生的";
}

function seenRecently(userId, ruleKey, src) {
  const key = `${userId}|${ruleKey}|${src}`;
  const last = state.cooldown.get(key) || 0;
  if (Date.now() - last < COOLDOWN_MS) return true;
  state.cooldown.set(key, Date.now());
  // 防泄漏:定期清理(简单策略:超过 5000 条时清一次过期)
  if (state.cooldown.size > 5000) {
    const now = Date.now();
    for (const [k, v] of state.cooldown) if (now - v > COOLDOWN_MS) state.cooldown.delete(k);
  }
  return false;
}

/**
 * 对一批新接入的日志执行检测
 * @returns {Array} 生成的告警对象(未入库,由调用方入库)
 */
function detectLogs(userId, logs) {
  const out = [];
  for (const log of logs) {
    const msg = String(log.message || "");
    const src = extractIp(msg);
    const excerpt = msg.slice(0, 300);

    for (const rule of RULES) {
      // 事件型规则由 Agent 上报的结构化事件触发
      if (rule.event) {
        if (log.program === "agent-event" && msg.toLowerCase().includes(rule.event) && !seenRecently(userId, rule.key, src)) {
          out.push({
            level: rule.level, type: rule.type, src, asset: log.host || "未知主机",
            desc: `[${rule.name}] ${excerpt}`, ruleId: rule.key, logExcerpt: excerpt,
          });
        }
        continue;
      }
      if (!rule.re.test(msg)) continue;
      if (seenRecently(userId, rule.key, src)) continue;
      out.push({
        level: rule.level, type: rule.type, src, asset: log.host || "未知主机",
        desc: `[${rule.name}] ${excerpt}`, ruleId: rule.key, logExcerpt: excerpt,
      });
    }

    // 聚合规则:暴力破解
    for (const agg of AGG_RULES) {
      if (!RULES.find((r) => r.key === agg.base).re.test(msg)) continue;
      const key = `${userId}|${src}`;
      const cur = state.agg.get(key) || { count: 0, windowStart: Date.now(), sample: excerpt };
      if (Date.now() - cur.windowStart > agg.windowMs) { cur.count = 0; cur.windowStart = Date.now(); }
      cur.count++;
      cur.sample = cur.sample || excerpt;
      state.agg.set(key, cur);
      if (cur.count >= agg.threshold && !seenRecently(userId, agg.key, src)) {
        out.push({
          level: agg.level, type: agg.type, src, asset: log.host || "未知主机",
          desc: `[${agg.name}] ${src} 在 5 分钟内触发 ${cur.count} 次登录失败(阈值 ${agg.threshold})`,
          ruleId: agg.key, logExcerpt: cur.sample,
        });
        state.agg.delete(key); // 告警后重置窗口
      }
    }
  }
  return out;
}

function listRules() {
  return RULES.map((r) => ({ key: r.key, name: r.name, level: r.level, type: r.type, phase: r.phase, kind: r.event ? "event" : "regex" }))
    .concat(AGG_RULES.map((a) => ({ key: a.key, name: a.name, level: a.level, type: a.type, phase: a.phase, kind: "aggregate", threshold: a.threshold, windowMs: a.windowMs })));
}

module.exports = { detectLogs, listRules, extractIp };
