# Lead agent: setup (about 15 minutes, all free)

## 1. Google Sheet + bridge
1. Create a Google Sheet. Rename the first tab to `Leads`. Import `sample-leads.csv` into it (File > Import > Replace current sheet).
2. Extensions > Apps Script. Paste all of `bridge.gs`. Change `TOKEN` to a long random string (save it, you need it in step 3). Save.
3. Deploy > New deployment > type: Web app > Execute as: Me > Who has access: Anyone > Deploy. Authorize when asked. Copy the Web app URL.
4. Open the Web app URL in a browser: you should see {"ok":true,"service":"lead bridge"}.

## 2. GitHub repo
1. Create a new GitHub repo (private is fine) and upload everything in this folder (keep the .github folder).
2. Repo > Settings > Secrets and variables > Actions > New repository secret:
   - BRIDGE_URL = the Web app URL
   - BRIDGE_TOKEN = the TOKEN from bridge.gs
   (Leave PAGE_URL out for the demo test.)

## 3. Test on the demo page
1. Repo > Actions > "Submit leads" > Run workflow.
2. Watch the log: each lead is submitted on the demo page.
3. In your Sheet: `Leads` tab Status column fills in, and a new `Signups` tab appears with every registration. That is the output.
4. It then runs by itself every 15 minutes. New rows with an empty Status get picked up automatically.

## 4. Switch to the real landing page
1. Set repo secret PAGE_URL to the real page.
2. Edit FIELDS, CONSENT_SEL, SUBMIT_SEL, SUCCESS_SEL at the top of agent.js to match the real form (right-click a field > Inspect to find ids/names).
3. Test with 2-3 rows first.

Notes: a stuck "Processing" status means a run was interrupted; clear the cell to retry. Only submit leads who opted in to this offer. CAPTCHAs are not bypassed.
