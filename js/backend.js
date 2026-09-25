/* ═══════════════════════════════════════════════
   NEXUS · 前端后端探测层
   探测 GET api/auth/me:
   - 200 → api 模式(真实后端:SQLite / 会话 / REST / SSE)
   - 404 / 网络失败 → demo 模式(localStorage,GitHub Pages 静态托管)
   ═══════════════════════════════════════════════ */

(() => {
  "use strict";

  const probe = fetch("api/auth/me", {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  window.NEXUS_MODE = probe.then((user) => ({ mode: user ? "api" : "demo", user }));

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
