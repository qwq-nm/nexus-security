/* ═══════════════════════════════════════════════
   NEXUS · 开场动画驱动
   时序:盾牌描边 → 字母点亮 → 计数 0→100(状态轮换)
         → 幕布升起 → 派发 nexus:intro-done(Hero 逐行入场)
   可点击/按键跳过;prefers-reduced-motion 时跳过
   ═══════════════════════════════════════════════ */

(() => {
  "use strict";

  const root = document.documentElement;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // 无 JS / 减少动态:直接进入完成态
  if (!root.classList.contains("intro-pending") || reduced) {
    root.classList.remove("intro-pending");
    root.classList.add("intro-done");
    return;
  }

  const intro = document.getElementById("intro");
  if (!intro) { root.classList.remove("intro-pending"); root.classList.add("intro-done"); return; }

  const count = intro.querySelector(".intro__count");
  const bar = intro.querySelector(".intro__bar i");
  const status = intro.querySelector(".intro__status");

  const DURATION = 2100;   // 计数阶段时长
  const LIFT_AT = 2200;    // 幕布开始升起
  const DONE_AT = 2600;    // 派发完成事件(此时幕布已过半,Hero 开始入场)
  const STATUS_STEPS = [
    [0.0, "ESTABLISHING SECURE CHANNEL"],
    [0.34, "LOADING THREAT INTELLIGENCE"],
    [0.68, "CALIBRATING SENSOR ARRAY"],
    [0.96, "ACCESS GRANTED", true],
  ];

  let t0 = 0, rafId = 0, timers = [];
  let finished = false;

  const easeOut = (p) => 1 - Math.pow(1 - p, 3);

  function tick(now) {
    const p = Math.min((now - t0) / DURATION, 1);
    const val = Math.round(easeOut(p) * 100);
    if (count) count.textContent = String(val).padStart(2, "0");
    if (bar) bar.style.width = val + "%";
    if (status) {
      for (const [th, text, ok] of STATUS_STEPS) {
        if (p >= th) { status.textContent = text; status.classList.toggle("is-ok", !!ok); }
      }
    }
    if (p < 1) rafId = requestAnimationFrame(tick);
  }

  function finish() {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(rafId);
    timers.forEach(clearTimeout);
    if (count) count.textContent = "100";
    if (bar) bar.style.width = "100%";
    if (status) { status.textContent = "ACCESS GRANTED"; status.classList.add("is-ok"); }

    root.classList.remove("intro-pending");
    root.classList.add("intro-lifting");
    window.dispatchEvent(new CustomEvent("nexus:intro-done"));

    timers.push(setTimeout(() => {
      root.classList.remove("intro-lifting");
      root.classList.add("intro-done");
      intro.remove();
    }, 950));
  }

  window.addEventListener("pointerdown", finish, { once: true });
  window.addEventListener("keydown", finish, { once: true });

  rafId = requestAnimationFrame((now) => { t0 = now; rafId = requestAnimationFrame(tick); });
  timers.push(setTimeout(finish, LIFT_AT));
})();
