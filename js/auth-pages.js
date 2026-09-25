/* ═══════════════════════════════════════════════
   NEXUS · 登录 / 注册页逻辑
   ═══════════════════════════════════════════════ */

(() => {
  "use strict";
  const { loginUser, registerUser, setSession, ensureDemoUser, DEMO } = window.NEXUS;

  ensureDemoUser();

  const page = document.body.dataset.page;
  const nextUrl = () => {
    const p = new URLSearchParams(location.search).get("next");
    return p && /^[\w./-]+\.html$/.test(p) ? p : "dashboard.html"; // 仅允许站内相对路径
  };

  const showErr = (el, msg) => { el.textContent = msg; el.classList.add("show"); };
  const hideErr = (el) => el.classList.remove("show");

  const emailOk = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

  /* ── 登录 ─────────────────────────────────── */
  if (page === "login") {
    const errEl = document.getElementById("loginError");
    const btn = document.getElementById("loginBtn");
    const form = document.getElementById("loginForm");

    async function doLogin(email, password) {
      btn.disabled = true; btn.textContent = "验证中…";
      const res = await loginUser(email, password);
      if (!res.ok) {
        btn.disabled = false; btn.textContent = "登 录";
        showErr(errEl, res.error);
        return;
      }
      setSession(res.user.email);
      btn.textContent = "登录成功,正在跳转…";
      location.replace(nextUrl());
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
      doLogin(DEMO.email, DEMO.password);
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

      btn.disabled = true; btn.textContent = "创建中…";
      const res = await registerUser({ name, company, email, password });
      if (!res.ok) {
        btn.disabled = false; btn.textContent = "创建账号并开始试用";
        return showErr(errEl, res.error);
      }
      setSession(res.user.email);
      btn.textContent = "注册成功,正在进入控制台…";
      location.replace("dashboard.html");
    });

    document.getElementById("demoBtn").addEventListener("click", () => {
      hideErr(errEl);
      setSession(DEMO.email);
      location.replace("dashboard.html");
    });
  }
})();
