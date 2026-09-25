/* ═══════════════════════════════════════════════
   NEXUS · 交互脚本
   1) 英雄区线框网络球体(Canvas)
   2) 威胁事件流(终端模拟)
   3) 滚动入场 + 数字滚动
   4) 移动端导航
   ═══════════════════════════════════════════════ */

(() => {
  "use strict";

  /* ── 1. 网络球体 ─────────────────────────── */
  const canvas = document.getElementById("globe");
  if (canvas && canvas.getContext) {
    const ctx = canvas.getContext("2d");
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const POINTS = 340;          // 球面点数
    let W = 0, H = 0, R = 0;
    let rotY = 0, rotX = -0.28;
    let targetRotX = -0.28;

    // 斐波那契球面均匀布点(单位球坐标系)
    const pts = [];
    const GA = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < POINTS; i++) {
      const y = 1 - (i / (POINTS - 1)) * 2;
      const rad = Math.sqrt(1 - y * y);
      const th = GA * i;
      pts.push({ x: Math.cos(th) * rad, y, z: Math.sin(th) * rad, s: Math.random() });
    }
    // 旋转是刚体运动,三维邻居关系不变:初始化时预计算连线对
    const LINK_DIST = 0.3; // 单位球弦长阈值
    const pairs = [];
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y, dz = pts[i].z - pts[j].z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < LINK_DIST) pairs.push([i, j]);
      }
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      W = rect.width; H = rect.height;
      canvas.width = W * DPR; canvas.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      R = Math.min(W, H) * 0.42;
    }
    resize();
    window.addEventListener("resize", resize);

    // 鼠标轻微视差
    window.addEventListener("pointermove", (e) => {
      targetRotX = -0.28 + (e.clientY / window.innerHeight - 0.5) * 0.24;
    }, { passive: true });

    function project(p) {
      // 绕 Y 轴
      const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
      const x1 = p.x * cosY - p.z * sinY;
      const z1 = p.x * sinY + p.z * cosY;
      // 绕 X 轴
      const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
      const y2 = p.y * cosX - z1 * sinX;
      const z2 = p.y * sinX + z1 * cosX;
      const persp = 1 / (1.6 - z2 * 0.55);
      return { x: x1 * R * persp, y: y2 * R * persp, z: z2, persp };
    }

    let lastT = performance.now();
    function frame(t) {
      const dt = Math.min((t - lastT) / 1000, 0.05);
      lastT = t;
      rotY += dt * 0.16;
      rotX += (targetRotX - rotX) * 0.04;

      ctx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2;
      const proj = pts.map(project);

      // 球体辉光
      const glow = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.35);
      glow.addColorStop(0, "rgba(37, 99, 235, 0.16)");
      glow.addColorStop(0.55, "rgba(37, 99, 235, 0.06)");
      glow.addColorStop(1, "rgba(37, 99, 235, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);

      // 点间连线(透明度随深度渐变:背面暗、正面亮)
      ctx.lineWidth = 1;
      for (let k = 0; k < pairs.length; k++) {
        const a = proj[pairs[k][0]], b = proj[pairs[k][1]];
        const depth = (a.z + b.z) / 2;                       // -1 后方 … 1 前方
        const alpha = 0.05 + ((depth + 1) / 2) * 0.5;
        ctx.strokeStyle = `rgba(96, 165, 250, ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(cx + a.x, cy + a.y);
        ctx.lineTo(cx + b.x, cy + b.y);
        ctx.stroke();
      }

      // 球面节点
      for (let i = 0; i < proj.length; i++) {
        const p = proj[i];
        const front = (p.z + 1) / 2;                       // 0 后 … 1 前
        const size = (0.9 + p.s * 1.7) * (0.55 + front * 0.9);
        const alpha = 0.25 + front * 0.65;
        ctx.fillStyle =
          p.s > 0.955
            ? `rgba(147, 197, 253, ${alpha.toFixed(3)})`
            : `rgba(96, 165, 250, ${(alpha * 0.85).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(cx + p.x, cy + p.y, size, 0, Math.PI * 2);
        ctx.fill();
      }

      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* ── 2. 威胁事件流 ───────────────────────── */
  const term = document.getElementById("terminalBody");
  if (term) {
    const events = [
      ["HIGH", "检测到 <b>45.83.x.x</b> 对 /wp-login.php 的暴力破解,已自动封禁"],
      ["OK",   "基线学习完成 · <b>web-cluster-01</b> 行为模型已更新"],
      ["CRIT", "拦截 SQL 注入尝试 → <b>api.nexuscorp.cn/orders</b>,载荷已隔离"],
      ["MED",  "异常出站流量 <b>2.3 GB</b> → 主机 <b>hr-wks-114</b>,等待人工研判"],
      ["OK",   "处置剧本 <b>auto-quarantine</b> 执行成功,耗时 <b>38ms</b>"],
      ["HIGH", "SSH 蜜罐捕获新样本,哈希已同步威胁情报网络"],
      ["MED",  "TLS 证书 <b>vpn.edge-7</b> 将于 14 天后到期,已生成工单"],
      ["CRIT", "识别挖矿木马行为 → <b>k8s-node-12</b> 已自动隔离并通知值班"],
      ["OK",   "全网资产扫描完成 · <b>1,284</b> 个资产 · 新发现 2 个暴露端口"],
      ["HIGH", "撞库攻击告警 · 来源 <b>AS-4134</b>,触发限流策略"],
      ["MED",  "DNS 隧道疑似外传数据 · 域名 <b>cdn-metrics.xyz</b> 已标记"],
      ["OK",   "合规基线检查通过 · 等保 2.0 三级 · 覆盖率 <b>98.6%</b>"],
    ];
    const pad = (n) => String(n).padStart(2, "0");
    let idx = 0, shown = 0;

    function pushLine() {
      const now = new Date();
      const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      const [level, msg] = events[idx % events.length];
      idx++;
      const cls = { CRIT: "crit", HIGH: "high", MED: "med", OK: "ok" }[level] || "med";
      const line = document.createElement("div");
      line.className = "log-line";
      line.innerHTML =
        `<span class="log-time">${time}</span>` +
        `<span class="log-tag log-tag--${cls}">${level}</span>` +
        `<span class="log-msg">${msg}</span>`;
      term.appendChild(line);
      shown++;
      while (term.children.length > 14) term.removeChild(term.firstChild);
    }
    for (let i = 0; i < 8; i++) pushLine();
    setInterval(pushLine, 2100);

    const status = document.getElementById("terminalStatus");
    if (status) {
      const nodes = [
        "监测中 · 全部节点在线",
        "分析中 · 引擎负载 23%",
        "处置中 · 2 个剧本运行",
        "监测中 · 情报源已同步",
      ];
      let s = 0;
      setInterval(() => { s = (s + 1) % nodes.length; status.textContent = nodes[s]; }, 6500);
    }
  }

  /* ── 3. 滚动入场 + 数字滚动 ──────────────── */
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      en.target.classList.add("in");
      const num = en.target.querySelector(".stat__num") || (en.target.classList.contains("stat__num") ? en.target : null);
      if (num && !num.dataset.done) {
        num.dataset.done = "1";
        animateNum(num);
      }
      io.unobserve(en.target);
    }
  }, { threshold: 0.18 });

  function animateNum(el) {
    const target = parseFloat(el.dataset.count || "0");
    const decimals = parseInt(el.dataset.decimals || "0", 10);
    const suffix = el.dataset.suffix || "";
    const dur = 1600;
    const t0 = performance.now();
    function tick(t) {
      const p = Math.min((t - t0) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      const val = (target * eased).toFixed(decimals);
      el.textContent = Number(val).toLocaleString("en-US", {
        minimumFractionDigits: decimals, maximumFractionDigits: decimals,
      }) + suffix;
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  document.querySelectorAll(".reveal, .stat").forEach((el) => io.observe(el));

  /* ── 4. 移动端导航 ───────────────────────── */
  const burger = document.getElementById("navBurger");
  const drawer = document.getElementById("navDrawer");
  if (burger && drawer) {
    burger.addEventListener("click", () => {
      const open = drawer.classList.toggle("open");
      burger.setAttribute("aria-expanded", open ? "true" : "false");
    });
    drawer.querySelectorAll("a").forEach((a) =>
      a.addEventListener("click", () => {
        drawer.classList.remove("open");
        burger.setAttribute("aria-expanded", "false");
      })
    );
  }
})();
