// Cloud agent: pulls pending leads from the Google Sheet bridge, submits each one on the landing page
// with a real browser, and reports Submitted/Failed back to the sheet.
//
// Env vars:
//   BRIDGE_URL      Apps Script web app URL (required)
//   BRIDGE_TOKEN    must match TOKEN in bridge.gs (required)
//   PAGE_URL        landing page to submit on (default: the demo page in this repo)
//   SIGNUP_ENDPOINT only for the demo page: where it saves signups (default: BRIDGE_URL)
//   LIMIT           max leads per run (default 20)
//   DELAY_MS        pause between leads (default 1500)
const path = require('path');
const { chromium } = require('playwright');

const BRIDGE_URL = process.env.BRIDGE_URL;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
if (!BRIDGE_URL || !BRIDGE_TOKEN) { console.error('Set BRIDGE_URL and BRIDGE_TOKEN'); process.exit(1); }
const DEMO = 'file://' + path.resolve(__dirname, 'demo', 'index.html');
const PAGE_URL = process.env.PAGE_URL || DEMO;
const USING_DEMO = PAGE_URL === DEMO;
const SIGNUP_ENDPOINT = process.env.SIGNUP_ENDPOINT || BRIDGE_URL;
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
// ------------------------------------------------------------------------------------

async function getJSON(url) {
  const r = await fetch(url, { redirect: 'follow' });
  return r.json();
}
async function postJSON(url, body) {
  const r = await fetch(url, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
  return r.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const pending = await getJSON(`${BRIDGE_URL}${BRIDGE_URL.includes('?') ? '&' : '?'}action=pending&limit=${LIMIT}&token=${encodeURIComponent(BRIDGE_TOKEN)}`);
  if (!pending.ok) { console.error('Bridge error:', pending.error); process.exit(1); }
  const leads = pending.leads;
  console.log(`Pending leads: ${leads.length}`);
  if (!leads.length) return;

  const browser = await chromium.launch();
  let ok = 0, fail = 0;
  for (const { row, data } of leads) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    if (USING_DEMO) await page.addInitScript(ep => { window.SIGNUP_ENDPOINT = ep; }, SIGNUP_ENDPOINT);
    let status;
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
      ok++;
    } catch (e) {
      status = 'Failed: ' + e.message.split('\n')[0].slice(0, 100);
      fail++;
    }
    console.log(`Row ${row} (${data.email}): ${status}`);
    try { await postJSON(BRIDGE_URL, { action: 'status', token: BRIDGE_TOKEN, row, status }); }
    catch (e) { console.error(`Could not write status for row ${row}:`, e.message); }
    await ctx.close();
    await sleep(DELAY_MS);
  }
  await browser.close();
  console.log(`Done. Submitted: ${ok}, Failed: ${fail}`);
  if (fail && !ok) process.exit(1);
})();
