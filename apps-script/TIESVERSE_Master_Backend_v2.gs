const RESUMES_FOLDER_NAME = "TV_Resumes";
const SHEET_NAME = "Master"; 
const ADMIN_EMAIL = "theindianequation@gmail.com"; 
const CONFIG_SHEET_NAME = "TV_Config";
const DEDUP_WINDOW_DAYS = 30;
const DEDUP_WINDOW_MS = DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const REQUEST_ID_HEADER = "request_id";
const REQUEST_ID_COL = 19;

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

    if (action === "GET_CANDIDATES") {
      return respond_(e, { status: "success", data: listCandidates_(sheet) });
    }

    if (action === "GET_FORM_GATES") {
      return respond_(e, { status: "success", gates: readFormGates_() });
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
      writeFormGates_(data.gates || {});
      return createJsonResponse({ status: "success" });
    }

    // --- 1. ADMIN UPDATING AN INTERVIEW ---
    if (data.action === "UPDATE_ROW") {
      const rowNum = parseInt(data.row);
      sheet.getRange(rowNum, 15).setValue(data.interview_status);
      sheet.getRange(rowNum, 16).setValue(data.interviewer);
      sheet.getRange(rowNum, 17).setValue(data.rating);
      sheet.getRange(rowNum, 18).setValue(data.final_decision);
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
            fileUrl = folder.createFile(blob).getUrl();
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
