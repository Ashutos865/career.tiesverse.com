// The Django backend serves these pages AND the /api/ endpoint from the SAME
// origin, so in the browser we always call the current origin. Only when a page
// is opened directly from disk (file://) do we need an absolute fallback URL.
const TV_FALLBACK_API = "http://127.0.0.1:8000/api/";

window.TV_API_URL =
  window.location.protocol === "file:"
    ? TV_FALLBACK_API
    : `${window.location.origin}/api/`;

window.TV_APP_SCRIPT_URL = window.TV_API_URL;
