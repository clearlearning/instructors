# CLEAR Learning Instructor Availability Portal

Instructors mark which program sessions they can teach. Staff review answers, select instructors, and send announcements, reminders, and selection notices. The Program Agenda Generator lives here too, so coordinators can send cohorts straight into the portal.

Hosted on Cloudflare Pages, with sign-in through Cloudflare Access (one-time email code) and data stored in Cloudflare KV.

## Pages

| Address | File | Who can open it |
|---|---|---|
| `/` | `index.html` | Instructors (and staff) |
| `/admin-dashboard` | `admin-dashboard.html` | Staff only |
| `/agenda-generator` | `agenda-generator.html` | Staff only |
| `/api/*` | `functions/api/[[path]].js` | Used by the pages above |

The double square brackets in `[[path]].js` are required. They tell Cloudflare that this one file handles every address under `/api/`.

## How a batch gets into the portal

1. A coordinator opens the Agenda Generator from the admin dashboard.
2. They build the quarter batch from the TeamGantt export.
3. They click **Send to availability portal**. The cohorts arrive in the admin dashboard as drafts.
4. Staff review the drafts, open them, and announce them to instructors.

Sending the same cohort again updates it in place. Instructors' answers are kept.

## Cloudflare setup

**Binding** (Pages project > Settings > Bindings)

- `IA_KV`: KV namespace

**Required variables** (Pages project > Settings > Variables and Secrets)

- `ACCESS_TEAM_DOMAIN`: e.g. `yourteam.cloudflareaccess.com` (no https://)
- `ACCESS_AUD`: AUD tag of each Access application in front of this site, comma-separated
- `ADMIN_EMAILS`: comma-separated; these people are always staff and can edit the staff list

**Email** (optional; turns on the Announce, Remind, and Selection buttons)

- `NOTIFY_FLOW_URL` (Secret): HTTP POST URL of the Power Automate flow that sends email
- `NOTIFY_MAILBOX`: shared mailbox the flow sends from
- `PORTAL_URL`: link used in emails (defaults to this site's address)

**Other optional settings**

- `STAFFING_DASHBOARD_URL`: full URL of the Instructor Staffing Dashboard
- `CF_ACCOUNT_ID`, `CF_ACCESS_GROUP_ID`, `CF_API_TOKEN` (Secret): keep the "CLEAR Instructors" Access group in step with the roster automatically

After adding or changing variables, go to Deployments and click **Retry deployment** on the latest deployment. Changes only take effect in a new deployment.

## Access applications

- **Instructor Availability – Instructors** covers the whole site. Allow the instructor group and staff.
- **Instructor Availability – Staff** covers the `/admin-dashboard` and `/agenda-generator` paths. Allow staff only.

Put the AUD tag of both applications in `ACCESS_AUD`.

## Notes

- Answers lock after each program's response date (30 days before the first live session, unless set by hand). Staff can still enter answers for instructors after that.
- The Agenda Generator saves its TalentLMS connection and any batch in progress in the browser. Those settings don't carry over from the old GitHub Pages address.
- Questions: clearlearning@clearhq.org
