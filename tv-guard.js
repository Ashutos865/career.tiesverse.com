(() => {
  "use strict";

  const NOTICE_COOLDOWN_MS = 2000;
  let lastNoticeAt = 0;

  function now() {
    return Date.now();
  }

  function safeText(v) {
    return String(v == null ? "" : v);
  }

  function fallbackToast(title, message) {
    let root = document.getElementById("tv-guard-toast");
    if (!root) {
      root = document.createElement("div");
      root.id = "tv-guard-toast";
      root.innerHTML = `
        <style>
          #tv-guard-toast{position:fixed;left:16px;right:16px;bottom:16px;z-index:999999;display:flex;justify-content:center;pointer-events:none}
          #tv-guard-toast .card{max-width:520px;width:100%;border:1px solid rgba(255,255,255,.14);background:rgba(10,10,10,.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-radius:14px;padding:14px 14px 12px 14px;box-shadow:0 18px 60px rgba(0,0,0,.55);pointer-events:auto;transform:translateY(14px);opacity:0;transition:all .18s ease}
          #tv-guard-toast.show .card{transform:translateY(0);opacity:1}
          #tv-guard-toast .t{font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-weight:800;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#fe7a00}
          #tv-guard-toast .m{margin-top:6px;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;line-height:1.35;color:rgba(255,255,255,.78)}
        </style>
        <div class="card" role="status" aria-live="polite">
          <div class="t"></div>
          <div class="m"></div>
        </div>
      `;
      document.body.appendChild(root);
    }

    const t = root.querySelector(".t");
    const m = root.querySelector(".m");
    if (t) t.textContent = safeText(title);
    if (m) m.textContent = safeText(message);
    root.classList.add("show");
    clearTimeout(root._tvGuardTimer);
    root._tvGuardTimer = setTimeout(() => root.classList.remove("show"), 3500);
  }

  function themedNotice() {
    const n = now();
    if (n - lastNoticeAt < NOTICE_COOLDOWN_MS) return;
    lastNoticeAt = n;

    const title = "DevTools Disabled";
    const message = "This action is disabled on this website.";

    try {
      if (typeof window.tvNotify === "function") {
        window.tvNotify("warn", title, message, 6000);
        return;
      }
    } catch (_) {}

    fallbackToast(title, message);
  }

  function isDevtoolsShortcut(e) {
    const key = String(e.key || "").toUpperCase();
    const code = String(e.code || "").toUpperCase();
    const keyCode = Number(e.keyCode || 0);

    if (key === "F12" || code === "F12" || keyCode === 123) return true;

    const ctrlOrMeta = !!(e.ctrlKey || e.metaKey);
    if (ctrlOrMeta && e.shiftKey && ["I", "J", "C", "K"].includes(key)) return true;
    if (ctrlOrMeta && !e.shiftKey && key === "U") return true;

    return false;
  }

  function install() {
    document.addEventListener(
      "contextmenu",
      (e) => {
        e.preventDefault();
        themedNotice();
      },
      { capture: true }
    );

    document.addEventListener(
      "keydown",
      (e) => {
        if (!isDevtoolsShortcut(e)) return;
        e.preventDefault();
        e.stopPropagation();
        themedNotice();
      },
      { capture: true }
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();

