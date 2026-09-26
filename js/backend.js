/* ═══════════════════════════════════════════════
   NEXUS · 前端后端探测层
   探测 GET api/auth/me:
   - 200 → api 模式(已登录)
   - 401 → api 模式(后端存在,未登录 —— 由页面引导登录)
   - 404 / 网络失败 → demo 模式(静态托管,如 GitHub Pages)
   注意:模式由「后端是否存在」决定,而非登录态。
   ═══════════════════════════════════════════════ */

(() => {
  "use strict";

  const probe = fetch("api/auth/me", {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  })
    .then(async (r) => {
      if (r.status === 200) return { mode: "api", user: await r.json() };
      if (r.status === 401) return { mode: "api", user: null };
      return { mode: "demo", user: null };   // 404 / 其他 → 静态托管
    })
    .catch(() => ({ mode: "demo", user: null }));

  window.NEXUS_MODE = probe;

  window.NEXUS_API = {
    ready: probe,
    async call(method, url, body) {
      const res = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || "请求失败(" + res.status + ")");
        err.status = res.status;
        throw err;
      }
      return data;
    },
  };
})();
