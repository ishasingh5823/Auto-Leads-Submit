# Auto Leads Submit

A GitHub agent that submits leads on a landing page form with a real browser. It runs in real time from a Google Sheet, on a schedule, or on demand.

## Real time from a Google Sheet (recommended)
Meta lead arrives in the Google Sheet -> the sheet tells GitHub -> GitHub submits it on the landing page -> the result appears in the sheet's Results tab (usually 1-3 minutes). Nothing is made public.

One-time setup:
1. **GitHub token**: GitHub > your profile > Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token. Repository access: only this repo. Permissions > Repository permissions > Contents: Read and write. Copy the token.
2. **Landing page**: Settings > Secrets and variables > Actions > New repository secret: PAGE_URL = the landing page link.
3. **Google Sheet**: a tab named Leads with headers in row 1 (e.g. full_name, email, phone_number, city). Extensions > Apps Script > paste LeadsRealtime.gs, set GITHUB_OWNER and GITHUB_REPO at the top, Save. Project Settings (gear) > Script properties > add GITHUB_TOKEN = your token. Run setup() once and approve.

You will see a Results tab appear, and the Status column in Leads fill in (Queued, then Submitted or Failed with the reason).

## Run it by hand
Actions > Submit leads > Run workflow. Optional fields: landing page URL, leads sheet/CSV link, Reset (clear earlier results when re-testing), Debug (screenshot of failed leads). Leave all blank to test on the demo page.

## Output (committed back to this repo)
results.csv (every lead tried, with reason if failed), signups.csv (confirmed submissions).

## Limits
The agent finds the form fields itself (by label, placeholder, type). It does not bypass CAPTCHAs, and it can't handle multi-step forms or forms inside an embedded iframe. Only submit leads who opted in to this offer. Never run real lead data through a public repo: use a private repo (lead details travel in the GitHub event and are saved in results.csv).
