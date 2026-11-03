// Lead agent. Submits leads on a landing page with a real browser.
//
// Two modes:
//   FILE mode (default, no Google needed): reads leads.csv in this repo, writes Status back to it,
//     and appends every confirmed signup to signups.csv. The GitHub workflow commits those files.
//   BRIDGE mode (if BRIDGE_URL is set): leads come from a Google Sheet through the Apps Script bridge.
//
// Env vars (all optional):
//   PAGE_URL      landing page to submit on (default: the demo page in this repo)
//   LIMIT         max leads per run (default 20)
//   DELAY_MS      pause between leads (default 1500)
//   LEADS_FILE / SIGNUPS_FILE   file paths for FILE mode
//   BRIDGE_URL / BRIDGE_TOKEN   BRIDGE mode only
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BRIDGE_URL = process.env.BRIDGE_URL || '';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const FILE_MODE = !BRIDGE_URL;
const LEADS_FILE = process.env.LEADS_FILE || path.resolve(__dirname, 'leads.csv');
const SIGNUPS_FILE = process.env.SIGNUPS_FILE || path.resolve(__dirname, 'signups.csv');
const DEMO = 'file://' + path.resolve(__dirname, 'demo', 'index.html');
const PAGE_URL = process.env.PAGE_URL || DEMO;
const USING_DEMO = PAGE_URL === DEMO;
const LIMIT = Number(process.env.LIMIT || 20);
const DELAY_MS = Number(process.env.DELAY_MS || 1500);

// ---- CONFIG: lead column -> form field selector. Edit for a real landing page. ----
const FIELDS = {
  first_name: { sel: '#first_name', type: 'text' },
  last_name:  { sel: '#last_name',  type: 'text' },
  email:      { sel: '#email',      type: 'text' },
  phone:      { sel: '#phone',      type: 'text' },
  city:       { sel: '#city',       type: 'text' },
  slot:       { sel: '#slot',       type: 'select' },
};
const CONSENT_SEL = '#consent';   // ticked only because these leads opted in
const SUBMIT_SEL = '#submitBtn';
const SUCCESS_SEL = '#thanks';    // element that appears when the signup worked
const SIGNUP_COLUMNS = ['received_at', 'first_name', 'last_name', 'email', 'phone', 'city', 'slot'];
// ------------------------------------------------------------------------------------

// ---------- CSV helpers ----------
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}
const esc = v => { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
function readCsv(file) {
  const rows = parseCSV(fs.readFileSync(file, 'utf8'));
  const header = rows[0].map(h => h.trim());
  if (!header.includes('Status')) header.push('Status');
  const data = rows.slice(1).map(r => { while (r.length < header.length) r.push(''); return r; });
  return { header, data };
}
function writeCsv(file, header, data) {
  fs.writeFileSync(file, [header, ...data].map(r => r.map(esc).join(',')).join('\n') + '\n');
}

// ---------- FILE mode ----------
const fileSource = {
  async pending(limit) {
    const { header, data } = readCsv(LEADS_FILE);
    const sIdx = header.indexOf('Status');
    const out = [];
    for (let i = 0; i < data.length && out.length < limit; i++) {
      if ((data[i][sIdx] || '').trim() !== '') continue;
      const rec = {}; header.forEach((h, k) => { if (h !== 'Status') rec[h] = (data[i][k] || '').trim(); });
      out.push({ row: i + 2, data: rec });
    }
    return out;
  },
  async setStatus(row, status) {
    const { header, data } = readCsv(LEADS_FILE);
    data[row - 2][header.indexOf('Status')] = status;
    writeCsv(LEADS_FILE, header, data);
  },
  async recordSignup(rec) {
    if (!fs.existsSync(SIGNUPS_FILE)) fs.writeFileSync(SIGNUPS_FILE, SIGNUP_COLUMNS.join(',') + '\n');
    fs.appendFileSync(SIGNUPS_FILE, SIGNUP_COLUMNS.map(c => esc(rec[c])).join(',') + '\n');
  },
};

// ---------- BRIDGE mode ----------
async function parse(r) {
  const t = await r.text();
  try { return JSON.parse(t); }
  catch (e) {
    throw new Error('Bridge did not return JSON (HTTP ' + r.status + ', ' + r.url.split('?')[0].slice(0, 60) + '). ' +
      'Usually the Apps Script web app access is not "Anyone", the URL is wrong, or the deployment is not the latest version. ' +
      'Response starts: ' + t.slice(0, 120).replace(/\s+/g, ' '));
  }
}
const bridgeSource = {
  async pending(limit) {
    const u = `${BRIDGE_URL}${BRIDGE_URL.includes('?') ? '&' : '?'}action=pending&limit=${limit}&token=${encodeURIComponent(BRIDGE_TOKEN)}`;
    const p = await parse(await fetch(u, { redirect: 'follow' }));
    if (!p.ok) throw new Error('Bridge error: ' + p.error);
    return p.leads;
  },
  async setStatus(row, status) {
    await parse(await fetch(BRIDGE_URL, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'status', token: BRIDGE_TOKEN, row, status }) }));
  },
  async recordSignup() { /* the demo page posts its own signups to the sheet */ },
};

const source = FILE_MODE ? fileSource : bridgeSource;
const sleep = ms => new Promise(r => setTimeout(r, ms));
process.on('unhandledRejection', e => { console.error('ERROR:', e.message || e); process.exit(1); });

(async () => {
  console.log(`Mode: ${FILE_MODE ? 'FILE (' + path.basename(LEADS_FILE) + ')' : 'BRIDGE'} | Page: ${USING_DEMO ? 'demo page' : PAGE_URL}`);
  const leads = await source.pending(LIMIT);
  console.log(`Pending leads: ${leads.length}`);
  if (!leads.length) return;

  const browser = await chromium.launch();
  let ok = 0, fail = 0;
  for (const { row, data } of leads) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    if (USING_DEMO && !FILE_MODE) await page.addInitScript(ep => { window.SIGNUP_ENDPOINT = ep; }, BRIDGE_URL);
    let status, signup = null;
    try {
      await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
      for (const [col, f] of Object.entries(FIELDS)) {
        if (f.type === 'select') await page.selectOption(f.sel, data[col]);
        else await page.fill(f.sel, data[col] || '');
      }
      await page.check(CONSENT_SEL);
      await page.click(SUBMIT_SEL);
      await page.waitForSelector(SUCCESS_SEL, { state: 'visible', timeout: 15000 });
      status = 'Submitted ' + new Date().toISOString();
      signup = { ...data, received_at: new Date().toISOString() };
      if (USING_DEMO) {   // take the record the page itself stored, as proof it received the signup
        const subs = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('test_lead_submissions') || '[]'); } catch (e) { return []; } });
        if (subs.length) signup = { ...subs[subs.length - 1], received_at: subs[subs.length - 1].submitted_at };
      }
      ok++;
    } catch (e) {
      status = 'Failed: ' + e.message.split('\n')[0].slice(0, 100);
      fail++;
    }
    console.log(`Row ${row} (${data.email}): ${status}`);
    if (signup) await source.recordSignup(signup);
    try { await source.setStatus(row, status); } catch (e) { console.error(`Could not write status for row ${row}:`, e.message); }
    await ctx.close();
    await sleep(DELAY_MS);
  }
  await browser.close();
  console.log(`Done. Submitted: ${ok}, Failed: ${fail}`);
  if (fail && !ok) process.exit(1);
})();
