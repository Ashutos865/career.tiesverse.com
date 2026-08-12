// API base resolution.
//
// Production: the static frontend is hosted on career.tiesverse.com while the
// Django API runs on its own subdomain, so we point at it explicitly.
// Local dev: the Django app serves BOTH the pages and /api/ from one origin,
// so we just use the current origin.
// career-api, not api.career: Cloudflare's universal certificate covers only
// first-level subdomains, so api.career.tiesverse.com fails TLS in browsers.
const TV_PROD_API = "https://career-api.tiesverse.com/api/";
const TV_FALLBACK_API = "http://127.0.0.1:8000/api/";

const host = window.location.hostname;
const isLocal = ["localhost", "127.0.0.1"].includes(host);

window.TV_API_URL =
  window.location.protocol === "file:"
    ? TV_FALLBACK_API
    : isLocal
      ? `${window.location.origin}/api/`   // dev: Django serves pages + API together
      : TV_PROD_API;                       // prod: dedicated API subdomain

window.TV_APP_SCRIPT_URL = window.TV_API_URL;
