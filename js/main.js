/* ═══════════════════════════════════════════════
   NEXUS · 交互脚本
   1) 英雄区线框网络球体(Canvas)
   2) 威胁事件流(终端模拟)
   3) 滚动入场 + 数字滚动
   4) 移动端导航
   ═══════════════════════════════════════════════ */

(() => {
  "use strict";

  /* ── 1. 日食主视觉(黑洞圆盘 + 粒子环 + 星空)── */
  const canvas = document.getElementById("globe");
  if (canvas && canvas.getContext) {
    const ctx = canvas.getContext("2d");
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0, R = 0, CX = 0, CY = 0;

    // 星空背景
    const stars = Array.from({ length: 190 }, () => ({
      x: Math.random(), y: Math.random(),
      r: 0.4 + Math.random() * 1.2,
      tw: Math.random() * Math.PI * 2,
      spd: 0.4 + Math.random() * 1.2,
    }));
    // 轨道粒子环
    const ring = Array.from({ length: 620 }, () => ({
      ang: Math.random() * Math.PI * 2,
      rad: 1.04 + Math.pow(Math.random(), 1.6) * 0.3,   // 1.04R ~ 1.34R
      spd: (0.05 + Math.random() * 0.12) * (Math.random() > 0.12 ? 1 : -1),
      size: 0.5 + Math.random() * 1.5,
      glow: Math.random() > 0.93,
    }));

    function resize() {
      const rect = canvas.getBoundingClientRect();
      W = rect.width; H = rect.height;
      canvas.width = W * DPR; canvas.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      R = Math.min(W, H) * 0.335;
      CX = W * 0.5; CY = H * 0.5;
    }
    resize();
    window.addEventListener("resize", resize);

    let parX = 0, parY = 0;
    window.addEventListener("pointermove", (e) => {
      parX = (e.clientX / window.innerWidth - 0.5) * 14;
      parY = (e.clientY / window.innerHeight - 0.5) * 10;
    }, { passive: true });

    let lastT = performance.now();
    function frame(t) {
      const dt = Math.min((t - lastT) / 1000, 0.05);
      lastT = t;
      ctx.clearRect(0, 0, W, H);
      const cx = CX + parX, cy = CY + parY;

      // 星空
      for (const s of stars) {
        s.tw += dt * s.spd;
        const a = 0.14 + Math.abs(Math.sin(s.tw)) * 0.5;
        ctx.fillStyle = `rgba(210, 225, 245, ${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // 外围辉光
      const glow = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.75);
      glow.addColorStop(0, "rgba(56, 225, 255, 0.10)");
      glow.addColorStop(0.5, "rgba(56, 225, 255, 0.035)");
      glow.addColorStop(1, "rgba(56, 225, 255, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);

      // 轨道粒子环 —— 两遍绘制:后排(上半圈)先画,被圆盘遮挡;前排(下半圈)在盘后再画
      const drawRing = (front) => {
        for (const p of ring) {
          const isFront = Math.sin(p.ang) >= 0;
          if (isFront !== front) continue;
          p.ang += p.spd * dt;
          const x = cx + Math.cos(p.ang) * R * p.rad;
          const y = cy + Math.sin(p.ang) * R * p.rad * 0.96;
          const depth = 0.5 + 0.5 * Math.sin(p.ang);
          const alpha = (0.18 + depth * 0.7) * (p.glow ? 1 : 0.55);
          ctx.fillStyle = p.glow
            ? `rgba(140, 240, 255, ${alpha.toFixed(3)})`
            : `rgba(160, 205, 225, ${(alpha * 0.8).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(x, y, p.size * (0.6 + depth * 0.7), 0, Math.PI * 2);
          ctx.fill();
        }
      };
      drawRing(false);

      // 黑洞圆盘(先画盘,遮住环的后排粒子,再补一次前排粒子)
      const disc = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R);
      disc.addColorStop(0, "#000205");
      disc.addColorStop(0.82, "#000103");
      disc.addColorStop(1, "rgba(2, 4, 10, 0.94)");
      ctx.fillStyle = disc;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

      // 日食边缘辉光(上亮下暗,模拟光源方向)
      for (const [a0, a1, width, color] of [
        [-Math.PI * 1.15, -Math.PI * -0.15, 2.2, "rgba(160, 240, 255, 0.95)"],
        [Math.PI * 0.75, Math.PI * 1.35, 1.1, "rgba(90, 170, 200, 0.4)"],
      ]) {
        ctx.save();
        ctx.strokeStyle = color; ctx.lineWidth = width;
        ctx.shadowColor = "rgba(56, 225, 255, 0.9)"; ctx.shadowBlur = 22;
        ctx.beginPath(); ctx.arc(cx, cy, R, a0, a1); ctx.stroke();
        ctx.restore();
      }
      // 内缘暗环
      ctx.strokeStyle = "rgba(0, 0, 0, 0.85)"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(cx, cy, R - 1.6, 0, Math.PI * 2); ctx.stroke();

      // 细轨道线
      ctx.strokeStyle = "rgba(160, 205, 225, 0.09)"; ctx.lineWidth = 1;
      for (const rr of [1.13, 1.26]) {
        ctx.beginPath(); ctx.ellipse(cx, cy, R * rr, R * rr * 0.96, 0, 0, Math.PI * 2); ctx.stroke();
      }

      // 前排粒子补画(盖在圆盘上,形成环绕感)
      drawRing(true);

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
