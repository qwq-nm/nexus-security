/* ═══════════════════════════════════════════════
   NEXUS · 登录 / 注册页逻辑(双模式)
   api 模式 → 真实后端(会话 Cookie)
   demo 模式 → localStorage(静态托管回退)
   ═══════════════════════════════════════════════ */

(async () => {
  "use strict";
  const N = window.NEXUS;
  const { loginUser, registerUser, setSession, ensureDemoUser, DEMO } = N;
  const { call } = window.NEXUS_API;

  const { mode } = await window.NEXUS_MODE;
  if (mode === "demo") ensureDemoUser();

  const page = document.body.dataset.page;
  const nextUrl = () => {
    const p = new URLSearchParams(location.search).get("next");
    return p && /^[\w./-]+\.html$/.test(p) ? p : "dashboard.html"; // 仅允许站内相对路径
  };

  /* ── 登录/注册页星空背景 ──────────────────── */
  const bgCanvas = document.getElementById("authBg");
  if (bgCanvas && bgCanvas.getContext) {
    const ctx = bgCanvas.getContext("2d");
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    let W, H;
    const stars = Array.from({ length: 130 }, () => ({
      x: Math.random(), y: Math.random(),
      r: 0.4 + Math.random() * 1.1,
      tw: Math.random() * Math.PI * 2,
      spd: 0.3 + Math.random(),
    }));
    const resize = () => {
      W = innerWidth; H = innerHeight;
      bgCanvas.width = W * DPR; bgCanvas.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    };
    resize();
    addEventListener("resize", resize);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let t0 = performance.now();
    (function frame(t) {
      const dt = Math.min((t - t0) / 1000, 0.05);
      t0 = t;
      ctx.clearRect(0, 0, W, H);
      for (const s of stars) {
        s.tw += dt * s.spd;
        s.y += dt * 0.004; // 缓慢下坠
        if (s.y > 1) s.y = 0;
        const a = 0.1 + Math.abs(Math.sin(s.tw)) * 0.45;
        ctx.fillStyle = `rgba(200, 220, 245, ${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!reduced) requestAnimationFrame(frame);
    })(t0);
  }

  const showErr = (el, msg) => { el.textContent = msg; el.classList.add("show"); };
  const hideErr = (el) => el.classList.remove("show");
  const emailOk = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
  const busy = (btn, on, text) => { btn.disabled = on; if (text) btn.textContent = text; };

  /* ── 登录 ─────────────────────────────────── */
  if (page === "login") {
    const errEl = document.getElementById("loginError");
    const btn = document.getElementById("loginBtn");
    const form = document.getElementById("loginForm");
    // 记住邮箱:预填
    const savedEmail = localStorage.getItem("nexus_remember");
    if (savedEmail) form.email.value = savedEmail;

    async function doLogin(email, password) {
      busy(btn, true, "验证中…");
      try {
        if (mode === "api") {
          await call("POST", "api/auth/login", { email, password });
        } else {
          const res = await loginUser(email, password);
          if (!res.ok) throw new Error(res.error);
          setSession(res.user.email);
        }
        const remember = document.getElementById("rememberEmail");
        if (remember && remember.checked) localStorage.setItem("nexus_remember", email);
        else localStorage.removeItem("nexus_remember");
        btn.textContent = "登录成功,正在跳转…";
        location.replace(nextUrl());
      } catch (e) {
        busy(btn, false, "登 录");
        showErr(errEl, e.message);
      }
    }

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      hideErr(errEl);
      const email = form.email.value.trim();
      const password = form.password.value;
      if (!emailOk(email)) return showErr(errEl, "请输入有效的邮箱地址。");
      if (!password) return showErr(errEl, "请输入密码。");
      doLogin(email, password);
    });

    document.getElementById("demoBtn").addEventListener("click", () => {
      hideErr(errEl);
      if (mode === "demo") {
        N.resetDemoPassword().then(() => doLogin(DEMO.email, DEMO.password));
      } else {
        doLogin(DEMO.email, DEMO.password);
      }
    });
  }

  /* ── 注册 ─────────────────────────────────── */
  if (page === "register") {
    const errEl = document.getElementById("regError");
    const btn = document.getElementById("regBtn");
    const form = document.getElementById("regForm");
    const pwInput = form.password;
    const strength = document.getElementById("strength");
    const strengthText = document.getElementById("strengthText");

    const LEVELS = ["—", "弱", "一般", "良好", "很强"];
    function pwScore(v) {
      let s = 0;
      if (v.length >= 8) s++;
      if (v.length >= 12) s++;
      if (/[a-zA-Z]/.test(v) && /\d/.test(v)) s++;
      if (/[^a-zA-Z0-9]/.test(v)) s++;
      return Math.min(s, 4);
    }
    pwInput.addEventListener("input", () => {
      const s = pwScore(pwInput.value);
      strength.className = "strength" + (pwInput.value ? " strength--" + s : "");
      strengthText.textContent = "密码强度:" + LEVELS[s];
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      hideErr(errEl);
      const name = form.name.value.trim();
      const company = form.company.value.trim();
      const email = form.email.value.trim();
      const password = pwInput.value;
      const confirm = form.confirm.value;

      if (!name) return showErr(errEl, "请填写你的称呼。");
      if (!emailOk(email)) return showErr(errEl, "请输入有效的邮箱地址。");
      if (password.length < 8) return showErr(errEl, "密码至少需要 8 位。");
      if (!(/[a-zA-Z]/.test(password) && /\d/.test(password))) return showErr(errEl, "密码需同时包含字母与数字。");
      if (password !== confirm) return showErr(errEl, "两次输入的密码不一致。");
      if (!document.getElementById("agree").checked) return showErr(errEl, "请先阅读并同意服务条款与隐私政策。");

      busy(btn, true, "创建中…");
      try {
        if (mode === "api") {
          await call("POST", "api/auth/register", { name, company, email, password });
        } else {
          const res = await registerUser({ name, company, email, password });
          if (!res.ok) throw new Error(res.error);
          setSession(res.user.email);
        }
        btn.textContent = "注册成功,正在进入控制台…";
        location.replace("dashboard.html");
      } catch (err) {
        busy(btn, false, "创建账号并开始试用");
        showErr(errEl, err.message);
      }
    });

    document.getElementById("demoBtn").addEventListener("click", () => {
      hideErr(errEl);
      if (mode === "api") {
        doDemoApi();
      } else {
        N.resetDemoPassword().then(() => {
          setSession(DEMO.email);
          location.replace("dashboard.html");
        });
      }
    });
    async function doDemoApi() {
      try {
        await call("POST", "api/auth/login", { email: DEMO.email, password: DEMO.password });
        location.replace("dashboard.html");
      } catch (e) { showErr(errEl, e.message); }
    }
  }
})();
