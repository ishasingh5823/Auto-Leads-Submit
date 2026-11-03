/**
 * Lead bridge: paste into Google Sheet -> Extensions -> Apps Script.
 * Tabs used:
 *   "Leads"   (input)  headers: first_name,last_name,email,phone,city,slot,Status
 *   "Signups" (output) auto-created; every landing-page registration is appended here
 * Deploy: Deploy -> New deployment -> Web app -> Execute as: Me, Who has access: Anyone -> copy the URL.
 */
const TOKEN = 'CHANGE-ME-to-a-long-random-string';   // the cloud agent must send this; keep it secret
const LEADS_TAB = 'Leads';
const SIGNUPS_TAB = 'Signups';
const STATUS_HEADER = 'Status';
const SIGNUP_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'city', 'slot'];

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// ---- Landing page signups (public) and agent status updates (token) arrive here ----
function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad json' }); }
  if (d.action === 'status') {
    if (d.token !== TOKEN) return out({ ok: false, error: 'unauthorized' });
    setStatus_(Number(d.row), String(d.status || ''));
    return out({ ok: true });
  }
  return saveSignup_(d);
}

// ---- Agent asks for pending leads here (token) ----
function doGet(e) {
  const p = e.parameter || {};
  if (p.action === 'pending') {
    if (p.token !== TOKEN) return out({ ok: false, error: 'unauthorized' });
    return out({ ok: true, leads: claimPending_(Math.min(Number(p.limit) || 20, 100)) });
  }
  return out({ ok: true, service: 'lead bridge' });
}

function saveSignup_(d) {
  if (!d.email) return out({ ok: false, error: 'email required' });
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName(SIGNUPS_TAB);
    if (!sh) {
      sh = ss.insertSheet(SIGNUPS_TAB);
      sh.appendRow(['received_at'].concat(SIGNUP_FIELDS));
      sh.setFrozenRows(1);
    }
    sh.appendRow([new Date()].concat(SIGNUP_FIELDS.map(f => String(d[f] || ''))));
    return out({ ok: true });
  } finally { lock.releaseLock(); }
}

// Returns rows whose Status is blank, and marks them "Processing" so two runs never take the same row.
function claimPending_(limit) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(LEADS_TAB);
    const values = sh.getDataRange().getValues();
    const head = values[0].map(h => String(h).trim());
    let sCol = head.indexOf(STATUS_HEADER);
    if (sCol < 0) { sCol = head.length; head.push(STATUS_HEADER); sh.getRange(1, sCol + 1).setValue(STATUS_HEADER); }
    const leads = [];
    for (let r = 1; r < values.length && leads.length < limit; r++) {
      const row = values[r];
      if (!row.some(c => String(c).trim() !== '')) continue;
      if (String(row[sCol] || '').trim() !== '') continue;
      const rec = {};
      head.forEach((h, i) => { if (h !== STATUS_HEADER) rec[h] = String(row[i] === undefined ? '' : row[i]).trim(); });
      leads.push({ row: r + 1, data: rec });
      sh.getRange(r + 1, sCol + 1).setValue('Processing');
    }
    return leads;
  } finally { lock.releaseLock(); }
}

function setStatus_(row, status) {
  const sh = SpreadsheetApp.getActive().getSheetByName(LEADS_TAB);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const sCol = head.indexOf(STATUS_HEADER);
  if (sCol >= 0 && row > 1) sh.getRange(row, sCol + 1).setValue(status);
}
