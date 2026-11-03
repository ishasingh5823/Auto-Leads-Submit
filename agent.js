// Lead agent: submits leads on ANY landing page with a real browser. No per-page code needed.
//
// Inputs (env vars, set from the GitHub "Run workflow" form or repo secrets):
//   PAGE_URL   landing page with the form (default: the demo page in this repo)
//   LEADS_URL  link to the leads sheet as CSV. A Google Sheet link works if the sheet is shared as
//              "Anyone with the link can view" (or published to the web). Default: leads.csv in this repo.
//   LIMIT (20)  DELAY_MS (1500)  DEBUG (set to 1 to save a screenshot of each failed lead)
//
// Outputs (committed back to the repo by the workflow):
//   results.csv   one line per lead tried: Submitted / Failed + reason
//   signups.csv   leads whose submission was confirmed
//   leads.csv     (only when LEADS_URL is not set) gets its Status column filled in
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DEMO = 'file://' + path.resolve(__dirname, 'demo', 'index.html');
const PAGE_URL = (process.env.PAGE_URL || '').trim() || DEMO;
const USING_DEMO = PAGE_URL === DEMO;
const LEADS_URL = (process.env.LEADS_URL || '').trim();
const LIMIT = Number(process.env.LIMIT || 20);
const DELAY_MS = Number(process.env.DELAY_MS || 1500);
const DEBUG = ['1', 'true'].includes(String(process.env.DEBUG || '').toLowerCase());
const DIR = process.env.DATA_DIR || __dirname;
// CAMPAIGN keeps each campaign's results in its own folder (data/<campaign>/), so many campaigns share one engine
const CAMPAIGN = (process.env.CAMPAIGN || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const OUT_DIR = CAMPAIGN ? path.join(DIR, 'data', CAMPAIGN) : DIR;
if (CAMPAIGN) fs.mkdirSync(OUT_DIR, { recursive: true });
const LEADS_FILE = path.join(DIR, 'leads.csv');
const RESULTS_FILE = path.join(OUT_DIR, 'results.csv');
const SIGNUPS_FILE = path.join(OUT_DIR, 'signups.csv');

// Safety: only http(s) pages, never internal addresses, and (if the team sets ALLOWED_HOSTS) only approved domains
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
function checkPageUrl(u) {
  if (u === DEMO) return;
  let url; try { url = new URL(u); } catch (e) { throw new Error('PAGE_URL is not a valid link'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('PAGE_URL must start with http:// or https://');
  const h = url.hostname.toLowerCase();
  if (!process.env.ALLOW_LOCAL && /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1|0\.0\.0\.0)/.test(h))
    throw new Error('PAGE_URL points to an internal address, which is not allowed');
  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.some(a => h === a || h.endsWith('.' + a)))
    throw new Error('PAGE_URL host ' + h + ' is not in the approved list (ALLOWED_HOSTS)');
}

const mask = e => (USING_DEMO ? e : String(e || '').replace(/^(.).*(@.*)$/, '$1***$2'));   // keep emails out of public logs
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ---------- CSV helpers ----------
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  text = text.replace(/^﻿/, '');
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
const line = arr => arr.map(esc).join(',') + '\n';

// ---------- Leads source ----------
function toCsvUrl(u) {
  const m = u.match(/docs\.google\.com\/spreadsheets\/d\/([^/?#]+)/);
  if (!m) return u;
  if (/\/d\/e\//.test(u) || /output=csv|format=csv|\/export\?/.test(u)) return u;
  const g = u.match(/[#&?]gid=(\d+)/);
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${g ? '&gid=' + g[1] : ''}`;
}
async function loadLeadsText() {
  if (!LEADS_URL) return fs.readFileSync(LEADS_FILE, 'utf8');
  const r = await fetch(toCsvUrl(LEADS_URL), { redirect: 'follow' });
  const t = await r.text();
  if (!r.ok || /^\s*<(!doctype|html)/i.test(t)) {
    throw new Error('LEADS_URL did not return CSV (HTTP ' + r.status + '): it looks like a sign-in or error page. ' +
      'Share the sheet as "Anyone with the link can view" (if your company allows it), or paste the leads into leads.csv in the repo.');
  }
  return t;
}
const keyOf = rec => String(rec.email || rec.phone || JSON.stringify(rec)).trim().toLowerCase();
function loadResults() {
  const m = new Map();
  if (!fs.existsSync(RESULTS_FILE)) return m;
  parseCSV(fs.readFileSync(RESULTS_FILE, 'utf8')).slice(1).forEach(r => m.set(r[0], r[2]));
  return m;
}
function appendResult(key, row, status) {
  if (!fs.existsSync(RESULTS_FILE)) fs.writeFileSync(RESULTS_FILE, line(['key', 'row', 'status', 'updated_at']));
  fs.appendFileSync(RESULTS_FILE, line([key, row, status, new Date().toISOString()]));
}
function appendSignup(rec) {
  const cols = Object.keys(rec);
  let header = null;
  if (fs.existsSync(SIGNUPS_FILE)) {
    const rows = parseCSV(fs.readFileSync(SIGNUPS_FILE, 'utf8'));
    if (rows.length > 1) header = rows[0];      // has data: keep its columns
  }
  if (!header) { header = ['received_at', ...cols.filter(c => c !== 'received_at')]; fs.writeFileSync(SIGNUPS_FILE, line(header)); }
  fs.appendFileSync(SIGNUPS_FILE, line(header.map(h => rec[h])));
}
function setLeadsFileStatus(row, status) {
  const rows = parseCSV(fs.readFileSync(LEADS_FILE, 'utf8'));
  let s = rows[0].map(h => h.trim()).indexOf('Status');
  if (s < 0) { rows[0].push('Status'); s = rows[0].length - 1; }
  rows.forEach(r => { while (r.length < rows[0].length) r.push(''); });
  rows[row - 1][s] = status;
  fs.writeFileSync(LEADS_FILE, rows.map(line).join(''));
}
const ALIAS = { 'phone number': 'phone', 'phone no': 'phone', mobile: 'phone', 'mobile number': 'phone', 'contact number': 'phone',
  'email address': 'email', 'e mail': 'email', firstname: 'first_name', 'first name': 'first_name', lastname: 'last_name',
  'last name': 'last_name', surname: 'last_name', 'full name': 'full_name', name: 'full_name' };
function canon(rec) {   // normalise column names (Meta uses phone_number, full_name...) and strip Meta's "p:" phone prefix
  const out = {};
  for (const [k, v0] of Object.entries(rec)) {
    let v = String(v0 == null ? '' : v0).trim();
    const ck = ALIAS[norm(k)] || norm(k).replace(/ /g, '_');
    if (!ck) continue;
    if (ck === 'phone') v = v.replace(/^p:/i, '').trim();
    if (!out[ck]) out[ck] = v;
  }
  return out;
}
async function getPending(limit) {
  if (process.env.LEADS_JSON) {       // real-time mode: the Google Sheet sends new leads straight to this run
    const done = loadResults();
    return JSON.parse(process.env.LEADS_JSON)
      .map(l => ({ row: l.row, data: canon(l.data || {}) }))
      .filter(l => (l.data.email || l.data.phone) && !/^Submitted/.test(done.get(keyOf(l.data)) || ''))
      .slice(0, limit);
  }
  const rows = parseCSV(await loadLeadsText());
  const header = rows[0].map(h => h.trim());
  const sIdx = header.indexOf('Status');
  const done = LEADS_URL ? loadResults() : null;
  const out = [];
  for (let i = 1; i < rows.length && out.length < limit; i++) {
    const raw = {};
    header.forEach((h, k) => { if (h && h !== 'Status') raw[h] = (rows[i][k] || '').trim(); });
    const rec = canon(raw);
    if (!rec.email && !rec.phone) continue;
    if (LEADS_URL ? done.has(keyOf(rec)) : (sIdx >= 0 && (rows[i][sIdx] || '').trim() !== '')) continue;
    out.push({ row: i + 1, data: rec });
  }
  return out;
}

// ---------- Generic form filling ----------
const SYN = { zip: ['zip', 'zipcode', 'postal', 'postcode', 'pin code'], state: ['state', 'province'], city: ['city', 'town'],
  country: ['country'], company: ['company', 'employer', 'organization', 'organisation'], job_title: ['job title', 'position', 'role'] };
const CONSENT_RE = /consent|agree|terms|privacy|policy|opt in|opt-in|contact me|i accept|subscribe|updates|communications|sms|text me|call me/;

async function describeControls(page) {
  return page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const labelOf = el => {
      let t = '';
      if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) t += ' ' + l.textContent; }
      const pl = el.closest('label'); if (pl) t += ' ' + pl.textContent;
      const lb = el.getAttribute('aria-labelledby');
      if (lb) lb.split(/\s+/).forEach(id => { const n = document.getElementById(id); if (n) t += ' ' + n.textContent; });
      return t;
    };
    const out = []; let i = 0;
    document.querySelectorAll('input,select,textarea').forEach(el => {
      const type = (el.getAttribute('type') || el.tagName).toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'file', 'password'].includes(type)) return;
      if (!vis(el)) return;
      el.setAttribute('data-agent-idx', String(i));
      out.push({ idx: i, tag: el.tagName.toLowerCase(), type, name: el.name || '', id: el.id || '', placeholder: el.placeholder || '',
        aria: el.getAttribute('aria-label') || '', auto: el.getAttribute('autocomplete') || '',
        label: labelOf(el).replace(/\s+/g, ' ').trim(), required: el.required || el.getAttribute('aria-required') === 'true',
        options: el.tagName === 'SELECT' ? [...el.options].map(o => ({ value: o.value, text: o.text.trim() })) : [] });
      i++;
    });
    return out;
  });
}

function valueFor(role, d) {
  const split = (d.full_name || d.name || '').trim().split(/\s+/);
  switch (role) {
    case 'first_name': return d.first_name || d.firstname || split[0] || '';
    case 'last_name': return d.last_name || d.lastname || split.slice(1).join(' ') || '';
    case 'full_name': return d.full_name || d.name || [d.first_name, d.last_name].filter(Boolean).join(' ');
    default: return d[role] || '';
  }
}
function roleOf(c, d) {
  const desc = norm([c.name, c.id, c.placeholder, c.aria, c.auto, c.label].join(' '));
  if (c.type === 'checkbox') return CONSENT_RE.test(desc) ? '__consent' : null;
  if (c.type === 'radio') return null;
  if (c.type === 'email' || /\be ?mail\b/.test(desc)) return 'email';
  if (c.type === 'tel' || /\b(phone|mobile|telephone|tel|cell|whatsapp|contact number)\b/.test(desc)) return 'phone';
  if (/\b(first name|firstname|fname|given name)\b/.test(desc)) return 'first_name';
  if (/\b(last name|lastname|lname|surname|family name)\b/.test(desc)) return 'last_name';
  if (/\b(full name|fullname|your name|name)\b/.test(desc) && !/\b(company|business|user ?name)\b/.test(desc)) return 'full_name';
  for (const col of Object.keys(d)) {
    const words = SYN[norm(col).replace(/ /g, '_')] || [norm(col)];
    if (words.some(w => new RegExp('\\b' + w + '\\b').test(desc))) return col;
  }
  if (c.tag === 'select') {          // unlabeled dropdown: match the column whose value is one of the options
    for (const col of Object.keys(d)) {
      const v = norm(d[col]);
      if (v && c.options.some(o => norm(o.text) === v || norm(o.value) === v)) return col;
    }
  }
  return null;
}

async function fillForm(page, data) {
  const controls = await describeControls(page);
  if (!controls.length) throw new Error('No form fields found on the page (it may use an embedded iframe or a multi-step form)');
  const unfilled = [];
  for (const c of controls) {
    const loc = page.locator(`[data-agent-idx="${c.idx}"]`);
    const role = roleOf(c, data);
    const label = c.label || c.placeholder || c.name || c.id || c.type;
    try {
      if (role === '__consent') { await loc.check({ timeout: 3000 }); continue; }
      const val = role ? valueFor(role, data) : '';
      if (c.tag === 'select') {
        const want = norm(val);
        const opt = c.options.find(o => want && (norm(o.text) === want || norm(o.value) === want)) ||
                    c.options.find(o => want && (norm(o.text).includes(want) || want.includes(norm(o.text)) && norm(o.text)));
        if (opt) await loc.selectOption({ value: opt.value }); else if (c.required) unfilled.push(label);
      } else if (c.type === 'checkbox' || c.type === 'radio') {
        if (c.required) unfilled.push(label);
      } else if (val) {
        await loc.fill(val, { timeout: 5000 });
      } else if (c.required) {
        unfilled.push(label);
      }
    } catch (e) { if (c.required) unfilled.push(label); }
  }
  if (unfilled.length) throw new Error('Could not fill required field(s): ' + unfilled.join(', ').slice(0, 80));
  return controls;
}

async function clickSubmit(page) {
  const found = await page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const re = /submit|register|sign ?up|apply|send|get started|continue|reserve|rsvp|book|join|enroll|request|notify|subscribe|next/i;
    const text = e => (e.value || e.textContent || '').trim();
    const cands = [...document.querySelectorAll('button,input[type=submit],input[type=button],[role=button]')].filter(vis);
    const pick = cands.find(e => e.type === 'submit' && re.test(text(e))) || cands.find(e => re.test(text(e))) || cands.find(e => e.type === 'submit');
    if (!pick) return false;
    pick.setAttribute('data-agent-submit', '1');
    return true;
  });
  if (!found) throw new Error('Could not find a submit button');
  await page.locator('[data-agent-submit="1"]').first().click({ timeout: 5000 });
}

const SUCCESS_RE = /thank you|thanks!|you'?re registered|you are registered|successfully (submitted|registered|received)|registration (complete|confirmed|successful|received)|we'?ve received|we have received|application (received|submitted)|you'?re all set|you'?re in\b|request (received|sent)/i;
async function waitForSuccess(page, preText, startUrl, probeIdx) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(500);
    if (page.url() !== startUrl) return 'page changed';
    let text, gone;
    try {
      text = await page.evaluate(() => document.body.innerText);
      gone = await page.evaluate(i => { const e = document.querySelector('[data-agent-idx="' + i + '"]'); if (!e) return true; const r = e.getBoundingClientRect(); return r.width === 0 || r.height === 0; }, probeIdx);
    } catch (e) { return 'page changed'; }
    if (SUCCESS_RE.test(text) && !SUCCESS_RE.test(preText)) return 'confirmation message';
    if (gone) return 'form closed';
  }
  const hints = await page.evaluate(() => ({
    invalid: document.querySelectorAll(':invalid').length,
    captcha: !!document.querySelector('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="turnstile"],.g-recaptcha,.h-captcha')
  })).catch(() => ({}));
  if (hints.invalid) throw new Error(`The page rejected the form (${hints.invalid} invalid field(s))`);
  if (hints.captcha) throw new Error('No confirmation: the page has a CAPTCHA/bot check, which the agent will not bypass');
  throw new Error('No confirmation after submitting (no thank-you message, redirect or closed form)');
}

async function submitLead(browser, data, row) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    const controls = await fillForm(page, data);
    const preText = await page.evaluate(() => document.body.innerText);
    const startUrl = page.url();
    await clickSubmit(page);
    return { how: await waitForSuccess(page, preText, startUrl, controls[0].idx) };
  } catch (e) {
    if (DEBUG) {
      fs.mkdirSync(path.join(DIR, 'screenshots'), { recursive: true });
      await page.screenshot({ path: path.join(DIR, 'screenshots', `row-${row}.png`), fullPage: true }).catch(() => {});
    }
    throw e;
  } finally { await ctx.close(); }
}

function resetData() {   // RESET=1: start a test from scratch
  fs.writeFileSync(RESULTS_FILE, line(['key', 'row', 'status', 'updated_at']));
  if (fs.existsSync(SIGNUPS_FILE)) {
    const rows = parseCSV(fs.readFileSync(SIGNUPS_FILE, 'utf8'));
    fs.writeFileSync(SIGNUPS_FILE, line(rows[0] || ['received_at']));
  }
  if (fs.existsSync(LEADS_FILE)) {
    const rows = parseCSV(fs.readFileSync(LEADS_FILE, 'utf8'));
    const s = rows[0].map(h => h.trim()).indexOf('Status');
    if (s >= 0) { rows.slice(1).forEach(r => { r[s] = ''; }); fs.writeFileSync(LEADS_FILE, rows.map(line).join('')); }
  }
  console.log('Reset: cleared results, signups and Status column');
}

process.on('unhandledRejection', e => { console.error('ERROR:', e.message || e); process.exit(1); });
(async () => {
  if (['1', 'true'].includes(String(process.env.RESET || '').toLowerCase())) resetData();
  checkPageUrl(PAGE_URL);
  if (CAMPAIGN) console.log('Campaign: ' + CAMPAIGN);
  console.log(`Leads: ${process.env.LEADS_JSON ? 'sent from the Google Sheet' : LEADS_URL ? 'sheet URL' : 'leads.csv'} | Page: ${USING_DEMO ? 'demo page' : new URL(PAGE_URL).host}`);
  const leads = await getPending(LIMIT);
  console.log(`Pending leads: ${leads.length}`);
  if (!leads.length) return;
  const browser = await chromium.launch();
  let ok = 0, fail = 0;
  for (const { row, data } of leads) {
    let status;
    try {
      const r = await submitLead(browser, data, row);
      status = 'Submitted ' + new Date().toISOString();
      appendSignup({ received_at: new Date().toISOString(), ...data });
      console.log(`Row ${row} (${mask(data.email)}): Submitted [${r.how}]`);
      ok++;
    } catch (e) {
      status = 'Failed: ' + e.message.split('\n')[0].slice(0, 120);
      console.log(`Row ${row} (${mask(data.email)}): ${status}`);
      fail++;
    }
    appendResult(keyOf(data), row, status);
    if (!LEADS_URL && !process.env.LEADS_JSON) setLeadsFileStatus(row, status);
    await sleep(DELAY_MS);
  }
  await browser.close();
  console.log(`Done. Submitted: ${ok}, Failed: ${fail}`);
  if (fail && !ok) process.exit(1);
})();
