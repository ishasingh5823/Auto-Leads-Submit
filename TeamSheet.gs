/**
 * Lead Agent for a Google Sheet. One copy of this sheet = one campaign.
 *
 * Teammate steps (about 2 minutes):
 *   1. Settings tab: type the campaign name and the landing page URL.
 *   2. Menu "Lead Agent" > Connect to GitHub (paste the team token once).
 *   3. Menu "Lead Agent" > Start.
 * After that, every new row in the Leads tab is submitted on the landing page within a few minutes,
 * and the Results tab and the Status column show what happened.
 *
 * Admin (once, in the template): paste this file in Extensions > Apps Script and set GITHUB_OWNER / GITHUB_REPO.
 */
const CFG = {
  GITHUB_OWNER: 'ishasingh5823',     // the GitHub account or organisation that holds the engine
  GITHUB_REPO: 'Auto-Leads-Submit',
  LEADS_TAB: 'Leads',                // new leads arrive here; headers in row 1
  RESULTS_TAB: 'Results',
  SETTINGS_TAB: 'Settings',
  STATUS_HEADER: 'Status',
  BATCH: 20,                         // max leads sent at once
  RETRY_AFTER_MIN: 10,               // a lead still "Queued" after this long is sent again (the engine never double-submits)
};

// ---------- menu ----------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Lead Agent')
    .addItem('1. Connect to GitHub', 'connect')
    .addItem('2. Start', 'start')
    .addSeparator()
    .addItem('Send new leads now', 'dispatchPending')
    .addItem('Check status', 'checkStatus')
    .addItem('Pause', 'pause')
    .addToUi();
  settingsSheet_();
}

// ---------- helpers ----------
const norm_ = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const slug_ = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
function ui_() { try { return SpreadsheetApp.getUi(); } catch (e) { return null; } }
function say_(title, msg) { const u = ui_(); if (u) u.alert(title, msg, u.ButtonSet.OK); else Logger.log(title + ': ' + msg); }
function props_() { return PropertiesService.getScriptProperties(); }
function token_() { return props_().getProperty('GITHUB_TOKEN'); }

function settingsSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(CFG.SETTINGS_TAB);
  if (!sh) {
    sh = ss.insertSheet(CFG.SETTINGS_TAB);   // added after the Leads tab so Leads stays the first tab
    sh.getRange('A1:B3').setValues([['Campaign name', ''], ['Landing page URL', ''], ['Agent status', 'Not started']]);
    sh.getRange('A5').setValue('How to use: fill in the two yellow cells, then use the Lead Agent menu: Connect to GitHub, then Start.');
    sh.getRange('A6').setValue('New leads go in the Leads tab (headers in row 1). Results appear in the Results tab and in the Status column.');
    sh.getRange('A1:A3').setFontWeight('bold');
    sh.getRange('B1:B2').setBackground('#FFF2CC');
    sh.setColumnWidth(1, 160); sh.setColumnWidth(2, 460);
  }
  return sh;
}
function readSettings_() {
  const sh = settingsSheet_();
  return { campaign: String(sh.getRange('B1').getDisplayValue()).trim(), pageUrl: String(sh.getRange('B2').getDisplayValue()).trim() };
}
function setAgentStatus_(text) { settingsSheet_().getRange('B3').setValue(text); }
function isRunning_() { return props_().getProperty('RUNNING') === '1'; }

function gh_(path, opts) {
  const o = Object.assign({ method: 'get', muteHttpExceptions: true, headers: {} }, opts || {});
  o.headers = Object.assign({ Authorization: 'Bearer ' + token_(), 'X-GitHub-Api-Version': '2022-11-28',
    Accept: 'application/vnd.github+json', 'User-Agent': 'lead-agent-sheet' }, o.headers);
  return UrlFetchApp.fetch('https://api.github.com/repos/' + CFG.GITHUB_OWNER + '/' + CFG.GITHUB_REPO + path, o);
}
function note_(msg) { props_().setProperty('LAST_NOTE', new Date().toISOString() + ' ' + msg); }
function emailCol_(head) { return head.findIndex(h => ['email', 'email address', 'e mail'].includes(norm_(h))); }
function phoneCol_(head) { return head.findIndex(h => ['phone', 'phone number', 'mobile', 'mobile number'].includes(norm_(h))); }
function keyOf_(row, head) {
  const e = emailCol_(head), p = phoneCol_(head);
  return String((e >= 0 && row[e]) || (p >= 0 ? String(row[p]).replace(/^p:/i, '') : '')).trim().toLowerCase();
}

// ---------- menu actions ----------
function connect() {
  const u = SpreadsheetApp.getUi();
  const r = u.prompt('Connect to GitHub', 'Paste the team token your admin gave you:', u.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== u.Button.OK) return;
  const t = r.getResponseText().trim();
  if (!t) return;
  props_().setProperty('GITHUB_TOKEN', t);
  const res = gh_('');
  const code = res.getResponseCode();
  if (code === 200) say_('Connected', 'Connected to GitHub. Next: Lead Agent > Start.');
  else { props_().deleteProperty('GITHUB_TOKEN'); say_('Could not connect', 'GitHub said HTTP ' + code + '. Check that you pasted the whole token, then try again.'); }
}

function start() {
  const s = readSettings_(), problems = [];
  if (!s.campaign) problems.push('Type a campaign name in the Settings tab (B1).');
  if (!/^https?:\/\/.+/i.test(s.pageUrl)) problems.push('Type the landing page URL in the Settings tab (B2). It must start with https://');
  if (!token_()) problems.push('Use Lead Agent > Connect to GitHub first.');
  if (!SpreadsheetApp.getActive().getSheetByName(CFG.LEADS_TAB)) problems.push('Add a tab named ' + CFG.LEADS_TAB + ' with the lead columns in row 1.');
  if (problems.length) { say_('Not started', problems.join('\n')); return; }
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onSheetChange').forSpreadsheet(SpreadsheetApp.getActive()).onChange().create();
  ScriptApp.newTrigger('syncResults').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('dispatchPending').timeBased().everyMinutes(5).create();
  props_().setProperty('RUNNING', '1');
  setAgentStatus_('Running');
  dispatchPending();
  syncResults();
  say_('Started', 'The agent is running for "' + s.campaign + '". New leads in the ' + CFG.LEADS_TAB + ' tab are submitted automatically.');
}

function pause() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  props_().setProperty('RUNNING', '0');
  setAgentStatus_('Paused');
  say_('Paused', 'No new leads will be sent until you choose Start again.');
}

function checkStatus() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.LEADS_TAB);
  const c = { Pending: 0, Queued: 0, Submitted: 0, Failed: 0 };
  if (sh && sh.getLastRow() > 1) {
    const v = sh.getDataRange().getDisplayValues(), head = v[0].map(h => String(h).trim()), sCol = head.indexOf(CFG.STATUS_HEADER);
    for (let r = 1; r < v.length; r++) {
      if (!keyOf_(v[r], head)) continue;
      const st = sCol >= 0 ? String(v[r][sCol]).trim() : '';
      if (!st) c.Pending++; else if (/^Queued/.test(st)) c.Queued++; else if (/^Submitted/.test(st)) c.Submitted++; else c.Failed++;
    }
  }
  say_('Status', 'Agent: ' + (isRunning_() ? 'running' : 'not running') + '\nSubmitted: ' + c.Submitted + '\nFailed: ' + c.Failed +
    '\nIn progress: ' + c.Queued + '\nNot sent yet: ' + c.Pending + '\n\nLast note: ' + (props_().getProperty('LAST_NOTE') || 'none'));
}

// ---------- 1. send new leads to GitHub ----------
function onSheetChange() { dispatchPending(); }

function dispatchPending() {
  if (!isRunning_()) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const s = readSettings_();
    const sh = SpreadsheetApp.getActive().getSheetByName(CFG.LEADS_TAB);
    if (!sh) { note_('No tab named ' + CFG.LEADS_TAB); return; }
    if (!s.campaign || !/^https?:\/\/.+/i.test(s.pageUrl)) { note_('Settings are incomplete'); return; }
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
      payload: JSON.stringify({ event_type: 'new-leads', client_payload: { campaign: s.campaign, page_url: s.pageUrl, leads } }) });
    const code = res.getResponseCode();
    if (code === 204) {
      const stamp = 'Queued ' + new Date().toISOString();
      rowsSent.forEach(r => sh.getRange(r, sCol + 1).setValue(stamp));
      note_('Sent ' + leads.length + ' lead(s)');
    } else {
      note_('GitHub refused the request (HTTP ' + code + '): ' + String(res.getContentText()).slice(0, 120));
    }
  } finally { lock.releaseLock(); }
}

// ---------- 2. bring results back ----------
function syncResults() {
  if (!isRunning_()) return;
  const s = readSettings_();
  const slug = slug_(s.campaign);
  if (!slug) return;
  const res = gh_('/contents/data/' + slug + '/results.csv', { headers: { Accept: 'application/vnd.github.raw+json' } });
  const code = res.getResponseCode();
  if (code === 404) { writeResults_([], null); return; }
  if (code !== 200) { note_('Could not read results (HTTP ' + code + ')'); writeResults_(null, null); return; }
  const rows = Utilities.parseCsv(res.getContentText());
  const results = rows.slice(1).filter(r => r[0]).map(r => ({ key: r[0], row: r[1], status: r[2], at: r[3] }));
  const latest = {};
  results.forEach(x => { latest[x.key] = x; });          // newest line per lead wins
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.LEADS_TAB);
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
      Object.keys(latest).forEach(k => {
        const r = byKey[k], x = latest[k];
        if (r === undefined) return;
        info[k] = { name: [fCol >= 0 ? values[r][fCol] : '', lCol >= 0 ? values[r][lCol] : ''].join(' ').trim(), row: r + 1 };
        const cur = String(statusCol[r - 1][0] || '').trim();
        // apply a result only if the lead has no result yet, or it was re-sent after that result
        if (cur === '' || (/^Queued /.test(cur) && String(x.at) > cur.slice(7))) { statusCol[r - 1][0] = x.status; changed = true; }
      });
      if (changed) sh.getRange(2, sCol + 1, statusCol.length, 1).setValues(statusCol);
    }
  }
  writeResults_(results, info);
}

function writeResults_(results, info) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(CFG.RESULTS_TAB);
  if (!sh) sh = ss.insertSheet(CFG.RESULTS_TAB);
  const note = props_().getProperty('LAST_NOTE') || '';
  sh.getRange(1, 1).setValue('Last sync: ' + new Date().toLocaleString() + (note ? '   |   ' + note : ''));
  if (results === null) return;
  const out = [['Updated at', 'Result', 'Detail', 'Email / phone', 'Name', 'Lead row']];
  results.slice().reverse().forEach(x => {
    const ok = /^Submitted/.test(x.status), i = (info && info[x.key]) || {};
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
