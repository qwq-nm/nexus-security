/* ═══════════════════════════════════════════════
   NEXUS · 安全运营控制台(双模式)
   api 模式 → 真实后端:bootstrap 拉取 + REST 处置 + SSE 实时流
   demo 模式 → localStorage(静态托管回退)
   视图:总览 / 告警中心 / 资产管理 / 处置剧本 / 报表
   ═══════════════════════════════════════════════ */

(async () => {
  "use strict";
  const N = window.NEXUS;
  const API = window.NEXUS_API;
  const { mode } = await window.NEXUS_MODE;

  /* ── 状态与用户解析 ────────────────────────── */
  const state = { alerts: [], assets: [], playbooks: [], trend: [], feed: [] };
  let user;

  if (mode === "api") {
    let boot;
    try {
      boot = await API.call("GET", "api/bootstrap");
    } catch {
      location.replace("login.html?next=" + encodeURIComponent("dashboard.html"));
      return;
    }
    user = boot.user;
    Object.assign(state, {
      alerts: boot.alerts, assets: boot.assets,
      playbooks: boot.playbooks, trend: boot.trend, feed: boot.feed,
    });
  } else {
    user = N.requireAuth();
    if (!user) return;
    Object.assign(state, {
      alerts: N.read(N.K.alerts(user.email), []),
      assets: N.read(N.K.assets(user.email), []),
      playbooks: N.read(N.K.playbooks(user.email), []),
      trend: N.read(N.K.trend(user.email), []),
      feed: N.read(N.K.feed(user.email), []),
    });
    // 演示模式:趋势数据不足 30 天时本地补齐
    if (state.trend.length < 30) {
      let base = 320;
      const days = 30;
      const gen = [];
      for (let i = 0; i < days; i++) {
        const d = new Date(Date.now() - (days - 1 - i) * 86400000);
        const label = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        base = Math.max(140, Math.round(base + (Math.random() - 0.45) * 90));
        gen.push({ day: label, alerts: base, blocked: Math.round(base * (0.9 + Math.random() * 0.08)) });
      }
      state.trend = gen;
      save.trend();
    }
  }

  /* ── 持久化(demo 模式写 localStorage;api 模式由服务端负责)─ */
  const save = mode === "demo"
    ? {
        alerts: () => N.write(N.K.alerts(user.email), state.alerts),
        assets: () => N.write(N.K.assets(user.email), state.assets),
        playbooks: () => N.write(N.K.playbooks(user.email), state.playbooks),
        trend: () => N.write(N.K.trend(user.email), state.trend),
        feed: () => N.write(N.K.feed(user.email), state.feed),
      }
    : { alerts() {}, assets() {}, playbooks() {}, trend() {}, feed() {} };

  /* ── 工具 ─────────────────────────────────── */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const pad = (n) => String(n).padStart(2, "0");
  const fmtHM = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fmtFull = (ts) => { const d = new Date(ts); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const LEVEL_NAME = { crit: "严重", high: "高危", med: "中危", low: "低危" };
  const STATUS_TAG = { "待处置": "high", "处理中": "med", "已封禁": "crit", "已隔离": "crit", "已忽略": "idle", "已解决": "ok" };

  function toast(msg, type = "ok") {
    const icons = { ok: "✓", warn: "!", info: "i" };
    const el = document.createElement("div");
    el.className = "toast toast--" + type;
    el.innerHTML = `<span class="toast__icon">${icons[type] || "i"}</span><span></span>`;
    el.lastElementChild.textContent = msg;
    $("#toasts").appendChild(el);
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 350); }, 3200);
  }

  function confirmModal({ title, body, okText = "确认", danger = false }) {
    return new Promise((resolve) => {
      const root = $("#modalRoot");
      root.innerHTML = `
        <div class="modal-mask" role="dialog" aria-modal="true">
          <div class="modal">
            <h3></h3><p></p>
            <div class="modal__actions">
              <button class="btn btn--ghost" data-act="cancel">取消</button>
              <button class="btn btn--primary" data-act="ok"></button>
            </div>
          </div>
        </div>`;
      const mask = root.firstElementChild;
      mask.querySelector("h3").textContent = title;
      mask.querySelector("p").textContent = body;
      const okBtn = mask.querySelector("[data-act='ok']");
      okBtn.textContent = okText;
      if (danger) okBtn.style.background = "linear-gradient(135deg,#dc2626,#f87171)";
      const done = (v) => { root.innerHTML = ""; resolve(v); };
      mask.addEventListener("click", (e) => {
        if (e.target === mask) done(false);
        if (e.target.dataset.act === "ok") done(true);
        if (e.target.dataset.act === "cancel") done(false);
      });
    });
  }

  /* ── 事件流写入(demo 本地 / api 经 SSE + POST 去重)─ */
  const feedSeen = new Set(state.feed.map((f) => f.ts + "|" + f.msg));
  function pushFeedEntry(f) {
    const key = f.ts + "|" + f.msg;
    if (feedSeen.has(key)) return;
    feedSeen.add(key);
    state.feed.unshift(f);
    state.feed = state.feed.slice(0, 30);
    if (mode === "demo") save.feed();
    if (currentView === "overview") renderFeed();
    updateBell();
    radarSpawn(f);
    notifyDesktop(f);
  }
  function pushFeed(level, msg) {           // demo 模式本地写入
    if (mode === "api") return;
    pushFeedEntry({ ts: Date.now(), level, msg });
  }
  async function apiCall(method, url, body) {
    try { return await API.call(method, url, body); }
    catch (e) { toast(e.message, "warn"); return null; }
  }

  /* ── 顶栏用户 ─────────────────────────────── */
  $("#userName").textContent = user.name;
  $("#userCompany").textContent = user.company || "个人空间";
  $("#userAvatar").textContent = user.name.trim().charAt(0).toUpperCase() || "N";

  /* ── 视图切换 ─────────────────────────────── */
  const VIEW_META = {
    overview: ["总览", "你的网络此刻正处于监控之下"],
    alerts: ["告警中心", "全部安全事件与处置状态"],
    assets: ["资产管理", "主机、容器与云资产的暴露面与风险"],
    playbooks: ["处置剧本", "自动化响应规则:触发条件与执行动作"],
    reports: ["报表中心", "合规达标率、风险排行与周报归档"],
    settings: ["账号设置", "管理你的账户与安全凭据"],
  };
  let currentView = "overview";

  function switchView(name) {
    currentView = name;
    $$(".sidebar__item[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
    $("#viewTitle").textContent = VIEW_META[name][0];
    $("#viewSub").textContent = VIEW_META[name][1];
    $("#sidebar").classList.remove("open");
    if (name === "overview") { renderKpis(); drawCharts(); }
    if (name === "alerts") renderAlerts();
    if (name === "assets") renderAssets();
    if (name === "playbooks") renderPlaybooks();
    if (name === "reports") renderReports();
    if (name === "settings") renderSettings();
    window.scrollTo(0, 0);
  }
  $$(".sidebar__item[data-view]").forEach((b) =>
    b.addEventListener("click", () => switchView(b.dataset.view))
  );
  $("#burger").addEventListener("click", () => $("#sidebar").classList.toggle("open"));

  /* ── 总览:KPI ────────────────────────────── */
  function renderKpis() {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayAlerts = state.alerts.filter((a) => a.ts >= todayStart.getTime()).length;
    const pending = state.alerts.filter((a) => a.status === "待处置" || a.status === "处理中");
    const critPending = pending.filter((a) => a.level === "crit").length;
    const blocked = state.alerts.filter((a) => ["已封禁", "已解决"].includes(a.status)).length;

    $("#kpiAlerts").textContent = todayAlerts || state.alerts.length;
    $("#kpiBlocked").textContent = blocked;
    $("#kpiPending").textContent = pending.length;
    $("#kpiAssets").textContent = state.assets.length;
    $("#kpiPendingDelta").textContent = critPending ? `含 ${critPending} 条严重告警` : "暂无严重告警";
    $("#kpiPendingDelta").className = "kpi__delta " + (critPending ? "up" : "down");
    $("#navAlertBadge").textContent = pending.length;
    $("#navAlertBadge").style.display = pending.length ? "" : "none";
  }

  /* ── 总览:事件流 ─────────────────────────── */
  function renderFeed() {
    const box = $("#feed");
    box.innerHTML = "";
    for (const it of state.feed) {
      const row = document.createElement("div");
      row.className = "feed__row";
      const dot = { ok: "ok", warn: "warn", crit: "crit" }[it.level] || "warn";
      row.innerHTML = `<span class="feed__time"></span><span class="feed__dot feed__dot--${dot}"></span><span class="feed__msg"></span>`;
      row.children[0].textContent = fmtHM(it.ts);
      row.children[2].textContent = it.msg;
      box.appendChild(row);
    }
  }

  /* ── 事件源:api 模式 SSE / demo 模式本地模拟 ── */
  if (mode === "api") {
    try {
      const es = new EventSource("api/stream");
      es.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (d.presence) { refreshPresence(); return; }
          pushFeedEntry(d);
        } catch {}
      };
    } catch { /* SSE 不可用时仅依赖 POST 响应 */ }
  } else {
    const AMBIENT_EVENTS = [
      ["ok", "威胁情报库已同步,新增 IOC 1,024 条"],
      ["warn", "资产 fin-wks-207 出站流量小幅升高,持续观察"],
      ["ok", "探针心跳正常 · 1,284 个资产在线"],
      ["warn", "检测到 3 次失败的 SSH 登录,已记录"],
      ["ok", "日志管道延迟 0.8s,运行正常"],
      ["crit", "情报命中:外部 IP 命中勒索软件 C2 名单,已自动封禁"],
      ["ok", "合规基线快照完成,达标率 92.4%"],
    ];
    let ambIdx = 0;
    setInterval(() => {
      const [level, msg] = AMBIENT_EVENTS[ambIdx++ % AMBIENT_EVENTS.length];
      pushFeedEntry({ ts: Date.now(), level, msg });
    }, 9000);
  }

  /* ── 图表 ─────────────────────────────────── */
  function setupCanvas(cv) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth || 600;
    const h = cv.clientHeight || 240;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  /* 趋势范围(7/14/30 日) */
  let trendRange = 7;
  const trendView = () => state.trend.slice(-trendRange);
  $("#trendRange").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-days]");
    if (!btn) return;
    trendRange = parseInt(btn.dataset.days, 10);
    $$("#trendRange .mini-btn").forEach((b) => b.classList.toggle("active", b === btn));
    $("#typeRangeHint").textContent = `近 ${trendRange} 日`;
    drawCharts();
  });

  function drawTrend() {
    const { ctx, w, h } = setupCanvas($("#trendChart"));
    const data = trendView();
    if (!data.length) return;
    const padL = 34, padR = 12, padT = 14, padB = 26;
    const iw = w - padL - padR, ih = h - padT - padB;
    const maxV = Math.max(...data.map((d) => Math.max(d.alerts, d.blocked))) * 1.15;
    const X = (i) => padL + (iw * i) / Math.max(data.length - 1, 1);
    const Y = (v) => padT + ih - (v / maxV) * ih;

    ctx.strokeStyle = "rgba(148,163,184,0.12)";
    ctx.fillStyle = "rgba(148,163,184,0.55)";
    ctx.font = "10.5px " + getComputedStyle(document.body).fontFamily;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = (maxV / 4) * i, y = Y(v);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillText(Math.round(v), 6, y + 3.5);
    }
    const step = Math.ceil(data.length / 8);
    data.forEach((d, i) => {
      if (i % step !== 0 && i !== data.length - 1) return;
      const x = Math.min(X(i), w - 34); // 防止最后一个标签溢出
      ctx.fillText(d.day, x - 11, h - 8);
    });

    const area = ctx.createLinearGradient(0, padT, 0, padT + ih);
    area.addColorStop(0, "rgba(56, 225, 255, 0.30)");
    area.addColorStop(1, "rgba(56, 225, 255, 0)");
    ctx.beginPath();
    data.forEach((d, i) => (i ? ctx.lineTo(X(i), Y(d.alerts)) : ctx.moveTo(X(i), Y(d.alerts))));
    ctx.lineTo(X(data.length - 1), padT + ih); ctx.lineTo(X(0), padT + ih); ctx.closePath();
    ctx.fillStyle = area; ctx.fill();

    ctx.beginPath();
    data.forEach((d, i) => (i ? ctx.lineTo(X(i), Y(d.alerts)) : ctx.moveTo(X(i), Y(d.alerts))));
    ctx.strokeStyle = "#38e1ff"; ctx.lineWidth = 2; ctx.stroke();

    ctx.beginPath();
    data.forEach((d, i) => (i ? ctx.lineTo(X(i), Y(d.blocked)) : ctx.moveTo(X(i), Y(d.blocked))));
    ctx.strokeStyle = "#7dd3fc"; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.stroke();
    ctx.setLineDash([]);

    data.forEach((d, i) => {
      ctx.fillStyle = "#a5f3fc";
      ctx.beginPath(); ctx.arc(X(i), Y(d.alerts), 3, 0, Math.PI * 2); ctx.fill();
    });
  }

  const TYPE_COLORS = ["#38e1ff", "#8b5cf6", "#f59e0b", "#f87171", "#4ade80", "#22d3ee", "#64748b"];
  function drawType() {
    const counts = {};
    for (const a of state.alerts) counts[a.type] = (counts[a.type] || 0) + 1;
    let entries = Object.entries(counts).sort((x, y) => y[1] - x[1]);
    if (entries.length > 6) {
      const rest = entries.slice(6).reduce((s, e) => s + e[1], 0);
      entries = entries.slice(0, 6).concat([["其他", rest]]);
    }
    const total = entries.reduce((s, e) => s + e[1], 0) || 1;

    const { ctx, w, h } = setupCanvas($("#typeChart"));
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 14, rIn = r * 0.62;
    let ang = -Math.PI / 2;
    for (let i = 0; i < entries.length; i++) {
      const slice = (entries[i][1] / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, ang, ang + slice);
      ctx.arc(cx, cy, rIn, ang + slice, ang, true);
      ctx.closePath();
      ctx.fillStyle = TYPE_COLORS[i % TYPE_COLORS.length];
      ctx.fill();
      ang += slice;
    }
    ctx.fillStyle = "#eef1f7";
    ctx.font = "700 22px " + getComputedStyle(document.body).fontFamily;
    ctx.textAlign = "center";
    ctx.fillText(String(total), cx, cy - 2);
    ctx.font = "11px " + getComputedStyle(document.body).fontFamily;
    ctx.fillStyle = "rgba(153,162,178,0.7)";
    ctx.fillText("安全事件", cx, cy + 16);
    ctx.textAlign = "left";

    const legend = $("#typeLegend");
    legend.innerHTML = "";
    entries.forEach(([name, val], i) => {
      const row = document.createElement("div");
      row.className = "legend__row";
      row.innerHTML = `<span class="legend__dot"></span><span></span><span class="legend__val"></span>`;
      row.children[0].style.background = TYPE_COLORS[i % TYPE_COLORS.length];
      row.children[1].textContent = name;
      row.children[2].textContent = val;
      legend.appendChild(row);
    });
  }

  function drawCharts() { drawTrend(); drawType(); }

  /* ── 攻击雷达 ─────────────────────────────── */
  const radarBlips = [];
  function radarSpawn(f) {
    if (!["crit", "high", "med"].includes(f.level)) return;
    radarBlips.push({
      ang: Math.random() * Math.PI * 2,
      rad: 0.25 + Math.random() * 0.7,
      born: performance.now(),
      level: f.level,
    });
    if (radarBlips.length > 24) radarBlips.shift();
  }
  function drawRadar(t) {
    const cv = $("#radarChart");
    if (!cv) return;
    const { ctx, w, h } = setupCanvas(cv);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 10;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const sweep = reduced ? -Math.PI / 2 : (t / 1400) % (Math.PI * 2);

    ctx.clearRect(0, 0, w, h);
    // 网格环 + 十字线
    ctx.strokeStyle = "rgba(56, 225, 255, 0.16)";
    ctx.lineWidth = 1;
    for (const rr of [0.33, 0.66, 1]) {
      ctx.beginPath(); ctx.arc(cx, cy, R * rr, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.strokeStyle = "rgba(56, 225, 255, 0.1)";
    ctx.stroke();

    // 扫描扇形
    if (!reduced) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, sweep - 0.7, sweep);
      ctx.closePath();
      const sg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      sg.addColorStop(0, "rgba(56, 225, 255, 0.02)");
      sg.addColorStop(1, "rgba(56, 225, 255, 0.22)");
      ctx.fillStyle = sg;
      ctx.fill();
      ctx.restore();
      // 扫描前沿
      ctx.strokeStyle = "rgba(140, 240, 255, 0.8)";
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(sweep) * R, cy + Math.sin(sweep) * R);
      ctx.stroke();
    }

    // 中心点
    ctx.fillStyle = "#38e1ff";
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();

    // 威胁光点(随时间衰减)
    const nowT = performance.now();
    const COLORS = { crit: "#f87171", high: "#fbbf24", med: "#38e1ff" };
    for (let i = radarBlips.length - 1; i >= 0; i--) {
      const b = radarBlips[i];
      const age = (nowT - b.born) / 1000;
      if (age > 10) { radarBlips.splice(i, 1); continue; }
      const a = Math.max(0, 1 - age / 10) * 0.9;
      const x = cx + Math.cos(b.ang) * R * b.rad;
      const y = cy + Math.sin(b.ang) * R * b.rad;
      ctx.fillStyle = COLORS[b.level] || "#38e1ff";
      ctx.globalAlpha = a;
      ctx.beginPath(); ctx.arc(x, y, b.level === "crit" ? 4 : 3, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = a * 0.25;
      ctx.beginPath(); ctx.arc(x, y, (b.level === "crit" ? 4 : 3) + 4, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  // 常驻循环:仅在总览视图时绘制,其余时间跳过(不断链)
  requestAnimationFrame(function radarLoop(t) {
    if (currentView === "overview") drawRadar(t);
    requestAnimationFrame(radarLoop);
  });

  let rsTimer;
  window.addEventListener("resize", () => {
    clearTimeout(rsTimer);
    rsTimer = setTimeout(() => { if (currentView === "overview") drawCharts(); }, 200);
  });

  /* ── 告警中心 ─────────────────────────────── */
  function alertActions(a) {
    const map = {
      "待处置": [["封禁", "ban", ""], ["隔离", "isolate", "danger"], ["忽略", "ignore", ""]],
      "处理中": [["标记解决", "resolve", "ok"], ["忽略", "ignore", ""]],
      "已封禁": [["解除封禁", "unban", "ok"]],
      "已隔离": [["解除隔离", "release", "ok"]],
      "已忽略": [["重新处理", "reopen", ""]],
      "已解决": [],
    };
    return map[a.status] || [];
  }

  async function handleAlertAction(act, id) {
    const a = state.alerts.find((x) => x.id === id);
    if (!a) return;
    const asset = state.assets.find((x) => x.name === a.asset);

    if (act === "isolate") {
      const ok = await confirmModal({
        title: "隔离主机",
        body: `将立即切断 ${a.asset} 的网络连接并保留内存取证快照,确认执行?`,
        okText: "立即隔离", danger: true,
      });
      if (!ok) return;
    }

    // api 模式:先交服务端执行(权威),成功后同步本地实体
    if (mode === "api") {
      const res = await apiCall("POST", `api/alerts/${id}/action`, { action: act });
      if (!res) return;
      Object.assign(a, res.alert);
      if (act === "isolate" && asset) asset.status = "已隔离";
      if (act === "release" && asset && asset.status === "已隔离") asset.status = "告警";
      if (res.feed) pushFeedEntry(res.feed);
      save.alerts(); save.assets();
      renderAlerts(); renderKpis();
      toast(TOAST_TEXT[act](a), act === "isolate" ? "warn" : act === "ignore" || act === "release" || act === "reopen" ? "info" : "ok");
      return;
    }

    // demo 模式:本地变更
    switch (act) {
      case "ban":
        a.status = "已封禁"; a.handledBy = user.name;
        pushFeed("ok", `告警 ${a.id} 来源 IP 已封禁(${a.src})`);
        toast(`已封禁来源 ${a.src}`);
        break;
      case "isolate":
        a.status = "已隔离"; a.handledBy = user.name;
        if (asset) asset.status = "已隔离";
        pushFeed("crit", `告警 ${a.id} 触发主机隔离:${a.asset}`);
        toast(`${a.asset} 已隔离,内存快照已保留`, "warn");
        break;
      case "ignore":
        a.status = "已忽略";
        pushFeed("warn", `告警 ${a.id} 被标记为忽略(${a.type})`);
        toast(`告警 ${a.id} 已忽略`, "info");
        break;
      case "resolve":
        a.status = "已解决"; a.handledBy = user.name;
        pushFeed("ok", `告警 ${a.id} 已由 ${user.name} 处理完毕`);
        toast(`告警 ${a.id} 已解决`);
        break;
      case "unban":
        a.status = "已解决";
        pushFeed("ok", `封禁策略已解除:${a.src}`);
        toast(`已解除对 ${a.src} 的封禁`, "info");
        break;
      case "release":
        a.status = "处理中";
        if (asset && asset.status === "已隔离") asset.status = "告警";
        pushFeed("warn", `主机 ${a.asset} 解除隔离,进入持续观察`);
        toast(`${a.asset} 已恢复联网,状态转为处理中`, "info");
        break;
      case "reopen":
        a.status = "待处置";
        toast(`告警 ${a.id} 重新进入待处置队列`, "info");
        break;
    }
    save.alerts(); save.assets();
    renderAlerts(); renderKpis();
  }
  const TOAST_TEXT = {
    ban: (a) => `已封禁来源 ${a.src}`,
    isolate: (a) => `${a.asset} 已隔离,内存快照已保留`,
    ignore: (a) => `告警 ${a.id} 已忽略`,
    resolve: (a) => `告警 ${a.id} 已解决`,
    unban: (a) => `已解除对 ${a.src} 的封禁`,
    release: (a) => `${a.asset} 已恢复联网,状态转为处理中`,
    reopen: (a) => `告警 ${a.id} 重新进入待处置队列`,
  };

  function renderAlerts() {
    const kw = ($("#alertSearch").value || "").trim().toLowerCase();
    const lv = $("#alertLevel").value;
    const st = $("#alertStatus").value;
    const list = state.alerts.filter((a) => {
      if (lv && a.level !== lv) return false;
      if (st && a.status !== st) return false;
      if (kw && ![a.id, a.src, a.asset, a.type, a.desc].join(" ").toLowerCase().includes(kw)) return false;
      return true;
    }).sort((x, y) => y.ts - x.ts);

    const tbody = $("#alertRows");
    tbody.innerHTML = "";
    for (const a of list) {
      const tr = document.createElement("tr");
      const ops = alertActions(a)
        .map(([label, act, cls]) => `<button class="mini-btn mini-btn--${cls || "default"}" data-act="${act}" data-id="${a.id}">${label}</button>`)
        .join("");
      tr.innerHTML = `
        <td class="td-mono">${a.id}</td>
        <td><span class="tag tag--${a.level}">${LEVEL_NAME[a.level]}</span></td>
        <td class="td-main"></td>
        <td class="td-mono"></td>
        <td class="td-dim"></td>
        <td><span class="tag tag--${STATUS_TAG[a.status] || "idle"}">${a.status}</span></td>
        <td class="td-mono">${fmtFull(a.ts)}</td>
        <td><div class="row-actions">${ops || '<span class="td-dim">—</span>'}</div></td>`;
      tr.dataset.id = a.id;
      tr.style.cursor = "pointer";
      tr.children[2].textContent = a.type;
      tr.children[3].textContent = a.src;
      tr.children[4].textContent = a.asset;
      tbody.appendChild(tr);
    }
    $("#alertEmpty").hidden = list.length > 0;
  }
  $("#alertRows").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (btn) { handleAlertAction(btn.dataset.act, btn.dataset.id); return; }
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    const a = state.alerts.find((x) => x.id === tr.dataset.id);
    if (a) openAlertDrawer(a);
  });
  const debouncedAlerts = debounce(renderAlerts, 150);
  $("#alertSearch").addEventListener("input", debouncedAlerts);
  ["alertLevel", "alertStatus"].forEach((id) => $("#" + id).addEventListener("change", renderAlerts));

  /* ── 资产管理 ─────────────────────────────── */
  function riskColor(v) { return v >= 60 ? "risk--high" : v >= 35 ? "risk--mid" : "risk--low"; }
  const ASSET_TAG = { "正常": "ok", "告警": "high", "已隔离": "crit" };

  async function handleAssetAction(act, id) {
    const a = state.assets.find((x) => x.id === id);
    if (!a) return;

    if (act === "isolate") {
      const ok = await confirmModal({
        title: "隔离资产",
        body: `将切断 ${a.name}(${a.ip})的全部网络连接,相关业务会受影响,确认执行?`,
        okText: "立即隔离", danger: true,
      });
      if (!ok) return;
    }

    if (mode === "api") {
      const res = await apiCall("POST", `api/assets/${id}/action`, { action: act });
      if (!res) return;
      Object.assign(a, res.asset);
      if (res.feed) pushFeedEntry(res.feed);
      save.assets();
      renderAssets(); renderKpis();
      toast(act === "isolate" ? `${a.name} 已隔离` : act === "release" ? `${a.name} 已恢复上线` : `${a.name} 扫描完成,风险评分 ${a.risk}`,
        act === "isolate" ? "warn" : act === "rescan" ? "info" : "ok");
      return;
    }

    if (act === "isolate") {
      a.status = "已隔离";
      state.alerts.forEach((al) => { if (al.asset === a.name && al.status === "处理中") al.status = "已隔离"; });
      pushFeed("crit", `资产 ${a.name} 已被 ${user.name} 手动隔离`);
      toast(`${a.name} 已隔离`, "warn");
    } else if (act === "release") {
      a.status = "正常";
      pushFeed("ok", `资产 ${a.name} 解除隔离,恢复上线`);
      toast(`${a.name} 已恢复上线`);
    } else if (act === "rescan") {
      a.risk = Math.max(5, Math.min(95, a.risk + Math.round((Math.random() - 0.6) * 14)));
      pushFeed("ok", `资产 ${a.name} 完成一轮安全扫描`);
      toast(`${a.name} 扫描完成,风险评分 ${a.risk}`, "info");
    }
    save.assets(); save.alerts();
    renderAssets(); renderKpis();
  }

  function renderAssets() {
    const kw = ($("#assetSearch").value || "").trim().toLowerCase();
    const st = $("#assetStatus").value;
    const list = state.assets.filter((a) => {
      if (st && a.status !== st) return false;
      if (kw && ![a.name, a.ip, a.type, a.os].join(" ").toLowerCase().includes(kw)) return false;
      return true;
    });
    const tbody = $("#assetRows");
    tbody.innerHTML = "";
    for (const a of list) {
      const tr = document.createElement("tr");
      const ops = a.status === "已隔离"
        ? `<button class="mini-btn mini-btn--ok" data-act="release" data-id="${a.id}">恢复上线</button>`
        : `<button class="mini-btn mini-btn--danger" data-act="isolate" data-id="${a.id}">隔离</button>
           <button class="mini-btn" data-act="rescan" data-id="${a.id}">扫描</button>`;
      tr.innerHTML = `
        <td class="td-main"></td>
        <td class="td-dim"></td>
        <td class="td-mono"></td>
        <td class="td-dim"></td>
        <td class="td-mono">${a.exposure}</td>
        <td>
          <div style="display:flex;align-items:center;gap:10px">
            <div class="riskbar"><i class="${riskColor(a.risk)}" style="width:${a.risk}%"></i></div>
            <span class="td-mono">${a.risk}</span>
          </div>
        </td>
        <td><span class="tag tag--${ASSET_TAG[a.status] || "idle"}">${a.status}</span></td>
        <td><div class="row-actions">${ops}</div></td>`;
      tr.children[0].textContent = a.name;
      tr.children[1].textContent = a.type;
      tr.children[2].textContent = a.ip;
      tr.children[3].textContent = a.os;
      tr.dataset.id = a.id;
      tr.style.cursor = "pointer";
      tbody.appendChild(tr);
    }
    $("#assetEmpty").hidden = list.length > 0;
  }
  $("#assetRows").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (btn) { handleAssetAction(btn.dataset.act, btn.dataset.id); return; }
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    const a = state.assets.find((x) => x.id === tr.dataset.id);
    if (a) openAssetDrawer(a);
  });
  $("#assetSearch").addEventListener("input", debounce(renderAssets, 150));
  $("#assetStatus").addEventListener("change", renderAssets);

  /* ── 处置剧本 ─────────────────────────────── */
  function renderPlaybooks() {
    const grid = $("#pbGrid");
    grid.innerHTML = "";
    for (const p of state.playbooks) {
      const el = document.createElement("div");
      el.className = "card pb";
      el.innerHTML = `
        <div class="pb__top">
          <p class="pb__name"></p>
          <label class="switch" title="启用/停用">
            <input type="checkbox" data-act="toggle" data-id="${p.id}" ${p.enabled ? "checked" : ""}/>
            <i></i>
          </label>
        </div>
        <p class="pb__line"><b>触发:</b><span class="pb__trigger"></span></p>
        <p class="pb__line"><b>动作:</b><span class="pb__action"></span></p>
        <p class="pb__meta"></p>
        <div class="pb__foot">
          <button class="mini-btn" data-act="run" data-id="${p.id}">▶ 立即执行</button>
          <span class="td-dim" style="font-size:12px">累计执行 ${p.runCount} 次</span>
        </div>`;
      el.querySelector(".pb__name").textContent = p.name;
      el.querySelector(".pb__trigger").textContent = p.trigger;
      el.querySelector(".pb__action").textContent = p.action;
      el.querySelector(".pb__meta").textContent = p.lastRun
        ? `上次运行:${fmtFull(p.lastRun)}`
        : "尚未运行过 · 启用后由事件自动触发";
      grid.appendChild(el);
    }
  }

  $("#pbGrid").addEventListener("change", async (e) => {
    const input = e.target.closest("input[data-act='toggle']");
    if (!input) return;
    const p = state.playbooks.find((x) => x.id === input.dataset.id);
    if (!p) return;
    const enabled = input.checked;

    if (mode === "api") {
      const res = await apiCall("POST", `api/playbooks/${p.id}/toggle`, { enabled });
      if (!res) { input.checked = !enabled; return; }
      Object.assign(p, res.playbook);
      if (res.feed) pushFeedEntry(res.feed);
      toast(`剧本「${p.name}」已${p.enabled ? "启用" : "停用"}`, p.enabled ? "ok" : "info");
      return;
    }
    p.enabled = enabled;
    save.playbooks();
    pushFeed(p.enabled ? "ok" : "warn", `剧本「${p.name}」已${p.enabled ? "启用" : "停用"}`);
    toast(`剧本「${p.name}」已${p.enabled ? "启用" : "停用"}`, p.enabled ? "ok" : "info");
  });

  $("#pbGrid").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act='run']");
    if (!btn) return;
    const p = state.playbooks.find((x) => x.id === btn.dataset.id);
    if (!p) return;
    if (!p.enabled) return toast("剧本已停用,请先开启开关再执行", "warn");

    if (mode === "api") {
      const res = await apiCall("POST", `api/playbooks/${p.id}/run`);
      if (!res) return;
      Object.assign(p, res.playbook);
      if (res.handled) {
        const al = state.alerts.find((x) => x.id === res.handled);
        if (al) { al.status = p.name.includes("封禁") ? "已封禁" : "已解决"; al.handledBy = "剧本:" + p.name; }
      }
      if (res.feed) pushFeedEntry(res.feed);
      save.alerts(); save.playbooks();
      renderPlaybooks(); renderKpis();
      toast(res.handled ? `剧本执行完成:已处置告警 ${res.handled}` : "当前没有待处置告警,剧本完成一次空跑演练",
        res.handled ? "ok" : "info");
      return;
    }

    const target = state.alerts.find((a) => a.status === "待处置");
    p.runCount++; p.lastRun = Date.now();
    save.playbooks();
    if (target) {
      target.status = p.name.includes("封禁") ? "已封禁" : "已解决";
      target.handledBy = "剧本:" + p.name;
      save.alerts();
      pushFeed("ok", `剧本「${p.name}」已自动处置告警 ${target.id}(${target.type})`);
      toast(`剧本执行完成:已处置告警 ${target.id}`);
    } else {
      pushFeed("ok", `剧本「${p.name}」空跑演练完成,无待处置告警`);
      toast("当前没有待处置告警,剧本完成一次空跑演练", "info");
    }
    renderPlaybooks(); renderKpis();
  });

  /* ── 报表中心 ─────────────────────────────── */
  function renderReports() {
    const comp = [
      ["等保 2.0(三级)", 92], ["ISO 27001", 88], ["SOC 2 Type II", 95], ["GDPR", 81],
    ];
    const box = $("#compliance");
    box.innerHTML = "";
    for (const [name, val] of comp) {
      const row = document.createElement("div");
      row.className = "comp__row";
      row.innerHTML = `<div class="comp__head"><span></span><b>${val}%</b></div>
        <div class="comp__bar"><i style="width:${val}%"></i></div>`;
      row.querySelector("span").textContent = name;
      box.appendChild(row);
    }

    const top = [...state.assets].sort((a, b) => b.risk - a.risk).slice(0, 5);
    const riskBox = $("#riskTop");
    riskBox.innerHTML = "";
    for (const a of top) {
      const row = document.createElement("div");
      row.className = "comp__row";
      row.innerHTML = `<div class="comp__head"><span></span><b class="${a.risk >= 60 ? "tag tag--crit" : a.risk >= 35 ? "tag tag--high" : "tag tag--ok"}">${a.risk}</b></div>
        <div class="comp__bar"><i class="${riskColor(a.risk)}" style="width:${a.risk}%"></i></div>`;
      row.querySelector("span").textContent = `${a.name} · ${a.type}`;
      riskBox.appendChild(row);
    }

    // 攻击来源 Top 5(聚合外部来源)
    const srcCounts = {};
    for (const al of state.alerts) {
      if (!al.src || al.src === "内生的" || al.src === "-") continue;
      srcCounts[al.src] = (srcCounts[al.src] || 0) + 1;
    }
    const srcTop = Object.entries(srcCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const srcBox = $("#topSources");
    srcBox.innerHTML = "";
    if (!srcTop.length) { srcBox.innerHTML = '<p class="blocklist__empty">暂无外部来源告警</p>'; }
    const maxSrc = srcTop.length ? srcTop[0][1] : 1;
    for (const [ip, cnt] of srcTop) {
      const row = document.createElement("div");
      row.className = "src-row";
      row.innerHTML = `<span class="td-mono"></span><div class="src-bar"><i style="width:${Math.round((cnt / maxSrc) * 100)}%"></i></div><b>${cnt}</b>`;
      row.querySelector(".td-mono").textContent = ip;
      srcBox.appendChild(row);
    }

    // IP 封禁名单(按来源聚合,一键解封)
    const banned = state.alerts.filter((a) => a.status === "已封禁");
    const bySrc = {};
    for (const a of banned) {
      (bySrc[a.src] = bySrc[a.src] || []).push(a);
    }
    const blBox = $("#blocklist");
    blBox.innerHTML = "";
    if (!banned.length) { blBox.innerHTML = '<p class="blocklist__empty">当前没有生效的封禁策略</p>'; }
    for (const [src, list] of Object.entries(bySrc)) {
      const row = document.createElement("div");
      row.className = "blocklist__row";
      row.innerHTML = `<span class="td-mono"></span><span class="dim">${list.length} 条相关告警</span>
        <button class="mini-btn mini-btn--ok" data-src="${src}">全部解封</button>`;
      row.querySelector(".td-mono").textContent = src;
      blBox.appendChild(row);
    }

    const reports = [
      ["第 39 周安全周报", "2026-09-21"], ["等保 2.0 三级自查报告", "2026-09-18"],
      ["9 月上半月威胁情报摘要", "2026-09-15"], ["Q3 渗透测试整改跟踪", "2026-09-08"],
    ];
    const list = $("#reportList");
    list.innerHTML = "";
    for (const [name, date] of reports) {
      const a = document.createElement("a");
      a.href = "#";
      a.innerHTML = `<span></span><small>${date}</small>`;
      a.children[0].textContent = name;
      a.addEventListener("click", (e) => { e.preventDefault(); toast(`「${name}」为演示数据,暂不提供下载`, "info"); });
      list.appendChild(a);
    }
  }

  /* ── 通知铃铛 ─────────────────────────────── */
  const SEEN_KEY = "nexus_seen_" + (user.email || "demo");
  let seenTs = N.read(SEEN_KEY, 0);

  function updateBell() {
    const unread = state.feed.filter((f) => f.ts > seenTs).length;
    const badge = $("#bellBadge");
    badge.textContent = unread > 99 ? "99+" : String(unread);
    badge.hidden = unread === 0;
  }
  function renderNotifList() {
    const list = $("#notifList");
    list.innerHTML = "";
    const items = state.feed.slice(0, 12);
    if (!items.length) { list.innerHTML = '<p class="notif__empty">暂无通知</p>'; return; }
    for (const f of items) {
      const row = document.createElement("div");
      row.className = "notif__item" + (f.ts > seenTs ? " unread" : "");
      const dot = { ok: "ok", warn: "warn", crit: "crit" }[f.level] || "warn";
      row.innerHTML = `<span class="feed__time"></span><span class="feed__dot feed__dot--${dot}"></span><span class="feed__msg"></span>`;
      row.children[0].textContent = fmtHM(f.ts);
      row.children[2].textContent = f.msg;
      list.appendChild(row);
    }
  }
  $("#bellBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const panel = $("#notifPanel");
    const open = panel.hidden;
    panel.hidden = !open;
    $("#bellBtn").setAttribute("aria-expanded", open ? "true" : "false");
    if (open) renderNotifList();
  });
  document.addEventListener("click", (e) => {
    const panel = $("#notifPanel");
    if (!panel.hidden && !e.target.closest(".bell-wrap")) { panel.hidden = true; $("#bellBtn").setAttribute("aria-expanded", "false"); }
  });
  $("#markSeen").addEventListener("click", () => {
    seenTs = Date.now();
    N.write(SEEN_KEY, seenTs);
    renderNotifList(); updateBell();
  });

  /* ── 桌面通知(严重告警 + 页面在后台时)────── */
  const DesktopNotify = {
    supported: typeof Notification !== "undefined",
    init() {
      if (!this.supported || Notification.permission !== "default") return;
      const btn = $("#notifyDesktop");
      btn.hidden = false;
      btn.addEventListener("click", async () => {
        const perm = await Notification.requestPermission();
        btn.hidden = perm !== "default";
        if (perm === "granted") toast("桌面通知已开启,严重告警将在后台提醒你");
      });
    },
    fire(f) {
      if (!this.supported || Notification.permission !== "granted") return;
      if (!document.hidden) return;
      try { new Notification("NEXUS · 严重告警", { body: f.msg, tag: f.ts + "" }); } catch {}
    },
  };
  DesktopNotify.init();
  function notifyDesktop(f) { if (f.level === "crit") DesktopNotify.fire(f); }

  /* ── 在线分析师(presence)────────────────── */
  const DEMO_PRESENCE = [
    { name: "演示管理员", company: "NEXUS 演示环境" },
    { name: "林晚风", company: "SOC 值班" },
    { name: "陈拓", company: "威胁情报组" },
  ];
  function renderPresence(data) {
    $("#presenceCount").textContent = `${data.total} 人在线`;
    $("#presenceTotal").textContent = `共 ${data.total} 人`;
    const list = $("#presenceList");
    list.innerHTML = "";
    if (!data.online.length) { list.innerHTML = '<p class="notif__empty">当前没有其他分析师在线</p>'; return; }
    for (const u of data.online) {
      const row = document.createElement("div");
      row.className = "notif__item";
      row.innerHTML = `<span class="feed__dot feed__dot--ok"></span><span class="feed__msg"></span>`;
      row.children[0].style.alignSelf = "center";
      row.children[1].textContent = `${u.name} · ${u.company || "安全团队"}`;
      list.appendChild(row);
    }
  }
  async function refreshPresence() {
    if (mode === "api") {
      try { renderPresence(await API.call("GET", "api/presence")); } catch {}
    } else {
      renderPresence({ total: DEMO_PRESENCE.length, online: DEMO_PRESENCE });
    }
  }
  $("#presenceChip").addEventListener("click", (e) => {
    e.stopPropagation();
    const panel = $("#presencePanel");
    const open = panel.hidden;
    panel.hidden = !open;
    $("#presenceChip").setAttribute("aria-expanded", open ? "true" : "false");
    if (open) refreshPresence();
  });
  document.addEventListener("click", (e) => {
    const panel = $("#presencePanel");
    if (!panel.hidden && !e.target.closest(".presence-wrap")) panel.hidden = true;
  });

  /* ── 告警详情抽屉 ─────────────────────────── */
  const drawer = $("#drawer");
  function openAlertDrawer(a) {
    $("#drawerTitle").textContent = a.id;
    const ops = alertActions(a);
    $("#drawerBody").innerHTML = `
      <dl class="kv">
        <dt>等级</dt><dd><span class="tag tag--${a.level}">${LEVEL_NAME[a.level]}</span></dd>
        <dt>类型</dt><dd></dd>
        <dt>状态</dt><dd><span class="tag tag--${STATUS_TAG[a.status] || "idle"}">${a.status}</span></dd>
        <dt>来源</dt><dd class="dim"></dd>
        <dt>目标资产</dt><dd class="dim"></dd>
        <dt>首次发现</dt><dd class="dim">${fmtFull(a.ts)}</dd>
        <dt>处置人</dt><dd class="dim">${a.handledBy || "—"}</dd>
      </dl>
      <p class="drawer__desc"></p>
      <div class="chain">
        <div class="chain__step"><b>检测</b>探针捕获异常行为并生成原始事件</div>
        <div class="chain__step"><b>情报比对</b>与 200+ 威胁情报源实时碰撞命中</div>
        <div class="chain__step"><b>自动分级</b>引擎评定等级为「${LEVEL_NAME[a.level]}」并聚合降噪</div>
        <div class="chain__step"><b>当前状态</b>${a.status} · 等待${a.status === "待处置" ? "人工处置" : "持续观察"}</div>
      </div>`;
    const dd = $("#drawerBody").querySelectorAll("dd");
    dd[1].textContent = a.type;
    dd[3].textContent = a.src;
    dd[4].textContent = a.asset;
    $("#drawerBody").querySelector(".drawer__desc").textContent = a.desc;
    $("#drawerFoot").innerHTML = ops.length
      ? ops.map(([label, act, cls]) => `<button class="mini-btn mini-btn--${cls || "default"}" data-act="${act}" data-id="${a.id}">${label}</button>`).join("")
      : '<span class="td-dim">该告警已完结,无可用操作。</span>';
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
  }
  function closeDrawer() {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
  }
  $("#drawerClose").addEventListener("click", closeDrawer);
  $("#drawerMask").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  $("#drawerFoot").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const kind = btn.dataset.kind || "alert";
    if (kind === "asset") await handleAssetAction(btn.dataset.act, btn.dataset.id);
    else await handleAlertAction(btn.dataset.act, btn.dataset.id);
    closeDrawer();
  });

  /* ── 资产详情抽屉 ─────────────────────────── */
  function assetPorts(a) {
    // 由资产 ID 确定性生成端口与服务清单(演示数据)
    let seed = 0;
    for (const ch of a.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const all = [[22, "SSH"], [80, "HTTP"], [443, "HTTPS"], [3306, "MySQL"], [6379, "Redis"], [8080, "HTTP-ALT"], [5432, "PostgreSQL"]];
    const n = Math.max(1, a.exposure);
    const out = [];
    let s = seed;
    while (out.length < Math.min(n, all.length)) {
      s = (s * 1103515245 + 12345) >>> 0;
      const pick = all[s % all.length];
      if (!out.find((x) => x[0] === pick[0])) out.push(pick);
    }
    return out;
  }
  function openAssetDrawer(a) {
    $("#drawerTitle").textContent = a.name;
    const canRelease = a.status === "已隔离";
    $("#drawerBody").innerHTML = `
      <dl class="kv">
        <dt>类型</dt><dd></dd>
        <dt>IP 地址</dt><dd class="dim"></dd>
        <dt>操作系统</dt><dd class="dim"></dd>
        <dt>状态</dt><dd><span class="tag tag--${ASSET_TAG[a.status] || "idle"}">${a.status}</span></dd>
        <dt>风险评分</dt><dd>
          <div style="display:flex;align-items:center;gap:10px">
            <div class="riskbar"><i class="${riskColor(a.risk)}" style="width:${a.risk}%"></i></div>
            <span class="td-mono">${a.risk}</span>
          </div></dd>
      </dl>
      <p class="drawer__desc" style="margin-top:16px"><b style="color:var(--text)">暴露端口与服务</b></p>
      <div class="blocklist" style="margin-top:10px">
        ${assetPorts(a).map(([p, s]) => `<div class="blocklist__row"><span class="td-mono">${p}</span><span>${s}</span><span class="dim">对外开放</span></div>`).join("")}
      </div>
      <p class="drawer__desc" style="margin-top:16px"><b style="color:var(--text)">关联告警</b>(近 ${Math.min(5, state.alerts.filter((x) => x.asset === a.name).length)} 条)</p>
      <div class="chain" style="margin-top:10px">
        ${state.alerts.filter((x) => x.asset === a.name).slice(0, 5).map((x) =>
          `<div class="chain__step"><b>${x.id} · ${x.type}</b><span class="tag tag--${STATUS_TAG[x.status] || "idle"}">${x.status}</span></div>`).join("") ||
          '<div class="chain__step"><b>暂无关联告警</b>该资产近期运行平稳</div>'}
      </div>`;
    $("#drawerFoot").innerHTML = canRelease
      ? `<button class="mini-btn mini-btn--ok" data-act="release" data-kind="asset" data-id="${a.id}">恢复上线</button>`
      : `<button class="mini-btn mini-btn--danger" data-act="isolate" data-kind="asset" data-id="${a.id}">隔离</button>
         <button class="mini-btn" data-act="rescan" data-kind="asset" data-id="${a.id}">发起扫描</button>`;
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  /* ── 模拟告警注入 ─────────────────────────── */
  const SIM_POOL = {
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
  $("#simulateBtn").addEventListener("click", async () => {
    if (mode === "api") {
      const res = await apiCall("POST", "api/alerts/simulate");
      if (!res) return;
      state.alerts.unshift(res.alert);
      if (res.feed) pushFeedEntry(res.feed);
      toast(`已注入模拟告警 ${res.alert.id}(${res.alert.type})`, "warn");
    } else {
      const type = SIM_POOL.types[Math.floor(Math.random() * SIM_POOL.types.length)];
      const i = Math.floor(Math.random() * SIM_POOL.types.length);
      const alert = {
        id: "ALT-" + String(10247 + state.alerts.length + 1),
        level: SIM_POOL.levels[i], type,
        src: Math.random() > 0.4 ? `${45 + Math.floor(Math.random() * 180)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${1 + Math.floor(Math.random() * 253)}` : "内生的",
        asset: (state.assets[Math.floor(Math.random() * state.assets.length)] || { name: "web-cluster-01" }).name,
        desc: SIM_POOL.descs[type],
        status: "待处置", ts: Date.now(), handledBy: "",
      };
      state.alerts.unshift(alert);
      pushFeed("crit", `红队演练:注入新告警 ${alert.id}(${type})`);
      save.alerts();
      toast(`已注入模拟告警 ${alert.id}(${type})`, "warn");
    }
    renderKpis();
    if (currentView === "alerts") renderAlerts();
  });

  /* ── CSV 导出 ─────────────────────────────── */
  function downloadCsv(filename, header, rows) {
    const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const csv = "\uFEFF" + [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  $("#exportAlerts").addEventListener("click", () => {
    if (mode === "api") { window.location.href = "api/export/alerts.csv"; return; }
    downloadCsv("nexus-alerts.csv",
      ["告警ID", "等级", "类型", "来源", "目标资产", "状态", "时间", "处置人"],
      state.alerts.map((a) => [a.id, LEVEL_NAME[a.level], a.type, a.src, a.asset, a.status, new Date(a.ts).toLocaleString("zh-CN"), a.handledBy]));
    toast("告警数据已导出为 CSV");
  });
  $("#exportAssets").addEventListener("click", () => {
    if (mode === "api") { window.location.href = "api/export/assets.csv"; return; }
    downloadCsv("nexus-assets.csv",
      ["资产名称", "类型", "IP", "系统", "暴露端口", "风险评分", "状态"],
      state.assets.map((a) => [a.name, a.type, a.ip, a.os, a.exposure, a.risk, a.status]));
    toast("资产数据已导出为 CSV");
  });

  /* ── 账号设置 ─────────────────────────────── */
  function renderSettings() {
    $("#settingsMode").textContent = mode === "api" ? "真实后端模式 · 数据存储于 SQLite" : "浏览器演示模式 · 数据存储于 localStorage";
    const info = $("#settingsInfo");
    info.innerHTML = `<dl class="kv">
      <dt>称呼</dt><dd></dd>
      <dt>公司/团队</dt><dd></dd>
      <dt>邮箱</dt><dd></dd>
      <dt>注册时间</dt><dd class="dim">${user.createdAt ? new Date(user.createdAt).toLocaleDateString("zh-CN") : "—"}</dd>
      <dt>运行模式</dt><dd class="dim">${mode === "api" ? "API · 会话认证" : "演示 · 本地存储"}</dd>
    </dl>`;
    const dds = info.querySelectorAll("dd");
    dds[0].textContent = user.name;
    dds[1].textContent = user.company || "—";
    dds[2].textContent = user.email;
    $("#profName").value = user.name;
    $("#profCompany").value = user.company || "";
  }
  $("#profileForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#profName").value.trim();
    const company = $("#profCompany").value.trim();
    if (!name) return toast("称呼不能为空", "warn");
    const btn = $("#profBtn");
    btn.disabled = true; btn.textContent = "保存中…";
    try {
      if (mode === "api") {
        const res = await API.call("PUT", "api/auth/profile", { name, company });
        Object.assign(user, res.user);
      } else {
        const res = N.updateProfile(user.email, { name, company });
        if (!res.ok) throw new Error(res.error);
        Object.assign(user, res.user);
      }
      // 同步顶栏
      $("#userName").textContent = user.name;
      $("#userCompany").textContent = user.company || "个人空间";
      $("#userAvatar").textContent = user.name.trim().charAt(0).toUpperCase() || "N";
      renderSettings();
      toast("资料已更新");
    } catch (err) {
      toast(err.message, "warn");
    } finally {
      btn.disabled = false; btn.textContent = "保存资料";
    }
  });
  $("#backupBtn").addEventListener("click", () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      account: { name: user.name, email: user.email, company: user.company },
      alerts: state.alerts, assets: state.assets,
      playbooks: state.playbooks, trend: state.trend, feed: state.feed,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `nexus-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("数据备份已下载(JSON)");
  });
  $("#pwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("#pwError");
    errEl.classList.remove("show");
    const oldPw = $("#pwOld").value, newPw = $("#pwNew").value, confirmPw = $("#pwConfirm").value;
    if (!oldPw) { errEl.textContent = "请输入当前密码。"; errEl.classList.add("show"); return; }
    if (newPw !== confirmPw) { errEl.textContent = "两次输入的新密码不一致。"; errEl.classList.add("show"); return; }
    const btn = $("#pwBtn");
    btn.disabled = true; btn.textContent = "更新中…";
    try {
      if (mode === "api") {
        await API.call("PUT", "api/auth/password", { oldPassword: oldPw, newPassword: newPw });
      } else {
        const res = await N.changePassword(user.email, oldPw, newPw);
        if (!res.ok) throw new Error(res.error);
      }
      toast("密码已更新,下次登录请使用新密码");
      $("#pwForm").reset();
    } catch (err) {
      errEl.textContent = err.message; errEl.classList.add("show");
    } finally {
      btn.disabled = false; btn.textContent = "更新密码";
    }
  });

  /* ── 周报生成 ─────────────────────────────── */
  $("#genWeekly").addEventListener("click", () => {
    const total = state.alerts.length;
    const byStatus = {};
    for (const a of state.alerts) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    const byLevel = {};
    for (const a of state.alerts) byLevel[a.level] = (byLevel[a.level] || 0) + 1;
    const byType = {};
    for (const a of state.alerts) byType[a.type] = (byType[a.type] || 0) + 1;
    const topTypes = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const srcCounts = {};
    for (const a of state.alerts) {
      if (a.src && a.src !== "内生的" && a.src !== "-") srcCounts[a.src] = (srcCounts[a.src] || 0) + 1;
    }
    const topSrc = Object.entries(srcCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const pending = state.alerts.filter((a) => a.status === "待处置" || a.status === "处理中");
    const week = new Date();
    const md = `# NEXUS 安全周报
> 生成时间:${new Date().toLocaleString("zh-CN")} · 账号:${user.name}(${user.email})

## 一、总体态势
- 监控资产:${state.assets.length} 个
- 安全事件总数:${total} 条(待处置 ${byStatus["待处置"] || 0} · 处理中 ${byStatus["处理中"] || 0} · 已解决 ${byStatus["已解决"] || 0} · 已封禁 ${byStatus["已封禁"] || 0} · 已隔离 ${byStatus["已隔离"] || 0})
- 等级分布:严重 ${byLevel.crit || 0} · 高危 ${byLevel.high || 0} · 中危 ${byLevel.med || 0} · 低危 ${byLevel.low || 0}

## 二、高发攻击类型 Top 5
${topTypes.map(([t, c], i) => `${i + 1}. **${t}** — ${c} 条`).join("\n") || "无"}

## 三、重点攻击来源 Top 5
${topSrc.map(([s, c], i) => `${i + 1}. \`${s}\` — ${c} 次`).join("\n") || "无外部来源攻击"}

## 四、待跟进事项
${pending.map((a) => `- [ ] ${a.id}(${LEVEL_NAME[a.level]})${a.type} → ${a.asset}:${a.desc}`).join("\n") || "- 无待办事项,保持现状"}

## 五、建议
1. 优先处置上述待办清单中的严重与高危告警;
2. 对高频攻击来源 IP 考虑在边界防火墙落实长期封禁;
3. 针对高发攻击类型开展一次针对性渗透测试与规则加固。

---
*NEXUS 安全运营中心自动生成 · 数据截至生成时刻*
`;
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `nexus-weekly-${week.getMonth() + 1}-${week.getDate()}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("周报已生成并下载(Markdown 格式)");
  });

  /* ── 键盘快捷键(1-6 切换视图)─────────────── */
  const VIEW_ORDER = ["overview", "alerts", "assets", "playbooks", "reports", "settings"];
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
    const idx = parseInt(e.key, 10);
    if (idx >= 1 && idx <= VIEW_ORDER.length) switchView(VIEW_ORDER[idx - 1]);
  });

  /* ── 退出登录 ─────────────────────────────── */
  $("#logoutBtn").addEventListener("click", async () => {
    const ok = await confirmModal({ title: "退出登录", body: "确定要退出安全运营控制台吗?", okText: "退出" });
    if (!ok) return;
    if (mode === "api") { try { await API.call("POST", "api/auth/logout"); } catch {} }
    N.clearSession();
    location.replace("index.html");
  });

  /* ── 初始化 ───────────────────────────────── */
  renderKpis();
  renderFeed();
  renderAlerts();
  renderAssets();
  renderPlaybooks();
  renderReports();
  updateBell();
  refreshPresence();
  drawCharts();
})();
