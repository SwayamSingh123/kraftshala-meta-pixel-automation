# Kraftshala Meta Pixel Automation (Cypress)

Drives the full lead-capture flow on every Kraftshala course page, captures every
Meta Pixel event from page load to lead creation, verifies the lead was really
created, and writes an HTML report for the marketing team.

Runs against **either platform**:

| Platform | Pages | Backend API |
|----------|-------|-------------|
| `test` (default) | `https://testprogram.kraftshala.com` | `https://testservice.kraftshala.com` |
| `main` (live) | `https://www.kraftshala.com` | `https://service.kraftshala.com` |

Both run the same pages, the same form and the same cleanup API — only the
hostnames differ.

> `main` is production: a run there creates real leads and fires real conversion
> events. The master OTP works on both platforms, and both fire the same pixels.

## Setup

```bash
npm install

npm test          # test platform, all pages
npm run test:main # main platform, all pages

npm run open      # interactive, test platform
npm run open:main # interactive, main platform
```

Run a subset by page id (several ids are joined with `+`, because Cypress splits
`--env` on commas):

```bash
npx cypress run --env platform=test,pages=mlp
npx cypress run --env platform=main,pages=mlp+basl
```

> **Windows note:** if Cypress fails with `bad option: --smoke-test`, the shell has
> `ELECTRON_RUN_AS_NODE=1` set, which makes `Cypress.exe` start as plain Node.
> Clear it for the run (`Remove-Item Env:ELECTRON_RUN_AS_NODE`).

## Run it from GitHub

`.github/workflows/pixel-report.yml` gives you one trigger per platform. Both
produce the same report, publish it to GitHub Pages and attach it to the run as
a downloadable artifact.

**Click to run:** Actions → *Meta Pixel Report* → **Run workflow** → pick
`test` or `main` (and optionally a page filter).

**HTTP trigger** — POST to the repo's `dispatches` endpoint with a token that has
`repo` scope:

```bash
# Test platform
curl -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/<owner>/<repo>/dispatches \
  -d '{"event_type":"pixel-test"}'

# Main platform
curl -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/<owner>/<repo>/dispatches \
  -d '{"event_type":"pixel-main"}'

# Optional page filter
  -d '{"event_type":"pixel-test","client_payload":{"pages":"mlp,basl"}}'
```

### Where the report lands

```
https://<owner>.github.io/<repo>/         index with both platforms
https://<owner>.github.io/<repo>/test/    latest test-platform report
https://<owner>.github.io/<repo>/main/    latest main-platform report
```

Each platform keeps its own folder, so running one never overwrites the other.

**One-time setup:** Settings → Pages → Source = *Deploy from a branch*, branch
`gh-pages`, folder `/ (root)`. The branch is created by the first run.

## Output

Locally, per platform:

- `cypress/reports/meta-pixel-report-<platform>.html` — the report
- `cypress/reports/meta-pixel-raw-<platform>.json` — raw capture for debugging

Only the newest run is kept. Each run deletes that platform's previous report,
raw data and screenshots before it starts; the other platform is left untouched.
On GitHub Pages each platform folder is overwritten the same way.

The HTML report is written for the marketing team and deliberately kept plain: a
summary table of all programmes, then one section per programme with
*"Lead created for this programme"* and a single table running down the journey
in order —

| | Pixel event | Fired by pixel ID |
|---|---|---|
| **1 Landing page opened** | | |
| | `PageView` — visitor opened the page | 848180154775619, 254822124949497 |
| **2 Lead form filled** | *No pixel fired here* | |
| **3 Details submitted** | `step1_submit` — visitor submitted their contact details | 848180154775619 |

Conversion events are highlighted and labelled, and the header carries a badge
saying which platform the run used. No API endpoints, payloads, selectors or
other build detail appear in it — that all goes to the JSON sidecar instead.

## Flow (per page)

1. **Delete the lead first** — `lead/remove-lead/<programSlug>/<email>` and
   `otp-validation/removeNumber/<phone>` on the platform's API, via `cy.request`
   so the calls never pollute the captured data. This runs for **every** page,
   against that page's own program slug and lead, and is asserted: if either
   cleanup call is missing or unreachable the test fails before the page is
   opened, so a run can never reuse a lead left behind by an earlier one.
2. Register the pixel + backend interceptors and wrap `window.fbq`.
3. Visit the page → `PageView` captured.
4. Fill name / email / phone / WhatsApp opt-in.
5. Submit → OTP screen → enter master OTP `159753` → verify.
6. Assert `POST /lead/create` returned 2xx.
7. Assert the page's own program slug matches the one cleanup used.

## Pages and leads

Each page has **its own lead** (name, email, phone) in
[`cypress/fixtures/pages.json`](cypress/fixtures/pages.json):

| id | Page | Program slug | Form type |
|----|------|--------------|-----------|
| `mlp` | `/marketing-launchpad/digital-marketing-course/` | `mlp` | MLP |
| `mlp-part-time` | `/marketing-launchpad/part-time-digital-marketing-course/` | `mlp_part` | PTDMM |
| `mlp-hindi` | `/marketing-launchpad/digital-marketing-course-in-hindi/` | `mlp` | MLP |
| `basl` | `/pgp/learn-sales-and-marketing/` | `basl` | BASL |
| `alm` | `/pgp-in-marketing/` | `alm` | ALM |

The same leads are used on both platforms. `programSlug` is what the cleanup API
deletes from; the run fails loudly if a page turns out to use a different one.

### Changing a phone number

The backend keeps an **email → phone** binding that can only be cleared *by
number*. If you give a page a new phone, move the old one into
`lead.retiredPhones` so cleanup frees it too — otherwise the OTP step is rejected
with *"The phone number associated with … is xxxxxx####"*. The run detects that
case and says exactly which number to retire.

## Selectors

All selectors live in `SELECTORS` in
[`cypress/support/commands.js`](cypress/support/commands.js), and are identical
on both platforms:

| Element | Selector |
|---------|----------|
| Name | `input[name="name"]` |
| Email | `input[name="email"]` |
| Phone | `input.PhoneInputInput[type="tel"]:not([readonly])` |
| WhatsApp opt-in | `input[name="opt_in"][value="Yes"]`, `input[name="marketing_exp"][value="Yes"]` |
| Submit | `button.submit-btn[type="submit"]` |
| OTP | `input.otp-input` |
| Verify OTP | `button.verify-otp-btn` |

Fields are resolved inside the smallest container holding name + email + phone +
submit, so a page rendering two copies of the form cannot mix them. The phone
field is skipped until hydration removes its `readonly` attribute, and the
opt-in radio is matched without a visibility check because it is styled away
behind a custom control.

If an element cannot be found, the run fails with the exact selectors it tried.

## Files

```
.github/workflows/pixel-report.yml      click / HTTP trigger per platform
cypress.config.js                       platform hosts + report writing
cypress/e2e/meta-pixel-tracking.cy.js   the flow, one test per page
cypress/fixtures/pages.json             pages + per-page lead details
cypress/support/commands.js             cleanup, capture, element resolution, form steps
cypress/support/pixel-capture.js        capture store + beacon parsing
shared/pixel-events.js                  what each pixel event means + conversions
reporter/generateReport.js              the marketing-facing HTML report
reporter/buildIndex.js                  landing page listing both platforms
```
