(() => {
  "use strict";

  function themedNotice() {}

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
