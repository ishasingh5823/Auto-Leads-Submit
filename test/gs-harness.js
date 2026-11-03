// Runs LeadsRealtime.gs against in-memory mocks of Google Sheets, GitHub and Apps Script services.
const fs = require('fs'), vm = require('vm');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr: nr || 1, nc: nc || 1 }); }
  setValue(v) { this.sh.set(this.r, this.c, v); return this; }
  setValues(a) { a.forEach((row, i) => row.forEach((v, j) => this.sh.set(this.r + i, this.c + j, v))); return this; }
  clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh.set(this.r + i, this.c + j, ''); return this; }
  setFontWeight() { return this; } setBackground() { return this; } setFontColor() { return this; }
}
class Sheet {
  constructor(name, data) { this.name = name; this.d = data || []; this.maxRows = Math.max(this.d.length, 100); }
  set(r, c, v) { while (this.d.length < r) this.d.push([]); const row = this.d[r - 1]; while (row.length < c) row.push(''); row[c - 1] = v; }
  getDataRange() { const w = Math.max(...this.d.map(r => r.length), 0); return { getDisplayValues: () => this.d.map(r => Array.from({ length: w }, (_, i) => String(r[i] == null ? '' : r[i]))) }; }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr, nc); }
  getLastRow() { return this.d.length; } getMaxRows() { return this.maxRows; }
  insertRowsAfter(_, n) { this.maxRows += n; } setFrozenRows() {} autoResizeColumns() {}
}
const sheets = {
  Leads: new Sheet('Leads', [['first_name', 'last_name', 'email', 'phone_number', 'city'],
    ['Aarav', 'Sharma', 'Aarav.Sharma@example.com', 'p:+919876543210', 'Atlanta'],
    ['Priya', 'Patel', 'priya.patel@example.com', 'p:+919123456780', 'Dallas'],
    ['', '', '', '', '']]),
};
const props = {}; const fetches = []; let resultsCsv = null;
const ctx = {
  console, Date, JSON, Math, String, Array, Object, Number, Promise,
  SpreadsheetApp: { getActive: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = new Sheet(n)) }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
  Utilities: { parseCsv: t => t.trim().split('\n').map(l => l.split(',')) },
  UrlFetchApp: { fetch: (url, o) => {
    fetches.push({ url, o });
    if (url.endsWith('/dispatches')) return { getResponseCode: () => 204, getContentText: () => '' };
    if (url.endsWith('/contents/results.csv')) return resultsCsv == null ? { getResponseCode: () => 404, getContentText: () => '' }
      : { getResponseCode: () => 200, getContentText: () => resultsCsv };
  } },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../LeadsRealtime.gs', 'utf8').replace(/^const /gm, 'var '), ctx);
props.GITHUB_TOKEN = 'ghp_test';
const run = f => vm.runInContext(f + '()', ctx);
const L = () => sheets.Leads.d.map(r => r[5] || '');

run('dispatchPending');
const d1 = fetches.filter(f => f.url.endsWith('/dispatches'));
ok(d1.length === 1, 'new leads trigger exactly one dispatch');
const body = JSON.parse(d1[0].o.payload);
ok(body.event_type === 'new-leads' && body.client_payload.leads.length === 2, 'dispatch carries both new leads (blank row skipped)');
ok(body.client_payload.leads[0].row === 2 && body.client_payload.leads[0].data.phone_number === 'p:+919876543210', 'lead data and row numbers are included');
ok(!('Status' in body.client_payload.leads[0].data), 'Status column is not sent as lead data');
ok(d1[0].o.headers.Authorization === 'Bearer ghp_test', 'GitHub token is sent as bearer auth');
ok(/^Queued /.test(L()[1]) && /^Queued /.test(L()[2]), 'rows are marked Queued');

run('dispatchPending');
ok(fetches.filter(f => f.url.endsWith('/dispatches')).length === 1, 'queued leads are not sent twice');

// new lead arrives
sheets.Leads.d.push(['Rohan', 'Mehta', 'rohan.mehta@example.com', 'p:+919988776655', 'Chicago']);
run('dispatchPending');
const d2 = fetches.filter(f => f.url.endsWith('/dispatches'));
ok(d2.length === 2 && JSON.parse(d2[1].o.payload).client_payload.leads.length === 1, 'a newly added lead is sent on its own');

// results come back
resultsCsv = 'key,row,status,updated_at\naarav.sharma@example.com,2,Submitted 2026-11-03T11:00:00Z,2026-11-03T11:00:01Z\npriya.patel@example.com,3,Failed: No confirmation after submitting,2026-11-03T11:00:05Z';
run('syncResults');
ok(L()[1] === 'Submitted 2026-11-03T11:00:00Z', 'Status of lead 1 updated from results (email match is case-insensitive)');
ok(L()[2].startsWith('Failed: No confirmation'), 'failure reason lands in Status of lead 2');
ok(/^Queued /.test(L()[4]), 'lead without a result stays Queued');
const R = sheets.Results.d;
ok(String(R[0][0]).startsWith('Last sync:'), 'Results tab shows last sync in A1');
ok(R[2][1] === 'Result' && R[3][1] === 'Failed' && R[4][1] === 'Submitted', 'Results tab lists newest first with Result column');
ok(R[4][4] === 'Aarav Sharma' && R[4][5] === 2, 'Results tab includes name and lead row');

// stale queued lead is retried
sheets.Leads.d[4][5] = 'Queued ' + new Date(Date.now() - 20 * 60000).toISOString();
const before = fetches.filter(f => f.url.endsWith('/dispatches')).length;
run('dispatchPending');
const d3 = fetches.filter(f => f.url.endsWith('/dispatches'));
ok(d3.length === before + 1 && JSON.parse(d3[d3.length - 1].o.payload).client_payload.leads[0].data.email === 'rohan.mehta@example.com', 'a lead stuck in Queued for 20 min is re-sent');
console.log(fails ? `\n${fails} FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
