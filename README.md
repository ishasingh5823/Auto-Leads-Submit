# Auto Leads Submit

A GitHub agent that submits leads on a landing page form with a real browser, on a schedule or on demand.

## Run it
Actions > Submit leads > Run workflow. Fill in the form:
- **Landing page URL**: the page with the form (blank = the demo page in /demo).
- **Leads sheet link**: a Google Sheet or CSV link (blank = use leads.csv in this repo).
- **Reset**: tick when re-testing, to clear earlier results.
- **Debug**: saves a screenshot of any failed lead.

For the scheduled run (every 15 minutes), save the two links once as repository secrets named PAGE_URL and LEADS_URL (Settings > Secrets and variables > Actions).

## Leads sheet
Columns like: first_name, last_name, email, phone, city, slot (any extra columns are used if the form has a matching field).
A Google Sheet link only works if the sheet is shared as "Anyone with the link can view" (if your company allows it). Otherwise paste the leads into leads.csv.

## Output (committed back to this repo)
- results.csv: every lead tried, Submitted or Failed with the reason
- signups.csv: confirmed submissions
- leads.csv: Status column filled in (when using leads.csv)

## Limits
The agent finds the form fields itself (by label, placeholder, type). It does not bypass CAPTCHAs, and it can't handle multi-step forms or forms inside an embedded iframe. Only submit leads who opted in to this offer. This repo is public: do not put real lead data in it. Use a private repo for real leads.
