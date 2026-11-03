/**
 * Real-time lead submission, run from inside your Google Sheet (works with Joveo's Google restrictions:
 * it only makes outbound calls to GitHub, nothing public is exposed).
 *
 *   New lead row lands in "Leads"  ->  this script tells GitHub  ->  GitHub submits it on the landing page
 *   ->  results come back  ->  "Results" tab + the Status column in "Leads" update.
 *
 * Setup (one time):
 *  1. Extensions > Apps Script, paste this file, edit CFG below, Save.
 *  2. Project Settings (gear) > Script properties > Add: GITHUB_TOKEN = your GitHub token (see README).
 *  3. Run setup() once and approve the permissions. Done.
 */
const CFG = {
  LEADS_TAB: 'Leads',            // tab where new leads arrive; headers in row 1
  RESULTS_TAB: 'Results',        // created automatically
  STATUS_HEADER: 'Status',       // added automatically if missing
  GITHUB_OWNER: 'ishasingh5823',
  GITHUB_REPO: 'Auto-Leads-Submit',
  BATCH: 20,                     // max leads sent to GitHub at once
  RETRY_AFTER_MIN: 10,           // a lead still "Queued" after this long is sent again (the agent never double-submits)
};

// ---------- one-time setup ----------
function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  const ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('onSheetChange').forSpreadsheet(ss).onChange().create();      // fires when a lead row is added
  ScriptApp.newTrigger('syncResults').timeBased().everyMinutes(1).create();           // pulls results back every minute
  ScriptApp.newTrigger('dispatchPending').timeBased().everyMinutes(5).create();       // safety net: sweeps missed rows
  dispatchPending();
  syncResults();
}

function onSheetChange() { dispatchPending(); }

// ---------- helpers ----------
const norm_ = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function token_() {
  const t = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!t) throw new Error('Add GITHUB_TOKEN in Project Settings > Script properties');
  return t;
}
function gh_(path, opts) {
  const o = Object.assign({ method: 'get', muteHttpExceptions: true, headers: {} }, opts || {});
  o.headers = Object.assign({ Authorization: 'Bearer ' + token_(), 'X-GitHub-Api-Version': '2022-11-28',
    Accept: 'application/vnd.github+json', 'User-Agent': 'leads-realtime' }, o.headers);
  return UrlFetchApp.fetch('https://api.github.com/repos/' + CFG.GITHUB_OWNER + '/' + CFG.GITHUB_REPO + path, o);
}
function note_(msg) {   // shows the last problem at the top of the Results tab so it is visible
  PropertiesService.getScriptProperties().setProperty('LAST_NOTE', new Date().toISOString() + ' ' + msg);
}
function emailCol_(head) { return head.findIndex(h => ['email', 'email address', 'e mail'].includes(norm_(h))); }
function phoneCol_(head) { return head.findIndex(h => ['phone', 'phone number', 'mobile', 'mobile number'].includes(norm_(h))); }
function keyOf_(row, head) {
  const e = emailCol_(head), p = phoneCol_(head);
  return String((e >= 0 && row[e]) || (p >= 0 ? String(row[p]).replace(/^p:/i, '') : '')).trim().toLowerCase();
}

// ---------- 1. send new leads to GitHub ----------
function dispatchPending() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(CFG.LEADS_TAB);
    if (!sh) { note_('No tab named ' + CFG.LEADS_TAB); return; }
    const values = sh.getDataRange().getDisplayValues();
    if (values.length < 2) return;
    const head = values[0].map(h => String(h).trim());
    let sCol = head.indexOf(CFG.STATUS_HEADER);
    if (sCol < 0) { sCol = head.length; head.push(CFG.STATUS_HEADER); sh.getRange(1, sCol + 1).setValue(CFG.STATUS_HEADER); }
    const now = Date.now(), leads = [], rowsSent = [];
    for (let r = 1; r < values.length && leads.length < CFG.BATCH; r++) {
      const row = values[r];
      if (!keyOf_(row, head)) continue;
      const st = String(row[sCol] || '').trim();
      let eligible = st === '';
      if (/^Queued /.test(st)) eligible = now - new Date(st.slice(7)).getTime() > CFG.RETRY_AFTER_MIN * 60000;
      if (!eligible) continue;
      const data = {};
      head.forEach((h, i) => { if (h && h !== CFG.STATUS_HEADER) data[h] = String(row[i] === undefined ? '' : row[i]).trim(); });
      leads.push({ row: r + 1, data });
      rowsSent.push(r + 1);
    }
    if (!leads.length) return;
    const res = gh_('/dispatches', { method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ event_type: 'new-leads', client_payload: { leads } }) });
    const code = res.getResponseCode();
    if (code === 204) {
      const stamp = 'Queued ' + new Date().toISOString();
      rowsSent.forEach(r => sh.getRange(r, sCol + 1).setValue(stamp));
      note_('Sent ' + leads.length + ' lead(s) to GitHub');
    } else {
      note_('GitHub refused the request (HTTP ' + code + '): ' + String(res.getContentText()).slice(0, 120));
    }
  } finally { lock.releaseLock(); }
}

// ---------- 2. bring results back ----------
function syncResults() {
  const res = gh_('/contents/results.csv', { headers: { Accept: 'application/vnd.github.raw+json' } });
  const code = res.getResponseCode();
  if (code === 404) { writeResults_([], null); return; }
  if (code !== 200) { note_('Could not read results (HTTP ' + code + ')'); writeResults_(null, null); return; }
  const rows = Utilities.parseCsv(res.getContentText());
  const results = rows.slice(1).filter(r => r[0]).map(r => ({ key: r[0], row: r[1], status: r[2], at: r[3] }));
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(CFG.LEADS_TAB);
  const info = {};
  if (sh && sh.getLastRow() > 1) {
    const values = sh.getDataRange().getDisplayValues();
    const head = values[0].map(h => String(h).trim());
    const sCol = head.indexOf(CFG.STATUS_HEADER);
    const fCol = head.findIndex(h => ['first name', 'full name', 'name'].includes(norm_(h)));
    const lCol = head.findIndex(h => norm_(h) === 'last name');
    const byKey = {};
    for (let r = 1; r < values.length; r++) { const k = keyOf_(values[r], head); if (k) byKey[k] = r; }
    if (sCol >= 0) {
      const statusCol = values.slice(1).map(r => [r[sCol]]);
      let changed = false;
      results.forEach(x => {
        const r = byKey[x.key];
        if (r === undefined) return;
        info[x.key] = { name: [fCol >= 0 ? values[r][fCol] : '', lCol >= 0 ? values[r][lCol] : ''].join(' ').trim(), row: r + 1 };
        const cur = String(statusCol[r - 1][0] || '').trim();
        if (cur === '' || /^Queued /.test(cur)) { statusCol[r - 1][0] = x.status; changed = true; }
      });
      if (changed) sh.getRange(2, sCol + 1, statusCol.length, 1).setValues(statusCol);
    }
  }
  writeResults_(results, info);
}

function writeResults_(results, info) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(CFG.RESULTS_TAB);
  if (!sh) { sh = ss.insertSheet(CFG.RESULTS_TAB); }
  const note = PropertiesService.getScriptProperties().getProperty('LAST_NOTE') || '';
  sh.getRange(1, 1).setValue('Last sync: ' + new Date().toLocaleString() + (note ? '   |   ' + note : ''));
  if (results === null) return;
  const out = [['Updated at', 'Result', 'Detail', 'Email / phone', 'Name', 'Lead row']];
  results.slice().reverse().forEach(x => {
    const ok = /^Submitted/.test(x.status);
    const i = (info && info[x.key]) || {};
    out.push([x.at, ok ? 'Submitted' : 'Failed', ok ? x.status.replace(/^Submitted\s*/, '') : x.status.replace(/^Failed:\s*/, ''),
      x.key, i.name || '', i.row || x.row]);
  });
  sh.getRange(3, 1, Math.max(sh.getMaxRows() - 2, 1), 6).clearContent();
  if (sh.getMaxRows() < out.length + 2) sh.insertRowsAfter(sh.getMaxRows(), out.length + 2 - sh.getMaxRows());
  sh.getRange(3, 1, out.length, 6).setValues(out);
  sh.getRange(3, 1, 1, 6).setFontWeight('bold').setBackground('#1F3864').setFontColor('#FFFFFF');
  sh.setFrozenRows(3);
  sh.autoResizeColumns(1, 6);
}
