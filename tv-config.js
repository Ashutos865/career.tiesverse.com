const TV_IS_LOCAL_FRONTEND =
  window.location.protocol === "file:" ||
  ["127.0.0.1", "localhost"].includes(window.location.hostname) &&
    window.location.port !== "8000";

window.TV_API_URL = TV_IS_LOCAL_FRONTEND
  ? "http://127.0.0.1:8000/api/"
  : `${window.location.origin}/api/`;

window.TV_APP_SCRIPT_URL = window.TV_API_URL;
