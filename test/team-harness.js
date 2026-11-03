// Runs TeamSheet.gs against in-memory mocks of Google Sheets, the Apps Script services and GitHub.
const fs = require('fs'), vm = require('vm');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const colNum = s => s.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
function a1(s) { const m = s.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/); const c = colNum(m[1]), r = +m[2];
  return m[3] ? [r, c, +m[4] - r + 1, colNum(m[3]) - c + 1] : [r, c, 1, 1]; }
class Range {
  constructor(sh, r, c, nr, nc) { if (typeof r === 'string') [r, c, nr, nc] = a1(r); Object.assign(this, { sh, r, c, nr: nr || 1, nc: nc || 1 }); }
  setValue(v) { this.sh.set(this.r, this.c, v); return this; }
  setValues(a) { a.forEach((row, i) => row.forEach((v, j) => this.sh.set(this.r + i, this.c + j, v))); return this; }
  getDisplayValues() { return Array.from({ length: this.nr }, (_, i) => Array.from({ length: this.nc }, (_, j) => String((this.sh.d[this.r - 1 + i] || [])[this.c - 1 + j] ?? ''))); }
  setDataValidation() { return this; }
  getDisplayValue() { return String((this.sh.d[this.r - 1] || [])[this.c - 1] ?? ''); }
  clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh.set(this.r + i, this.c + j, ''); return this; }
  setFontWeight() { return this; } setBackground() { return this; } setFontColor() { return this; }
}
class Sheet {
  constructor(name, data) { this.name = name; this.d = data || []; this.maxRows = Math.max(this.d.length, 100); }
  set(r, c, v) { while (this.d.length < r) this.d.push([]); const row = this.d[r - 1]; while (row.length < c) row.push(''); row[c - 1] = v; }
  getDataRange() { const w = Math.max(...this.d.map(r => r.length), 0); return { getDisplayValues: () => this.d.map(r => Array.from({ length: w }, (_, i) => String(r[i] == null ? '' : r[i]))) }; }
  getRange(...a) { return new Range(this, ...a); }
  getLastColumn() { return Math.max(...this.d.map(r => r.length), 0); }
  getLastRow() { return this.d.length; } getMaxRows() { return this.maxRows; }
  insertRowsAfter(_, n) { this.maxRows += n; } setFrozenRows() {} autoResizeColumns() {} setColumnWidth() {}
}
const sheets = { Leads: new Sheet('Leads', [['full_name', 'email', 'phone_number', 'city'],
  ['Aarav Sharma', 'Aarav.Sharma@example.com', 'p:+919876543210', 'Atlanta'], ['Priya Patel', 'priya.patel@example.com', 'p:+919123456780', 'Dallas']]) };
const props = {}, fetches = [], alerts = [], triggers = []; let resultsCsv = null, ghStatus = 200, promptText = 'ghp_good';
const trig = (fn) => ({ forSpreadsheet() { return this; }, onChange() { return this; }, timeBased() { return this; }, everyMinutes() { return this; }, create() { triggers.push(fn); } });
const ctx = {
  console, Date, JSON, Math, String, Array, Object, Number, Logger: { log() {} },
  SpreadsheetApp: { newDataValidation: () => ({ requireValueInList() { return this; }, setAllowInvalid() { return this; }, build() { return {}; } }), getActive: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = new Sheet(n)) }),
    getUi: () => ({ ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL' }, Button: { OK: 'OK' }, alert: (t, m) => alerts.push(t + ': ' + m),
      prompt: () => ({ getSelectedButton: () => 'OK', getResponseText: () => promptText }),
      createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }) }) },
  ScriptApp: { getProjectTriggers: () => triggers.map(() => ({})), deleteTrigger: () => { triggers.length = 0; },
    newTrigger: fn => trig(fn) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) },
  Utilities: { parseCsv: t => t.trim().split('\n').map(l => l.split(',')) },
  UrlFetchApp: { fetch: (url, o) => {
    fetches.push({ url, o });
    if (url.endsWith('/dispatches')) return { getResponseCode: () => 204, getContentText: () => '' };
    if (url.includes('/contents/')) return resultsCsv == null ? { getResponseCode: () => 404, getContentText: () => '' } : { getResponseCode: () => 200, getContentText: () => resultsCsv };
    return { getResponseCode: () => ghStatus, getContentText: () => '{}' };   // repo check used by connect()
  } },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../TeamSheet.gs', 'utf8').replace(/^const /gm, 'var '), ctx);
const run = f => vm.runInContext(f + '()', ctx);
const status = () => sheets.Leads.d.map(r => r[4] || '');
const dispatches = () => fetches.filter(f => f.url.endsWith('/dispatches'));

run('onOpen');
ok(sheets.Settings && sheets.Settings.d[0][0] === 'Campaign name', 'Settings tab is created on open');

run('start');
ok(/campaign name/i.test(alerts.at(-1)) && /landing page URL/i.test(alerts.at(-1)) && /Connect to GitHub/.test(alerts.at(-1)), 'Start with nothing set explains what is missing');
ok(props.RUNNING !== '1' && dispatches().length === 0, 'nothing runs while setup is incomplete');

ghStatus = 401; promptText = 'bad';
run('connect');
ok(!props.GITHUB_TOKEN && /Could not connect/.test(alerts.at(-1)), 'a bad token is rejected and not kept');
ghStatus = 200; promptText = 'ghp_good';
run('connect');
ok(props.GITHUB_TOKEN === 'ghp_good' && /^Connected/.test(alerts.at(-1)), 'a good token is saved');

sheets.Settings.d[0][1] = 'Ashley Hiring Event'; sheets.Settings.d[1][1] = 'https://careers.example.com/event';
run('start');
ok(props.RUNNING === '1' && sheets.Settings.d[2][1] === 'Running', 'Start marks the agent as running');
ok(triggers.length === 3, 'Start creates the 3 triggers (on change, results every minute, sweep every 5)');
const p = JSON.parse(dispatches()[0].o.payload);
ok(p.client_payload.campaign === 'Ashley Hiring Event' && p.client_payload.page_url === 'https://careers.example.com/event' && p.client_payload.leads.length === 2, 'dispatch carries campaign, landing page URL and both leads');
ok(/^Queued /.test(status()[1]) && /^Queued /.test(status()[2]), 'leads are marked Queued');
ok(fetches.some(f => f.url.endsWith('/contents/data/ashley-hiring-event/results.csv')), 'results are read from this campaign\'s own folder');

// results arrive: one submitted, one failed
const ago = m => new Date(Date.now() - m * 60000).toISOString();
resultsCsv = 'key,row,status,updated_at\naarav.sharma@example.com,2,Submitted ' + ago(9) + ',' + ago(9) + '\npriya.patel@example.com,3,Failed: No confirmation after submitting,' + ago(8);
sheets.Leads.d[1][4] = 'Queued ' + ago(12); sheets.Leads.d[2][4] = 'Queued ' + ago(12);
run('syncResults');
ok(/^Submitted/.test(status()[1]) && /^Failed: No confirmation/.test(status()[2]), 'Status column updates from results');
ok(sheets.Results.d[3][1] === 'Failed' && sheets.Results.d[4][1] === 'Submitted', 'Results tab lists newest first');

// editable form-field table travels with each dispatch
ok(sheets.Settings.d[7][0] === 'Lead column' && sheets.Settings.d[8][0] === 'role', 'Settings tab gets the editable Form fields table (with an example row)');
ok(Array.isArray(p.client_payload.field_map) && p.client_payload.field_map.length === 1 && p.client_payload.field_map[0].field === 'Which role', 'dispatch carries the field map from the table');
sheets.Settings.d[8] = ['', 'How did you hear', 'Facebook']; sheets.Settings.d[9] = ['city', 'Town', ''];
sheets.Leads.d.push(['Zed Zee', 'zed@example.com', 'p:+911111111111', 'Pune']);
const nMap = dispatches().length; run('dispatchPending');
const fm = JSON.parse(dispatches()[nMap].o.payload).client_payload.field_map;
ok(fm.length === 2 && fm[0].value === 'Facebook' && fm[1].column === 'city', 'editing the table changes what is sent; empty rows are ignored');
sheets.Leads.d.pop();   // remove the extra lead so later checks stay simple
sheets.Settings.d[8] = []; sheets.Settings.d[9] = [];

// teammate clears the failed Status to retry
sheets.Leads.d[2][4] = '';
const n = dispatches().length;
run('dispatchPending');
ok(dispatches().length === n + 1 && JSON.parse(dispatches().at(-1).o.payload).client_payload.leads.length === 1, 'clearing a Failed status re-sends only that lead');
const queuedAt = status()[2].slice(7);
run('syncResults');
ok(/^Queued /.test(status()[2]), 'the old Failed result does not overwrite the retry');
resultsCsv += '\npriya.patel@example.com,3,Submitted ' + new Date(Date.parse(queuedAt) + 60000).toISOString() + ',' + new Date(Date.parse(queuedAt) + 60000).toISOString();
run('syncResults');
ok(/^Submitted/.test(status()[2]), 'the new Submitted result replaces Queued');

run('checkStatus');
ok(/Submitted: 2/.test(alerts.at(-1)) && /Failed: 0/.test(alerts.at(-1)), 'Check status counts are right');

run('pause');
ok(props.RUNNING === '0' && triggers.length === 0 && sheets.Settings.d[2][1] === 'Paused', 'Pause stops triggers and marks Paused');
sheets.Leads.d.push(['Rohan Mehta', 'rohan@example.com', 'p:+919988776655', 'Chicago']);
const m = dispatches().length; run('dispatchPending');
ok(dispatches().length === m, 'nothing is sent while paused');
console.log(fails ? `\n${fails} FAILED` : '\nAll checks passed'); process.exit(fails ? 1 : 0);
