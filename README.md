# Lead Agent (team engine)

Submits leads on landing pages with a real browser, for many campaigns at once.

    Meta lead lands in a campaign's Google Sheet
      -> the sheet (Lead Agent menu) tells GitHub
      -> this engine opens the landing page and fills the form
      -> the result comes back to the sheet's Results tab, Status column and the team Console

Nothing is made public: the sheet only makes outbound calls to GitHub.

## Admin setup (once)
1. **Repo**: create a PRIVATE repository under Joveo's GitHub and upload these files (keep the .github folder). Lead details are saved in data/<campaign>/results.csv, so never use a public repo for real leads.
2. **Actions**: Settings > Actions > General > Workflow permissions: Read and write.
3. **Team token**: create a fine-grained personal access token (ideally from a shared service account): this repo only, Repository permissions > Contents: Read and write, with an expiry date. Teammates paste it once into their campaign sheet.
4. **Approved domains (optional, recommended)**: Settings > Secrets and variables > Actions > Variables > ALLOWED_HOSTS = comma-separated client domains, e.g. ashleyfurniture.com,baptisthealth.net. The agent refuses any other landing page.
5. **Template sheet**: open the template, Extensions > Apps Script, paste TeamSheet.gs, set GITHUB_OWNER and GITHUB_REPO at the top, save. Share it with the team (view access is enough, they make their own copy). Keep the Leads tab FIRST.
6. **Console**: open the Lead Agent Console page, set the template link, repo link and who hands out the token (Team settings). Share the page with the team as Contributor so they can add campaigns.

## Teammate steps (per campaign, about 2 minutes)
1. Make a copy of the template sheet.
2. Settings tab: type the campaign name and the landing page URL.
3. Lead Agent > Connect to GitHub (paste the team token), then Lead Agent > Start.
4. Send Meta leads into the Leads tab (headers like full_name, email, phone_number, city; extra columns are used if the form asks for them).
5. Add the campaign in the Console so everyone can follow it.

To retry a failed lead, clear its Status cell. Lead Agent > Pause stops sending.

## Files
- agent.js: the engine. Finds form fields by label, placeholder and type; no per-page code.
- TeamSheet.gs: the Google Sheet side (menu, Settings, Results).
- .github/workflows/submit-leads.yml: runs on each "new-leads" event from a sheet.
- data/<campaign>/: results.csv and signups.csv per campaign.
- test/: checks for the sheet script (node test/team-harness.js).

## Limits
Does not bypass CAPTCHAs, and can't handle multi-step forms or forms inside an embedded iframe. Only submit leads who opted in to the offer being submitted. Real-time here means about 1-3 minutes.
