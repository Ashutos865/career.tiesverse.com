/**
 * TIESVERSE Master Backend v2.1
 * - Form gates (open/close) stored in Script Properties
 * - 30-day per-post dedup (email/phone) stored in Script Properties
 */

const ADMIN_KEY_PROP = "TV_ADMIN_KEY_V1";
const FORM_GATE_PROP_PREFIX = "TV_FORM_OPEN_V1:"; // TV_FORM_OPEN_V1:<postId> => "true"/"false"
const DEDUP_PROP_PREFIX = "TV_APPLY_30D_V1:"; // TV_APPLY_30D_V1:<postId>:<hash> => lastTsMs
const DEDUP_WINDOW_DAYS = 30;
const DEDUP_WINDOW_MS = DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000;

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // Admin: update form gates
    if (data.action === "SET_FORM_GATES") {
      return handleSetFormGates_(data);
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // Normalize sheetName from incoming payload
    let sheetName = data.sheetName;
    if (data.type === "YOUTUBE") sheetName = "YouTube_Recruitment";
    if (!sheetName) sheetName = "General_Recruitment";

    // Global open/close gate per "post"
    const postId = data.postId || sheetName;
    if (!isFormOpen_(postId)) {
      return text_("CLOSED");
    }

    // 30-day dedup per post (email/phone)
    const email = normalizeEmail_(data.email);
    const phone = normalizePhone_(data.phone);
    const dedup = checkDedup_(postId, email, phone);
    if (!dedup.ok) {
      return text_("DUPLICATE_30D");
    }

    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      if (sheetName === "YouTube_Recruitment") {
        const newSheet = ss.insertSheet("YouTube_Recruitment");
        newSheet.appendRow([
          "Timestamp",
          "Full Name",
          "Age",
          "Email",
          "Phone",
          "Selected Roles",
          "Portfolio Links",
          "Software Proficiency",
          "Experience Level",
        ]);
        const res = processRow_(newSheet, data, sheetName);
        markDedup_(postId, email, phone);
        return res;
      }
      return text_("Error: Tab '" + sheetName + "' not found.");
    }

    const res = processRow_(sheet, data, sheetName);
    markDedup_(postId, email, phone);
    return res;
  } catch (error) {
    console.error("Backend Error: " + error);
    return text_("Backend Error: " + error);
  }
}

function processRow_(sheet, data, sheetName) {
  let row = [new Date()]; // Timestamp first

  if (sheetName === "Tech_Data") {
    row.push(
      data.tracks,
      data.name,
      data.age,
      data.email,
      data.phone,
      data.repo,
      data.hasExp,
      data.stack,
      data.source,
    );
  } else if (sheetName === "HR_Data") {
    row.push(
      data.name,
      data.email,
      data.phone,
      data.location,
      data.dob,
      data.hr_exp,
      data.english,
      data.domains,
      data.discipline,
      data.leadership,
      data.tasks,
      data.linkedin,
    );
  } else if (sheetName === "YouTube_Recruitment") {
    row.push(
      data.name,
      data.age,
      data.email,
      data.phone,
      data.roles,
      data.portfolio,
      data.software,
      data.experience,
    );
  } else {
    row.push(
      data.roles,
      data.name,
      data.age,
      data.email,
      data.phone,
      data.experience,
      data.work_history,
      data.linkedin,
      data.source,
    );
  }

  sheet.appendRow(row);

  data.sheetName = sheetName;
  sendConfirmationEmail_(data);
  return text_("Success");
}

function sendConfirmationEmail_(data) {
  const recipient = data.email;
  const name = data.name || "Applicant";

  let entity = (data.sheetName || "TIES")
    .replace("_Data", "")
    .replace("_Recruitment", "")
    .replace("_", " ");
  if (entity === "YouTube") entity = "YouTube Management";

  const alias = "hello@career.tiesverse.com";
  const whatsappLink = "https://chat.whatsapp.com/CvRuM20vyEW25QV3iWqE6y";
  const subject = `Application Received | TIESVERSE 2026 - ${entity}`;

  const htmlBody = `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; color: #1e293b; background-color: #f8fafc; border-radius: 20px;">
      <div style="text-align: center; padding: 10px 0;">
        <h1 style="color: #0f172a; margin: 0; font-size: 24px;">TIESVERSE 2026</h1>
        <p style="color: #6366f1; font-weight: bold; text-transform: uppercase; font-size: 12px;">Recruitment Cloud</p>
      </div>
      <div style="background-color: #ffffff; padding: 30px; border-radius: 16px; border: 1px solid #e2e8f0;">
        <h2 style="color: #0f172a; font-size: 20px;">Hello ${name},</h2>
        <p style="line-height: 1.6; color: #475569;">
          Your application for <strong>${entity}</strong> has been received. Our team is reviewing your submission.
        </p>
        <div style="margin: 25px 0; padding: 20px; background-color: #f1f5f9; border-radius: 12px; border-left: 4px solid #6366f1;">
          <h3 style="margin-top: 0; font-size: 14px; color: #0f172a;">NEXT STEP:</h3>
          <p style="font-size: 13px; color: #475569; margin-bottom: 15px;">
            Join the <strong>Recruitment Hub</strong> on WhatsApp for interview schedules and updates.
          </p>
          <a href="${whatsappLink}" style="display: inline-block; background-color: #25D366; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 10px; font-weight: bold;">Join WhatsApp Community</a>
        </div>
        <p style="font-size: 13px; color: #64748b;">
          Expected review timeline: <strong>48 - 72 Hours</strong>.
        </p>
      </div>
      <div style="text-align: center; padding: 20px; color: #94a3b8; font-size: 11px;">
        <p>&copy; 2026 TIES India | Youth-Led Think Tank</p>
      </div>
    </div>
  `;

  try {
    GmailApp.sendEmail(recipient, subject, "", {
      htmlBody,
      name: "TIESVERSE Board",
      from: alias,
      replyTo: alias,
    });
  } catch (e) {
    console.error("Alias send failed, attempting fallback: " + e.toString());
    GmailApp.sendEmail(
      recipient,
      subject,
      "Application confirmed. Please join the WhatsApp link in your previous emails.",
      { htmlBody, name: "TIESVERSE Board" },
    );
  }
}

function handleSetFormGates_(data) {
  const adminKey = String(data.admin_key || "").trim();
  const expected = PropertiesService.getScriptProperties().getProperty(ADMIN_KEY_PROP) || "";
  if (!expected || adminKey !== expected) {
    return text_("UNAUTHORIZED");
  }

  const gates = data.gates || {};
  Object.keys(gates).forEach((k) => {
    const postId = String(k || "").trim();
    if (!postId) return;
    const open = gates[k] === true;
    PropertiesService.getScriptProperties().setProperty(
      FORM_GATE_PROP_PREFIX + postId,
      open ? "true" : "false",
    );
  });

  return text_("OK");
}

function isFormOpen_(postId) {
  const v = PropertiesService.getScriptProperties().getProperty(FORM_GATE_PROP_PREFIX + postId);
  return v !== "false";
}

function checkDedup_(postId, email, phone) {
  const now = Date.now();
  const props = PropertiesService.getScriptProperties();
  const keys = [];
  if (email) keys.push(dedupKey_(postId, "e:" + email));
  if (phone) keys.push(dedupKey_(postId, "p:" + phone));

  for (const k of keys) {
    const raw = props.getProperty(k);
    if (!raw) continue;
    const last = Number(raw);
    if (last && now - last < DEDUP_WINDOW_MS) return { ok: false };
  }
  return { ok: true, keys };
}

function markDedup_(postId, email, phone) {
  const now = String(Date.now());
  const props = PropertiesService.getScriptProperties();
  if (email) props.setProperty(dedupKey_(postId, "e:" + email), now);
  if (phone) props.setProperty(dedupKey_(postId, "p:" + phone), now);
}

function dedupKey_(postId, identifier) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, identifier, Utilities.Charset.UTF_8);
  const hex = digest
    .map((b) => (b < 0 ? b + 256 : b).toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
  return DEDUP_PROP_PREFIX + String(postId) + ":" + hex;
}

function normalizeEmail_(v) {
  return String(v || "").trim().toLowerCase();
}

function normalizePhone_(v) {
  return String(v || "").replace(/[^\d+]/g, "");
}

function text_(s) {
  return ContentService.createTextOutput(String(s)).setMimeType(ContentService.MimeType.TEXT);
}

function checkMyQuota() {
  var remaining = MailApp.getRemainingDailyQuota();
  Logger.log("You can still send " + remaining + " emails today.");
}

