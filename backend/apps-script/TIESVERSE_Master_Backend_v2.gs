const RESUMES_FOLDER_NAME = "TV_Resumes";
const SHEET_NAME = "Master"; 
const ADMIN_EMAIL = "theindianequation@gmail.com"; 
const CONFIG_SHEET_NAME = "TV_Config";
const DEDUP_WINDOW_DAYS = 30;
const DEDUP_WINDOW_MS = DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const REQUEST_ID_HEADER = "request_id";
const REQUEST_ID_COL = 19;

// Offer letter tracking (stored on the Master sheet)
// Appended after request_id to keep existing columns stable.
const OFFER_LETTER_STATUS_HEADER = "offer_letter_status";
const OFFER_LETTER_STATUS_COL = 20;
const OFFER_LETTER_CODE_HEADER = "certificate_code";
const OFFER_LETTER_CODE_COL = 21;
const OFFER_LETTER_ISSUE_DATE_HEADER = "offer_issue_date";
const OFFER_LETTER_ISSUE_DATE_COL = 22;
const OFFER_LETTER_GENERATED_AT_HEADER = "offer_generated_at";
const OFFER_LETTER_GENERATED_AT_COL = 23;
const OFFER_LETTER_ROLE_HEADER = "offer_role";
const OFFER_LETTER_ROLE_COL = 24;
const OFFER_LETTER_MANAGER_HEADER = "offer_manager_name";
const OFFER_LETTER_MANAGER_COL = 25;
const OFFER_LETTER_JOINING_DATE_HEADER = "offer_joining_date";
const OFFER_LETTER_JOINING_DATE_COL = 26;
const OFFER_LETTER_STATUS_PENDING = "Pending";
const OFFER_LETTER_STATUS_DONE = "Done";

// Admin access (for admin.html only)
const ADMIN_PASSWORD = "TIESVERSE2025";
const ADMIN_SESSION_DAYS = 7;
const ADMIN_SESSION_MS = ADMIN_SESSION_DAYS * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_PREFIX = "tv_admin_session_";

// Cloudflare sync/migration.
// Set these in Apps Script -> Project Settings -> Script properties:
// CLOUDFLARE_SYNC_ENABLED=true
// CLOUDFLARE_ACCOUNT_ID=...
// CLOUDFLARE_D1_DATABASE_ID=...
// CLOUDFLARE_API_TOKEN=...
// CLOUDFLARE_R2_BUCKET=...
// CLOUDFLARE_R2_ACCESS_KEY_ID=...
// CLOUDFLARE_R2_SECRET_ACCESS_KEY=...
const CLOUDFLARE_SYNC_ENABLED_PROP = "CLOUDFLARE_SYNC_ENABLED";
const CLOUDFLARE_MIGRATION_CURSOR_PROP = "CLOUDFLARE_MIGRATION_CURSOR";
const CLOUDFLARE_MIGRATION_RUNNING_PROP = "CLOUDFLARE_MIGRATION_RUNNING";
const CLOUDFLARE_MIGRATION_STATUS_PROP = "CLOUDFLARE_MIGRATION_STATUS";
const CLOUDFLARE_MIGRATION_BATCH_SIZE = 20;
let CLOUDFLARE_SCHEMA_READY = false;

// Category/position gate hierarchy (used for Settings normalization)
const CATEGORY_KEYS = ["Tech", "Content", "Media", "Operations"];
const CATEGORY_POSITIONS = {
  Content: ["content_editor", "content_writer_upsc", "upsc_strategist", "graphic_designer_canva", "uiux_designer"],
  Media: ["video_editor_reels_yt", "social_media_manager_ig", "youtube_manager"],
  Operations: ["hr", "marketing_outreach", "management_coordination", "collab_outreach"],
  Tech: ["tech_roles"],
};

function normalizeGateHierarchy_(incoming) {
  const merged = {};
  const inObj = incoming || {};

  // Start with existing (explicit) values, then overlay incoming values.
  const existing = readFormGates_();
  Object.keys(existing || {}).forEach((k) => (merged[String(k)] = existing[k] === true));
  Object.keys(inObj || {}).forEach((k) => (merged[String(k)] = inObj[k] === true));

  // Rules:
  // - If category is closed => all positions under it are closed.
  // - If any position under a category is open => category is open.
  // - Category does NOT automatically open all positions.
  CATEGORY_KEYS.forEach((cat) => {
    const positions = CATEGORY_POSITIONS[cat] || [];

    if (merged[cat] === false) {
      positions.forEach((p) => (merged[p] = false));
      return;
    }

    const anyOpen = positions.some((p) => merged[p] !== false);
    if (anyOpen) merged[cat] = true;
  });

  // Ensure we always write all relevant keys as explicit booleans.
  const out = {};
  CATEGORY_KEYS.forEach((cat) => {
    out[cat] = merged[cat] !== false;
    (CATEGORY_POSITIONS[cat] || []).forEach((p) => {
      out[p] = merged[p] !== false;
    });
  });

  // Preserve any extra keys that might exist.
  Object.keys(merged).forEach((k) => {
    if (Object.prototype.hasOwnProperty.call(out, k)) return;
    out[k] = merged[k] !== false;
  });

  return out;
}

function issueAdminSession_() {
  const token = Utilities.getUuid();
  const nowMs = Date.now();
  PropertiesService.getScriptProperties().setProperty(
    ADMIN_SESSION_PREFIX + token,
    JSON.stringify({ issuedAt: nowMs }),
  );
  return { token: token, expiresAt: new Date(nowMs + ADMIN_SESSION_MS).toISOString() };
}

function validateAdminSession_(token) {
  const t = String(token || "").trim();
  if (!t) return false;

  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(ADMIN_SESSION_PREFIX + t);
  if (!raw) return false;

  try {
    const parsed = JSON.parse(raw);
    const issuedAt = Number(parsed && parsed.issuedAt);
    if (!issuedAt) return false;
    if (Date.now() - issuedAt > ADMIN_SESSION_MS) {
      props.deleteProperty(ADMIN_SESSION_PREFIX + t);
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Handle CORS Preflight
 */
function doOptions(e) {
  return ContentService.createTextOutput("")
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * ROUTE: ADMIN FETCH / STATUS (GET via JSONP)
 */
function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    const action = String(p.action || "GET_CANDIDATES").trim() || "GET_CANDIDATES";

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) return respond_(e, { status: "error", message: "Sheet not found" });

    if (action === "ADMIN_LOGIN") {
      const password = String(p.password || "");
      if (password !== ADMIN_PASSWORD) return respond_(e, { status: "error", message: "INVALID_PASSWORD" });
      const session = issueAdminSession_();
      return respond_(e, { status: "success", token: session.token, expires_at: session.expiresAt });
    }

    if (action === "ADMIN_CHECK") {
      const ok = validateAdminSession_(p.token);
      return respond_(e, { status: ok ? "success" : "UNAUTHORIZED" });
    }

    // Protect admin-only GET endpoints
    if (
      action === "GET_CANDIDATES" ||
      action === "GET_FORM_GATES" ||
      action === "GENERATE_OFFER_LETTER" ||
      action === "GET_OFFER_BY_QUERY"
    ) {
      if (!validateAdminSession_(p.token)) return respond_(e, { status: "UNAUTHORIZED" });
    }

    if (action === "GET_CANDIDATES") {
      return respond_(e, { status: "success", data: listCandidates_(sheet) });
    }

    if (action === "GET_FORM_GATES") {
      return respond_(e, { status: "success", gates: readFormGates_() });
    }

    if (action === "GENERATE_OFFER_LETTER") {
      const rowNum = parseInt(p.row, 10);
      if (!rowNum || rowNum < 2) return respond_(e, { status: "error", message: "Invalid row" });

      ensureOfferLetterColumns_(sheet);

      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        const row = sheet.getRange(rowNum, 1, 1, Math.max(sheet.getLastColumn(), OFFER_LETTER_JOINING_DATE_COL)).getValues()[0] || [];

        const firstName = String(row[4] || "").trim();
        const lastName = String(row[5] || "").trim();
        const email = String(row[6] || "").trim();
        const phone = String(row[7] || "").trim();
        const roles = String(row[3] || "").trim();
        const dept = String(row[2] || "").trim();

        const existingCode = String(row[OFFER_LETTER_CODE_COL - 1] || "").trim();
        const existingIssueDate = String(row[OFFER_LETTER_ISSUE_DATE_COL - 1] || "").trim();
        const existingOfferRole = String(row[OFFER_LETTER_ROLE_COL - 1] || "").trim();
        const existingManager = String(row[OFFER_LETTER_MANAGER_COL - 1] || "").trim();
        const existingJoiningDate = String(row[OFFER_LETTER_JOINING_DATE_COL - 1] || "").trim();

        const issueDate = String(p.issue_date || "").trim() || existingIssueDate || formatIssueDate_(new Date());
        const certificateCode = (existingCode || generateCertificateCode_(sheet)).toUpperCase();

        const offerRole = String(p.offer_role || "").trim() || existingOfferRole || roles;
        const managerName = String(p.manager_name || "").trim() || existingManager;
        const joiningDate = String(p.joining_date || "").trim() || existingJoiningDate;

        if (!offerRole) return respond_(e, { status: "error", message: "Missing offer_role" });
        if (!managerName) return respond_(e, { status: "error", message: "Missing manager_name" });
        if (!joiningDate) return respond_(e, { status: "error", message: "Missing joining_date" });

        sheet.getRange(rowNum, OFFER_LETTER_STATUS_COL).setValue(OFFER_LETTER_STATUS_DONE);
        sheet.getRange(rowNum, OFFER_LETTER_CODE_COL).setValue(certificateCode);
        sheet.getRange(rowNum, OFFER_LETTER_ISSUE_DATE_COL).setValue(issueDate);
        sheet.getRange(rowNum, OFFER_LETTER_GENERATED_AT_COL).setValue(new Date());
        sheet.getRange(rowNum, OFFER_LETTER_ROLE_COL).setValue(offerRole);
        sheet.getRange(rowNum, OFFER_LETTER_MANAGER_COL).setValue(managerName);
        sheet.getRange(rowNum, OFFER_LETTER_JOINING_DATE_COL).setValue(joiningDate);

        const verifyUrl = buildVerifyUrl_(certificateCode);
        const qrUrl = buildQrUrl_(verifyUrl);

        return respond_(e, {
          status: "success",
          data: {
            row_index: rowNum,
            certificate_code: certificateCode,
            issue_date: issueDate,
            offer_role: offerRole,
            manager_name: managerName,
            joining_date: joiningDate,
            verify_url: verifyUrl,
            qr_url: qrUrl,
            candidate: {
              first_name: firstName,
              last_name: lastName,
              email: email,
              phone: phone,
              roles: roles,
              department: dept,
            },
          },
        });
      } finally {
        try { lock.releaseLock(); } catch (_) {}
      }
    }

    if (action === "GET_OFFER_BY_QUERY") {
      const q = String(p.q || "").trim();
      ensureOfferLetterColumns_(sheet);
      if (!q) return respond_(e, { status: "success", data: [] });
      return respond_(e, { status: "success", data: searchOfferLetters_(sheet, q) });
    }

    // Public (no-auth) gates for index.html and public UI
    if (action === "GET_PUBLIC_FORM_GATES") {
      return respond_(e, { status: "success", gates: readFormGates_() });
    }

    // Public certificate verification page (used by QR codes)
    if (action === "VERIFY_CERT") {
      const code = String(p.code || "").trim().toUpperCase();
      ensureOfferLetterColumns_(sheet);
      if (!code) return createVerifyHtml_("Missing certificate code.", null);
      const found = findOfferByCode_(sheet, code);
      if (!found) return createVerifyHtml_("Certificate not found.", { ok: false, code: code });
      return createVerifyHtml_(null, { ok: true, code: code, record: found });
    }

    // Public JSON verification (used by career.tiesverse.com/verify page)
    if (action === "VERIFY_CERT_JSON") {
      const code = String(p.code || "").trim().toUpperCase();
      ensureOfferLetterColumns_(sheet);
      if (!code) return respond_(e, { status: "error", message: "Missing code" });
      const found = findOfferByCode_(sheet, code);
      if (!found) return respond_(e, { status: "success", ok: false, code: code });

      // Return a minimal public payload (avoid exposing contact details).
      return respond_(e, {
        status: "success",
        ok: true,
        code: code,
        record: {
          certificate_code: found.certificate_code,
          employee_name: `${String(found.first_name || "").trim()} ${String(found.last_name || "").trim()}`.trim(),
          offer_role: String(found.offer_role || found.roles || "").trim(),
          department: String(found.department || "").trim(),
          manager_name: String(found.manager_name || "").trim(),
          joining_date: String(found.joining_date || "").trim(),
          issue_date: String(found.issue_date || "").trim(),
          generated_at: found.generated_at || "",
        },
      });
    }

    if (action === "FORM_STATUS") {
      const dept = String(p.department || "").trim();
      const email = normalizeEmail_(p.email);
      const phone = normalizePhone_(p.phone);
      const open = dept ? isFormOpen_(dept) : true;
      const duplicate = dept ? hasRecentDuplicate_(sheet, dept, email, phone) : false;
      return respond_(e, { status: "success", open: open, duplicate: duplicate, department: dept });
    }

    if (action === "CHECK_REQUEST") {
      const requestId = String(p.request_id || "").trim();
      if (!requestId) return respond_(e, { status: "error", message: "Missing request_id" });
      const found = wasRequestRecorded_(sheet, requestId);
      return respond_(e, { status: "success", found: found });
    }

    return respond_(e, { status: "error", message: "Unknown action" });
  } catch (error) {
    return respond_(e, { status: "error", message: String(error) });
  }
}

/**
 * ROUTE: CREATE & UPDATE (POST)
 */
function doPost(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) return createJsonResponse({ status: "error", message: "Sheet not found" });

    const data = JSON.parse((e && e.postData && e.postData.contents) || "{}");

    if (data.action === "SET_FORM_GATES") {
      if (!validateAdminSession_(data.token)) return createJsonResponse({ status: "UNAUTHORIZED" });
      const normalized = normalizeGateHierarchy_(data.gates || {});
      writeFormGates_(normalized);
      try { syncFormGatesToCloudflare_(normalized); } catch (syncErr) { console.warn(syncErr); }
      return createJsonResponse({ status: "success" });
    }

    if (data.action === "MIGRATE_CLOUDFLARE_BATCH") {
      if (!validateAdminSession_(data.token)) return createJsonResponse({ status: "UNAUTHORIZED" });
      const limit = Math.max(1, Math.min(100, parseInt(data.limit || CLOUDFLARE_MIGRATION_BATCH_SIZE, 10) || CLOUDFLARE_MIGRATION_BATCH_SIZE));
      return createJsonResponse(migrateCloudflareBatch_(sheet, limit, data.reset === true));
    }

    if (data.action === "MIGRATE_CLOUDFLARE_ALL") {
      if (!validateAdminSession_(data.token)) return createJsonResponse({ status: "UNAUTHORIZED" });
      return createJsonResponse(startFullCloudflareMigration_());
    }

    if (data.action === "GET_CLOUDFLARE_MIGRATION_STATUS") {
      if (!validateAdminSession_(data.token)) return createJsonResponse({ status: "UNAUTHORIZED" });
      return createJsonResponse(getCloudflareMigrationStatus_());
    }

    // --- 1. ADMIN UPDATING AN INTERVIEW ---
    if (data.action === "UPDATE_ROW") {
      if (!validateAdminSession_(data.token)) return createJsonResponse({ status: "UNAUTHORIZED" });
      const rowNum = parseInt(data.row);
      sheet.getRange(rowNum, 15).setValue(data.interview_status);
      sheet.getRange(rowNum, 16).setValue(data.interviewer);
      sheet.getRange(rowNum, 17).setValue(data.rating);
      sheet.getRange(rowNum, 18).setValue(data.final_decision);

      // If a candidate is marked Selected, flag offer letter generation as Pending (unless already Done).
      try {
        ensureOfferLetterColumns_(sheet);
        const decision = String(data.final_decision || "").trim();
        if (decision === "Selected") {
          const existingStatus = String(sheet.getRange(rowNum, OFFER_LETTER_STATUS_COL).getValue() || "").trim();
          const existingCode = String(sheet.getRange(rowNum, OFFER_LETTER_CODE_COL).getValue() || "").trim();
          if (!existingCode && existingStatus !== OFFER_LETTER_STATUS_DONE) {
            sheet.getRange(rowNum, OFFER_LETTER_STATUS_COL).setValue(OFFER_LETTER_STATUS_PENDING);
          }
        }
      } catch (_) {}
      try { syncCandidateRowToCloudflare_(sheet, rowNum); } catch (syncErr) { console.warn(syncErr); }
      return createJsonResponse({ status: "success", message: "Updated" });
    }

    // --- 2. NEW CANDIDATE APPLYING ---
    if (data.action === "CREATE") {
      const dept = String(data.department || "").trim();
      const email = normalizeEmail_(data.email);
      const phone = normalizePhone_(data.phone);

      // Serialize CREATE to prevent accidental double-appends (double-clicks / retries).
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        if (dept && !isFormOpen_(dept)) return createJsonResponse({ status: "CLOSED" });
        if (dept && hasRecentDuplicate_(sheet, dept, email, phone)) return createJsonResponse({ status: "DUPLICATE_30D" });

        ensureRequestIdColumn_(sheet);
        const requestId =
          String(data.request_id || "").trim() ||
          ("req_" + new Date().getTime() + "_" + Math.random().toString(16).slice(2));

        // Idempotency: if the same request_id already exists, treat as success.
        if (wasRequestRecorded_(sheet, requestId)) return createJsonResponse({ status: "success" });

        let fileUrl = "No Resume Uploaded";
        if (data.resume_data && data.resume_name) {
          try {
            const base64Data = String(data.resume_data).split(",")[1] || data.resume_data;
            const decodedData = Utilities.base64Decode(base64Data);
            const fileName = sanitizeFilename_(
              `RESUME_${String(data.first_name || "")}_${String(data.last_name || "")}_${new Date().getTime()}.pdf`,
            );
            const blob = Utilities.newBlob(decodedData, "application/pdf", fileName);
            const folder = getOrCreateFolderByName_(RESUMES_FOLDER_NAME);
            const file = folder.createFile(blob);
            // Make the uploaded resume viewable by anyone with the link.
            file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
            fileUrl = file.getUrl();
          } catch (fErr) {
            fileUrl = "Upload Error: " + fErr.message;
          }
        }

        const formattedAnswers = stringifyAnswers_(data.answers);

        const nextId = sheet.getLastRow() + 1;
        const rowData = [
          new Date(),
          nextId,
          dept,
          String(data.roles || ""),
          String(data.first_name || ""),
          String(data.last_name || ""),
          String(data.email || ""),
          String(data.phone || ""),
          String(data.city || ""),
          String(data.linkedin || ""),
          String(data.portfolio || ""),
          String(data.why_join || ""),
          formattedAnswers,
          fileUrl,
          "Pending Setup",
          "",
          0,
          "Under Review",
          requestId,
        ];

        sheet.appendRow(rowData);
        try { syncCandidateRowToCloudflare_(sheet, sheet.getLastRow()); } catch (syncErr) { console.warn(syncErr); }

        // --- EMAIL NOTIFICATIONS ---
        sendCandidateEmail(String(data.email || ""), String(data.first_name || "Applicant"), String(data.roles || ""), dept);
        sendAdminAlert(String(data.first_name || ""), String(data.roles || ""), dept, fileUrl);

        return createJsonResponse({ status: "success" });
      } finally {
        try { lock.releaseLock(); } catch (_) {}
      }
    }

    return createJsonResponse({ status: "error", message: "Unknown action" });
  } catch (error) {
    return createJsonResponse({ status: "error", message: String(error) });
  }
}

/**
 * FIXED HELPER: Removed .setHeader() to prevent runtime crashes
 */
function createJsonResponse(output) {
  return ContentService.createTextOutput(JSON.stringify(output))
    .setMimeType(ContentService.MimeType.JSON);
}

function respond_(e, output) {
  const p = (e && e.parameter) || {};
  const cb = String(p.callback || "").trim();
  const json = JSON.stringify(output || {});
  if (cb && isValidJsonpCallback_(cb)) {
    return ContentService.createTextOutput(cb + "(" + json + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function isValidJsonpCallback_(cb) {
  return /^[a-zA-Z_$][0-9a-zA-Z_$]*(?:\.[0-9a-zA-Z_$]+)*$/.test(String(cb || ""));
}

function normalizeEmail_(v) {
  return String(v || "").trim().toLowerCase();
}

function normalizePhone_(v) {
  return String(v || "").replace(/[^\d+]/g, "");
}

function sanitizeFilename_(name) {
  const base = String(name || "").trim() || "file";
  return base.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120);
}

function getOrCreateFolderByName_(name) {
  const folderName = String(name || "").trim();
  if (!folderName) return DriveApp.getRootFolder();
  const it = DriveApp.getFoldersByName(folderName);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(folderName);
}

function stringifyAnswers_(answers) {
  try {
    if (!answers) return "";
    if (typeof answers === "string") return answers;
    if (Array.isArray(answers)) {
      let formatted = "";
      answers.forEach((item) => {
        formatted += `${item.q}\n-> ${item.a}\n\n`;
      });
      return formatted.trim();
    }
    return JSON.stringify(answers, null, 2);
  } catch (_) {
    return "";
  }
}

function ensureRequestIdColumn_(sheet) {
  try {
    sheet.getRange(1, REQUEST_ID_COL).setValue(REQUEST_ID_HEADER);
  } catch (_) {}
  return REQUEST_ID_COL;
}

function wasRequestRecorded_(sheet, requestId) {
  const col = ensureRequestIdColumn_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return false;

  const maxRowsToScan = 2000;
  const startRow = Math.max(2, lastRow - maxRowsToScan + 1);
  const numRows = lastRow - startRow + 1;
  const values = sheet.getRange(startRow, col, numRows, 1).getValues();
  const target = String(requestId || "").trim();
  for (let i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0] || "").trim() === target) return true;
  }
  return false;
}

function getConfigSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG_SHEET_NAME);
    sheet.appendRow(["postId", "open", "updatedAt"]);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(["postId", "open", "updatedAt"]);
  }
  return sheet;
}

function readFormGates_() {
  const sheet = getConfigSheet_();
  const lastRow = sheet.getLastRow();
  const gates = {};
  if (lastRow <= 1) return gates;

  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues(); // postId, open
  values.forEach((row) => {
    const postId = String(row[0] || "").trim();
    if (!postId) return;
    const v = row[1];
    if (v === false || String(v).toLowerCase() === "false") gates[postId] = false;
    else if (v === true || String(v).toLowerCase() === "true") gates[postId] = true;
  });
  return gates;
}

function writeFormGates_(gates) {
  const sheet = getConfigSheet_();
  const lastRow = sheet.getLastRow();
  const existing = {};
  if (lastRow > 1) {
    const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < values.length; i++) {
      const postId = String(values[i][0] || "").trim();
      if (postId) existing[postId] = i + 2; // row number
    }
  }

  const now = new Date();
  Object.keys(gates || {}).forEach((k) => {
    const postId = String(k || "").trim();
    if (!postId) return;
    const open = gates[k] === true;
    const rowNum = existing[postId];
    if (rowNum) sheet.getRange(rowNum, 2, 1, 2).setValues([[open, now]]);
    else sheet.appendRow([postId, open, now]);
  });
}

function isFormOpen_(postId) {
  const gates = readFormGates_();
  return gates[String(postId)] !== false;
}

function listCandidates_(sheet) {
  const data = sheet.getDataRange().getValues();
  const candidates = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[4] || row[6]) {
      candidates.push({
        row_index: i + 1,
        timestamp: row[0],
        id: row[1],
        department: row[2],
        roles: row[3],
        first_name: row[4],
        last_name: row[5],
        email: row[6],
        phone: row[7],
        city: row[8],
        linkedin: row[9],
        portfolio: row[10],
        why_join: row[11],
        answers: row[12],
        resume_link: row[13],
        interview_status: row[14] || "Pending Setup",
        interviewer: row[15] || "",
        rating: row[16] || 0,
        final_decision: row[17] || "Under Review",
        offer_letter_status: row[OFFER_LETTER_STATUS_COL - 1] || "",
        certificate_code: row[OFFER_LETTER_CODE_COL - 1] || "",
        offer_issue_date: row[OFFER_LETTER_ISSUE_DATE_COL - 1] || "",
        offer_generated_at: row[OFFER_LETTER_GENERATED_AT_COL - 1] || "",
        offer_role: row[OFFER_LETTER_ROLE_COL - 1] || "",
        offer_manager_name: row[OFFER_LETTER_MANAGER_COL - 1] || "",
        offer_joining_date: row[OFFER_LETTER_JOINING_DATE_COL - 1] || "",
      });
    }
  }
  return candidates;
}

function hasRecentDuplicate_(sheet, dept, email, phone) {
  const targetDept = String(dept || "").trim();
  if (!targetDept) return false;
  const targetEmail = normalizeEmail_(email);
  const targetPhone = normalizePhone_(phone);
  if (!targetEmail && !targetPhone) return false;

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return false;

  const maxRowsToScan = 5000;
  const startRow = Math.max(2, lastRow - maxRowsToScan + 1);
  const numRows = lastRow - startRow + 1;

  // Read: timestamp(A), department(C), email(G), phone(H)
  const values = sheet.getRange(startRow, 1, numRows, 8).getValues();
  const now = Date.now();

  for (let i = values.length - 1; i >= 0; i--) {
    const row = values[i];
    const ts = row[0];
    const tsMs = ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
    if (!tsMs) continue;
    if (now - tsMs > DEDUP_WINDOW_MS) break;

    const rowDept = String(row[2] || "").trim();
    if (rowDept !== targetDept) continue;

    const rowEmail = normalizeEmail_(row[6]);
    const rowPhone = normalizePhone_(row[7]);
    if (targetEmail && rowEmail && rowEmail === targetEmail) return true;
    if (targetPhone && rowPhone && rowPhone === targetPhone) return true;
  }

  return false;
}

function getScriptProp_(key) {
  return String(PropertiesService.getScriptProperties().getProperty(key) || "").trim();
}

function isCloudflareSyncEnabled_() {
  return getScriptProp_(CLOUDFLARE_SYNC_ENABLED_PROP).toLowerCase() === "true";
}

function requireScriptProp_(key) {
  const value = getScriptProp_(key);
  if (!value) throw new Error("Missing Apps Script property: " + key);
  return value;
}

function cloudflareD1Endpoint_() {
  return (
    "https://api.cloudflare.com/client/v4/accounts/" +
    encodeURIComponent(requireScriptProp_("CLOUDFLARE_ACCOUNT_ID")) +
    "/d1/database/" +
    encodeURIComponent(requireScriptProp_("CLOUDFLARE_D1_DATABASE_ID")) +
    "/query"
  );
}

function cloudflareD1Query_(sql, params) {
  const response = UrlFetchApp.fetch(cloudflareD1Endpoint_(), {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + requireScriptProp_("CLOUDFLARE_API_TOKEN") },
    payload: JSON.stringify({ sql: sql, params: params || [] }),
    muteHttpExceptions: true,
  });
  const text = response.getContentText();
  let parsed = {};
  try {
    parsed = JSON.parse(text || "{}");
  } catch (err) {
    throw new Error("Cloudflare D1 returned non-JSON: " + text.slice(0, 300));
  }
  if (response.getResponseCode() >= 300 || parsed.success !== true) {
    throw new Error("Cloudflare D1 error: " + text.slice(0, 800));
  }
  return parsed;
}

function cloudflareEnsureSchema_() {
  if (CLOUDFLARE_SCHEMA_READY) return;
  cloudflareD1Query_(
    "CREATE TABLE IF NOT EXISTS candidates (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, department TEXT NOT NULL DEFAULT '', " +
      "roles TEXT NOT NULL DEFAULT '', first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '', " +
      "email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', " +
      "linkedin TEXT NOT NULL DEFAULT '', portfolio TEXT NOT NULL DEFAULT '', why_join TEXT NOT NULL DEFAULT '', " +
      "answers TEXT NOT NULL DEFAULT '', resume_name TEXT NOT NULL DEFAULT '', resume_key TEXT NOT NULL DEFAULT '', " +
      "resume_content_type TEXT NOT NULL DEFAULT '', resume_data TEXT NOT NULL DEFAULT '', " +
      "interview_status TEXT NOT NULL DEFAULT 'Pending Setup', interviewer TEXT NOT NULL DEFAULT '', " +
      "rating INTEGER NOT NULL DEFAULT 0, final_decision TEXT NOT NULL DEFAULT 'Under Review', " +
      "request_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL" +
      ")",
    [],
  );
  cloudflareD1Query_("CREATE INDEX IF NOT EXISTS idx_candidates_request_id ON candidates (request_id)", []);
  cloudflareD1Query_("CREATE INDEX IF NOT EXISTS idx_candidates_email ON candidates (email)", []);
  cloudflareD1Query_(
    "CREATE TABLE IF NOT EXISTS form_gates (key TEXT PRIMARY KEY, is_open INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL)",
    [],
  );
  CLOUDFLARE_SCHEMA_READY = true;
}

function toIsoString_(value) {
  if (value instanceof Date) return value.toISOString();
  const text = String(value || "").trim();
  if (!text) return new Date().toISOString();
  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function parseIntSafe_(value) {
  const parsed = parseInt(String(value || "0"), 10);
  return isNaN(parsed) ? 0 : parsed;
}

function stableMigrationRequestId_(row, rowNum) {
  const existing = String(row[REQUEST_ID_COL - 1] || "").trim();
  if (existing) return existing;
  const oldId = String(row[1] || "").trim();
  if (oldId) return "migrated_" + sanitizeFilename_(oldId);
  const email = normalizeEmail_(row[6]);
  const phone = normalizePhone_(row[7]);
  const seed = [rowNum, toIsoString_(row[0]), email, phone].join("|");
  const digest = bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed)).slice(0, 16);
  return "migrated_" + digest;
}

function candidateFromSheetRow_(sheet, rowNum) {
  ensureRequestIdColumn_(sheet);
  const row = sheet.getRange(rowNum, 1, 1, Math.max(sheet.getLastColumn(), REQUEST_ID_COL)).getValues()[0] || [];
  const requestId = stableMigrationRequestId_(row, rowNum);
  if (!String(row[REQUEST_ID_COL - 1] || "").trim()) {
    sheet.getRange(rowNum, REQUEST_ID_COL).setValue(requestId);
  }
  return {
    timestamp: toIsoString_(row[0]),
    department: String(row[2] || ""),
    roles: String(row[3] || ""),
    first_name: String(row[4] || ""),
    last_name: String(row[5] || ""),
    email: String(row[6] || ""),
    phone: String(row[7] || ""),
    city: String(row[8] || ""),
    linkedin: String(row[9] || ""),
    portfolio: String(row[10] || ""),
    why_join: String(row[11] || ""),
    answers: String(row[12] || ""),
    resume_link: String(row[13] || ""),
    interview_status: String(row[14] || "Pending Setup"),
    interviewer: String(row[15] || ""),
    rating: parseIntSafe_(row[16]),
    final_decision: String(row[17] || "Under Review"),
    request_id: requestId,
  };
}

function syncCandidateRowToCloudflare_(sheet, rowNum) {
  if (!isCloudflareSyncEnabled_()) return { status: "skipped", reason: "Cloudflare sync disabled" };
  cloudflareEnsureSchema_();
  const candidate = candidateFromSheetRow_(sheet, rowNum);
  if (!candidate.email && !candidate.first_name) return { status: "skipped", reason: "empty row" };

  const resumeMeta = uploadSheetResumeToR2_(candidate);
  upsertCandidateToD1_(candidate, resumeMeta);
  return { status: "success", request_id: candidate.request_id };
}

function upsertCandidateToD1_(candidate, resumeMeta) {
  const now = new Date().toISOString();
  const params = [
    candidate.timestamp,
    candidate.department,
    candidate.roles,
    candidate.first_name,
    candidate.last_name,
    candidate.email,
    candidate.phone,
    candidate.city,
    candidate.linkedin,
    candidate.portfolio,
    candidate.why_join,
    candidate.answers,
    resumeMeta.name,
    resumeMeta.key,
    resumeMeta.contentType,
    "",
    candidate.interview_status,
    candidate.interviewer,
    candidate.rating,
    candidate.final_decision,
    candidate.request_id,
    candidate.timestamp,
    now,
  ];
  cloudflareD1Query_(
    "INSERT INTO candidates (" +
      "timestamp, department, roles, first_name, last_name, email, phone, city, linkedin, portfolio, why_join, answers, " +
      "resume_name, resume_key, resume_content_type, resume_data, interview_status, interviewer, rating, final_decision, " +
      "request_id, created_at, updated_at" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(request_id) DO UPDATE SET " +
      "timestamp=excluded.timestamp, department=excluded.department, roles=excluded.roles, first_name=excluded.first_name, " +
      "last_name=excluded.last_name, email=excluded.email, phone=excluded.phone, city=excluded.city, linkedin=excluded.linkedin, " +
      "portfolio=excluded.portfolio, why_join=excluded.why_join, answers=excluded.answers, resume_name=excluded.resume_name, " +
      "resume_key=excluded.resume_key, resume_content_type=excluded.resume_content_type, interview_status=excluded.interview_status, " +
      "interviewer=excluded.interviewer, rating=excluded.rating, final_decision=excluded.final_decision, updated_at=excluded.updated_at",
    params,
  );
}

function uploadSheetResumeToR2_(candidate) {
  const file = getDriveFileFromUrl_(candidate.resume_link);
  if (!file) return { name: "", key: "", contentType: "" };
  const blob = file.getBlob();
  const fileName = sanitizeFilename_(file.getName() || "resume");
  const contentType = blob.getContentType() || "application/octet-stream";
  const extension = fileName.indexOf(".") >= 0 ? "" : guessExtensionFromContentType_(contentType);
  const key = "resumes/migrated/" + candidate.request_id + "-" + fileName + extension;
  cloudflareR2PutObject_(key, blob.getBytes(), contentType);
  return { name: fileName + extension, key: key, contentType: contentType };
}

function getDriveFileFromUrl_(url) {
  const text = String(url || "").trim();
  if (!text || text.indexOf("drive.google.com") === -1) return null;
  let match = text.match(/[?&]id=([^&]+)/);
  if (!match) match = text.match(/\/d\/([^/]+)/);
  if (!match) return null;
  try {
    return DriveApp.getFileById(decodeURIComponent(match[1]));
  } catch (_) {
    return null;
  }
}

function guessExtensionFromContentType_(contentType) {
  const type = String(contentType || "").toLowerCase();
  if (type.indexOf("pdf") >= 0) return ".pdf";
  if (type.indexOf("wordprocessingml") >= 0) return ".docx";
  if (type.indexOf("msword") >= 0) return ".doc";
  return "";
}

function migrateCloudflareBatch_(sheet, limit, reset) {
  if (!isCloudflareSyncEnabled_()) return { status: "error", message: "Set CLOUDFLARE_SYNC_ENABLED=true first" };
  cloudflareEnsureSchema_();
  const props = PropertiesService.getScriptProperties();
  if (reset) props.deleteProperty(CLOUDFLARE_MIGRATION_CURSOR_PROP);

  const lastRow = sheet.getLastRow();
  let rowNum = parseInt(props.getProperty(CLOUDFLARE_MIGRATION_CURSOR_PROP) || "2", 10);
  if (!rowNum || rowNum < 2) rowNum = 2;

  let processed = 0;
  let synced = 0;
  let failed = 0;
  const errors = [];

  while (rowNum <= lastRow && processed < limit) {
    try {
      const result = syncCandidateRowToCloudflare_(sheet, rowNum);
      if (result && result.status === "success") synced += 1;
    } catch (err) {
      failed += 1;
      errors.push({ row: rowNum, message: String(err).slice(0, 300) });
    }
    processed += 1;
    rowNum += 1;
  }

  props.setProperty(CLOUDFLARE_MIGRATION_CURSOR_PROP, String(rowNum));
  syncFormGatesToCloudflare_(readFormGates_());
  const previousStatus = getCloudflareMigrationStatus_();
  writeCloudflareMigrationStatus_({
    running: rowNum <= lastRow,
    processed: parseInt(previousStatus.processed || "0", 10) + processed,
    synced: parseInt(previousStatus.synced || "0", 10) + synced,
    failed: parseInt(previousStatus.failed || "0", 10) + failed,
    errors: (previousStatus.errors || []).concat(errors).slice(-10),
    next_row: rowNum,
    total_rows: Math.max(0, lastRow - 1),
    done: rowNum > lastRow,
    updated_at: new Date().toISOString(),
  });

  return {
    status: "success",
    processed: processed,
    synced: synced,
    failed: failed,
    errors: errors,
    next_row: rowNum,
    done: rowNum > lastRow,
  };
}

function startCloudflareMigration() {
  return startFullCloudflareMigration_();
}

function startFullCloudflareMigration_() {
  if (!isCloudflareSyncEnabled_()) return { status: "error", message: "Set CLOUDFLARE_SYNC_ENABLED=true first" };
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(CLOUDFLARE_MIGRATION_CURSOR_PROP);
  props.setProperty(CLOUDFLARE_MIGRATION_RUNNING_PROP, "true");
  writeCloudflareMigrationStatus_({
    running: true,
    processed: 0,
    synced: 0,
    failed: 0,
    errors: [],
    next_row: 2,
    done: false,
    updated_at: new Date().toISOString(),
  });
  cloudflareEnsureSchema_();
  syncFormGatesToCloudflare_(readFormGates_());
  deleteCloudflareMigrationTriggers_();
  ScriptApp.newTrigger("continueCloudflareMigration").timeBased().after(1000).create();
  return { status: "success", message: "Full Cloudflare migration started", next_row: 2 };
}

function continueCloudflareMigration() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(CLOUDFLARE_MIGRATION_RUNNING_PROP) !== "true") {
    deleteCloudflareMigrationTriggers_();
    return;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error("Sheet not found: " + SHEET_NAME);

  const result = migrateCloudflareBatch_(sheet, CLOUDFLARE_MIGRATION_BATCH_SIZE, false);
  console.log(JSON.stringify(result));

  deleteCloudflareMigrationTriggers_();
  if (result.done) {
    props.deleteProperty(CLOUDFLARE_MIGRATION_RUNNING_PROP);
    return;
  }
  ScriptApp.newTrigger("continueCloudflareMigration").timeBased().after(60 * 1000).create();
}

function stopCloudflareMigration() {
  PropertiesService.getScriptProperties().deleteProperty(CLOUDFLARE_MIGRATION_RUNNING_PROP);
  const status = getCloudflareMigrationStatus_();
  status.running = false;
  status.stopped = true;
  status.updated_at = new Date().toISOString();
  writeCloudflareMigrationStatus_(status);
  deleteCloudflareMigrationTriggers_();
  return "Cloudflare migration stopped.";
}

function getCloudflareMigrationStatus() {
  const status = getCloudflareMigrationStatus_();
  const message =
    "Cloudflare migration status\n" +
    "Running: " + (status.running === true ? "yes" : "no") + "\n" +
    "Done: " + (status.done === true ? "yes" : "no") + "\n" +
    "Processed: " + (status.processed || 0) + " / " + (status.total_rows || "unknown") + "\n" +
    "Synced: " + (status.synced || 0) + "\n" +
    "Failed: " + (status.failed || 0) + "\n" +
    "Next row: " + (status.next_row || 2) + "\n" +
    "Updated: " + (status.updated_at || "not started") + "\n" +
    "Recent errors: " + JSON.stringify(status.errors || []);
  console.log(message);
  Logger.log(message);
  return message;
}

function getCloudflareMigrationStatus_() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(CLOUDFLARE_MIGRATION_STATUS_PROP);
  let status = {};
  try {
    status = raw ? JSON.parse(raw) : {};
  } catch (_) {
    status = {};
  }
  status.status = "success";
  status.running = props.getProperty(CLOUDFLARE_MIGRATION_RUNNING_PROP) === "true";
  status.next_row = parseInt(props.getProperty(CLOUDFLARE_MIGRATION_CURSOR_PROP) || status.next_row || "2", 10);
  return status;
}

function writeCloudflareMigrationStatus_(status) {
  PropertiesService.getScriptProperties().setProperty(CLOUDFLARE_MIGRATION_STATUS_PROP, JSON.stringify(status || {}));
}

function deleteCloudflareMigrationTriggers_() {
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction && trigger.getHandlerFunction() === "continueCloudflareMigration") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function syncFormGatesToCloudflare_(gates) {
  if (!isCloudflareSyncEnabled_()) return;
  cloudflareEnsureSchema_();
  const now = new Date().toISOString();
  Object.keys(gates || {}).forEach((key) => {
    cloudflareD1Query_(
      "INSERT INTO form_gates (key, is_open, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET is_open=excluded.is_open, updated_at=excluded.updated_at",
      [String(key), gates[key] === false ? 0 : 1, now],
    );
  });
}

function bytesToHex_(bytes) {
  return bytes
    .map((b) => {
      const value = b < 0 ? b + 256 : b;
      return ("0" + value.toString(16)).slice(-2);
    })
    .join("");
}

function hmacHex_(keyBytes, value) {
  return bytesToHex_(hmacBytes_(keyBytes, value));
}

function hmacBytes_(keyBytes, value) {
  const valueBytes = Array.isArray(value) ? value : Utilities.newBlob(String(value)).getBytes();
  return Utilities.computeHmacSha256Signature(valueBytes, keyBytes);
}

function awsUriEncode_(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function cloudflareR2PutObject_(key, bytes, contentType) {
  const accountId = requireScriptProp_("CLOUDFLARE_ACCOUNT_ID");
  const bucket = requireScriptProp_("CLOUDFLARE_R2_BUCKET");
  const accessKey = requireScriptProp_("CLOUDFLARE_R2_ACCESS_KEY_ID");
  const secretKey = requireScriptProp_("CLOUDFLARE_R2_SECRET_ACCESS_KEY");

  const now = new Date();
  const amzDate = Utilities.formatDate(now, "GMT", "yyyyMMdd'T'HHmmss'Z'");
  const dateStamp = Utilities.formatDate(now, "GMT", "yyyyMMdd");
  const host = accountId + ".r2.cloudflarestorage.com";
  const canonicalUri = "/" + awsUriEncode_(bucket) + "/" + String(key).split("/").map(awsUriEncode_).join("/");
  const payloadHash = bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
  const canonicalHeaders =
    "host:" + host + "\n" +
    "x-amz-content-sha256:" + payloadHash + "\n" +
    "x-amz-date:" + amzDate + "\n";
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = ["PUT", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = dateStamp + "/auto/s3/aws4_request";
  const stringToSign =
    "AWS4-HMAC-SHA256\n" +
    amzDate + "\n" +
    credentialScope + "\n" +
    bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, canonicalRequest));

  const kDate = hmacBytes_(Utilities.newBlob("AWS4" + secretKey).getBytes(), dateStamp);
  const kRegion = hmacBytes_(kDate, "auto");
  const kService = hmacBytes_(kRegion, "s3");
  const kSigning = hmacBytes_(kService, "aws4_request");
  const signature = hmacHex_(kSigning, stringToSign);
  const authorization =
    "AWS4-HMAC-SHA256 Credential=" + accessKey + "/" + credentialScope +
    ", SignedHeaders=" + signedHeaders +
    ", Signature=" + signature;

  const response = UrlFetchApp.fetch("https://" + host + canonicalUri, {
    method: "put",
    contentType: contentType || "application/octet-stream",
    payload: bytes,
    headers: {
      Authorization: authorization,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() >= 300) {
    throw new Error("Cloudflare R2 upload failed: " + response.getResponseCode() + " " + response.getContentText().slice(0, 500));
  }
}

function ensureOfferLetterColumns_(sheet) {
  try { sheet.getRange(1, OFFER_LETTER_STATUS_COL).setValue(OFFER_LETTER_STATUS_HEADER); } catch (_) {}
  try { sheet.getRange(1, OFFER_LETTER_CODE_COL).setValue(OFFER_LETTER_CODE_HEADER); } catch (_) {}
  try { sheet.getRange(1, OFFER_LETTER_ISSUE_DATE_COL).setValue(OFFER_LETTER_ISSUE_DATE_HEADER); } catch (_) {}
  try { sheet.getRange(1, OFFER_LETTER_GENERATED_AT_COL).setValue(OFFER_LETTER_GENERATED_AT_HEADER); } catch (_) {}
  try { sheet.getRange(1, OFFER_LETTER_ROLE_COL).setValue(OFFER_LETTER_ROLE_HEADER); } catch (_) {}
  try { sheet.getRange(1, OFFER_LETTER_MANAGER_COL).setValue(OFFER_LETTER_MANAGER_HEADER); } catch (_) {}
  try { sheet.getRange(1, OFFER_LETTER_JOINING_DATE_COL).setValue(OFFER_LETTER_JOINING_DATE_HEADER); } catch (_) {}
}

function formatIssueDate_(d) {
  const date = d instanceof Date ? d : new Date(d);
  const tz = Session.getScriptTimeZone();
  return Utilities.formatDate(date, tz, "dd MMM yyyy");
}

function buildVerifyUrl_(certificateCode) {
  const base = String(ScriptApp.getService().getUrl() || "").trim();
  if (!base) return "";
  return base + "?action=VERIFY_CERT&code=" + encodeURIComponent(String(certificateCode || "").trim().toUpperCase());
}

function buildQrUrl_(verifyUrl) {
  const url = String(verifyUrl || "").trim();
  if (!url) return "";
  const size = "220x220";
  return "https://chart.googleapis.com/chart?chs=" + size + "&cht=qr&chl=" + encodeURIComponent(url);
}

function generateCertificateCode_(sheet) {
  // 6-char alphanumeric, avoiding ambiguous characters (O/0, I/1).
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  ensureOfferLetterColumns_(sheet);

  const existing = {};
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const maxRowsToScan = 8000;
    const startRow = Math.max(2, lastRow - maxRowsToScan + 1);
    const numRows = lastRow - startRow + 1;
    const values = sheet.getRange(startRow, OFFER_LETTER_CODE_COL, numRows, 1).getValues();
    for (let i = 0; i < values.length; i++) {
      const v = String(values[i][0] || "").trim().toUpperCase();
      if (v) existing[v] = true;
    }
  }

  for (let attempt = 0; attempt < 50; attempt++) {
    let code = "";
    for (let i = 0; i < 6; i++) code += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    if (!existing[code]) return code;
  }

  // Very unlikely fallback.
  return Utilities.getUuid().replace(/-/g, "").slice(0, 6).toUpperCase();
}

function searchOfferLetters_(sheet, q) {
  const query = String(q || "").trim().toLowerCase();
  if (!query) return [];

  const out = [];
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return out;

  const data = sheet.getRange(2, 1, lastRow - 1, Math.max(sheet.getLastColumn(), OFFER_LETTER_JOINING_DATE_COL)).getValues();
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const status = String(row[OFFER_LETTER_STATUS_COL - 1] || "").trim();
    const code = String(row[OFFER_LETTER_CODE_COL - 1] || "").trim().toUpperCase();
    if (!code || status !== OFFER_LETTER_STATUS_DONE) continue;

    const fullName = `${String(row[4] || "").trim()} ${String(row[5] || "").trim()}`.trim();
    const email = String(row[6] || "").trim();
    const phone = String(row[7] || "").trim();

    const hay = [
      fullName.toLowerCase(),
      email.toLowerCase(),
      phone.toLowerCase(),
      code.toLowerCase(),
    ].join(" | ");

    if (hay.indexOf(query) === -1) continue;

    out.push({
      row_index: i + 2,
      id: row[1],
      department: row[2],
      roles: row[3],
      first_name: row[4],
      last_name: row[5],
      email: row[6],
      phone: row[7],
      certificate_code: code,
      issue_date: String(row[OFFER_LETTER_ISSUE_DATE_COL - 1] || "").trim(),
      offer_role: String(row[OFFER_LETTER_ROLE_COL - 1] || "").trim(),
      manager_name: String(row[OFFER_LETTER_MANAGER_COL - 1] || "").trim(),
      joining_date: String(row[OFFER_LETTER_JOINING_DATE_COL - 1] || "").trim(),
      generated_at: row[OFFER_LETTER_GENERATED_AT_COL - 1] || "",
      verify_url: buildVerifyUrl_(code),
      qr_url: buildQrUrl_(buildVerifyUrl_(code)),
    });
  }
  return out;
}

function findOfferByCode_(sheet, code) {
  const target = String(code || "").trim().toUpperCase();
  if (!target) return null;

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return null;

  const data = sheet.getRange(2, 1, lastRow - 1, Math.max(sheet.getLastColumn(), OFFER_LETTER_JOINING_DATE_COL)).getValues();
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const stored = String(row[OFFER_LETTER_CODE_COL - 1] || "").trim().toUpperCase();
    if (stored !== target) continue;
    return {
      row_index: i + 2,
      first_name: String(row[4] || "").trim(),
      last_name: String(row[5] || "").trim(),
      email: String(row[6] || "").trim(),
      phone: String(row[7] || "").trim(),
      roles: String(row[3] || "").trim(),
      department: String(row[2] || "").trim(),
      issue_date: String(row[OFFER_LETTER_ISSUE_DATE_COL - 1] || "").trim(),
      offer_role: String(row[OFFER_LETTER_ROLE_COL - 1] || "").trim(),
      manager_name: String(row[OFFER_LETTER_MANAGER_COL - 1] || "").trim(),
      joining_date: String(row[OFFER_LETTER_JOINING_DATE_COL - 1] || "").trim(),
      generated_at: row[OFFER_LETTER_GENERATED_AT_COL - 1] || "",
      status: String(row[OFFER_LETTER_STATUS_COL - 1] || "").trim(),
      certificate_code: stored,
    };
  }
  return null;
}

function createVerifyHtml_(errorMessage, payload) {
  const ok = payload && payload.ok === true;
  const record = payload && payload.record;
  const code = payload && payload.code ? String(payload.code) : "";

  const title = ok ? "Offer Letter Verified" : "Verification";
  const safeErr = errorMessage ? String(errorMessage) : "";

  const name = ok ? `${record.first_name || ""} ${record.last_name || ""}`.trim() : "";
  const role = ok ? String(record.roles || "") : "";
  const issueDate = ok ? String(record.issue_date || "") : "";
  const dept = ok ? String(record.department || "") : "";

  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          :root { --bg:#0a0a0a; --card:#111; --border:#222; --text:#fff; --muted:#9a9a9a; --accent:#fe7a00; --good:#25D366; --bad:#ff4444; }
          body { margin:0; font-family: Arial, sans-serif; background:var(--bg); color:var(--text); padding:22px; }
          .wrap { max-width: 780px; margin: 0 auto; }
          .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:18px; }
          .badge { display:inline-flex; align-items:center; gap:8px; font-weight:700; padding:8px 10px; border-radius:999px; border:1px solid var(--border); }
          .ok { color: var(--good); border-color: rgba(37,211,102,0.4); }
          .no { color: var(--bad); border-color: rgba(255,68,68,0.4); }
          .row { display:grid; grid-template-columns: 160px 1fr; gap:10px; margin-top:12px; }
          .k { color: var(--muted); font-size: 12px; }
          .v { font-size: 14px; word-break: break-word; }
          .code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 0.08em; }
          .sub { margin-top:8px; color: var(--muted); font-size: 12px; line-height: 1.5; }
          a { color: var(--accent); }
        </style>
      </head>
      <body>
        <div class="wrap">
          <div class="card">
            <div class="badge ${ok ? "ok" : "no"}">${ok ? "VALID" : "NOT FOUND"}</div>
            <div style="margin-top:10px; font-size:20px; font-weight:900;">${title}</div>
            <div class="sub">
              This page validates a Tiesverse offer letter/certificate code by matching it with the issuing database.
            </div>

            ${safeErr ? `<div class="sub" style="color:var(--bad); margin-top:10px;">${safeErr}</div>` : ""}

            <div class="row"><div class="k">Certificate Code</div><div class="v code">${code || ""}</div></div>
            ${ok ? `
              <div class="row"><div class="k">Candidate</div><div class="v">${name}</div></div>
              <div class="row"><div class="k">Role</div><div class="v">${role}</div></div>
              <div class="row"><div class="k">Department</div><div class="v">${dept}</div></div>
              <div class="row"><div class="k">Issue Date</div><div class="v">${issueDate}</div></div>
            ` : ""}

            <div class="sub" style="margin-top:14px;">
              Need help? Email <a href="mailto:hello@tiesverse.com">hello@tiesverse.com</a>.
            </div>
          </div>
        </div>
      </body>
    </html>
  `;

  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function sendCandidateEmail(targetEmail, firstName, roles, dept) {
  const subject = `Application Received: ${roles} | Tiesverse Foundation`;
  const htmlBody = `
    <div style="font-family: sans-serif; max-width: 600px; color: #111;">
      <h2 style="color: #fe7a00;">Hi ${firstName},</h2>
      <p>Your application for <b>${roles}</b> (${dept}) has been successfully submitted.</p>
      
      <div style="background: #fdf2e9; border: 1px solid #fe7a00; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <h3 style="margin-top: 0; color: #fe7a00;">⚠️ ACTION REQUIRED</h3>
        <p>Shortlisting updates, test tasks, and interview links are shared <b>only</b> via our WhatsApp community.</p>
        <a href="https://chat.whatsapp.com/CvRuM20vyEW25QV3iWqE6y" 
           style="display: inline-block; background: #25D366; color: #fff; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">
           Join WhatsApp Community Group
        </a>
      </div>

      <p style="font-size: 13px; color: #666;">Note: This is a 3-month unpaid internship focused on learning and portfolio building.</p>
      <p>Best regards,<br><b>Tiesverse HR Team</b></p>
    </div>`;

  MailApp.sendEmail({ to: targetEmail, subject: subject, htmlBody: htmlBody });
}

function sendAdminAlert(name, role, dept, resume) {
  const subject = `🚨 New Application: ${name} (${role})`;
  const body = `New candidate applied.\n\nName: ${name}\nRole: ${role}\nDept: ${dept}\nResume: ${resume}\n\nCheck Admin Panel: [Your_Admin_Panel_Link_Here]`;
  MailApp.sendEmail(ADMIN_EMAIL, subject, body);
}
