/* CLEAR Learning Instructor Portal — API
   Cloudflare Pages Function. File path in the repo: functions/api/[[path]].js
   Serves every request under /api/*.

   Bindings (Pages project > Settings > Bindings)
     IA_KV                  KV namespace

   Variables (Pages project > Settings > Variables and Secrets)
     ACCESS_TEAM_DOMAIN     e.g. yourteam.cloudflareaccess.com (no https://)
     ACCESS_AUD             AUD tag of each Access application in front of this site, comma-separated
     ADMIN_EMAILS           comma-separated; always staff + can edit the staff list

   Email (optional, turns on the Announce / Remind / Selection email buttons)
     NOTIFY_FLOW_URL        (Secret) HTTP POST URL of the Power Automate flow that sends the email
     NOTIFY_MAILBOX         the shared mailbox the flow sends from, e.g. clearlearning@clearhq.org
     PORTAL_URL             link put in emails, e.g. https://<portal domain> (defaults to this site)

   Automatic reminders (optional; called once a day by the instructor-availability-cron Worker)
     CRON_SECRET            (Secret) shared with the cron Worker; must match its CRON_SECRET
     REMINDER_DAYS          days before the response date to remind non-responders (default 7,2)

   Zoom links (optional; finds the attendee link for each live session from the meetings TalentLMS creates)
     ZOOM_ACCOUNT_ID        Account ID of the Zoom Server-to-Server OAuth app
     ZOOM_CLIENT_ID         Client ID of that app
     ZOOM_CLIENT_SECRET     (Secret) Client Secret of that app
     ZOOM_USER              the Zoom user TalentLMS creates meetings under (default clearlearning@clearhq.org)

   Expenses and hours (optional; instructors submit through the CLEAR expense system)
     EXPENSE_WORKER_URL     the expense system Worker, e.g. https://clear-lms-proxy.avance.workers.dev
     EXPENSE_TOKEN          (Secret) the expense admin's X-Auth-Token; lets the portal read report status and the private instructor list

   Instructor Staffing Dashboard link (optional)
     STAFFING_DASHBOARD_URL full URL of instructor-staffing.html

   Optional, to keep the Access group in step with the roster
     CF_ACCOUNT_ID          Cloudflare account ID
     CF_ACCESS_GROUP_ID     ID of the "CLEAR Instructors" Access group
     CF_API_TOKEN           (Secret) token with Access: Organizations, Identity Providers, and Groups — Edit
*/

const VALS = ['A', 'N', 'NA'];
const ROLES = ['Lead', 'Co-instructor', 'Backup'];
const STATUSES = ['draft', 'open', 'closed', 'archived'];
const PROGRAM_SLOT = '__program';
const ET = 'America/New_York';
const DEADLINE_DAYS = 30;
const MAX_ICS = 900_000;
const TRACKS = ['ncit', 'blue', 'gold', 'none'];
// Program track sets the colour band on both dashboards: NCIT = burgundy, ELPR & SRA = blue, ACRG, IRG & Board Chair = gold.
// The program logo (in /images of this repo) tells individual programs apart.
const TRACK_BY_COURSE = {
  '126': 'ncit', '128': 'ncit', 'ip-ncit-b-us': 'ncit', 'ip-ncit-b-can': 'ncit', '129': 'ncit', 'ip-ncit-s': 'ncit', 'ip-ncit-ait': 'ncit',
  'ncit-workshop-series': 'ncit', '146': 'ncit', '157': 'ncit', '169': 'ncit', '143': 'ncit',
  '138': 'blue', '147': 'blue', '142': 'gold', '165': 'gold'
};
function autoTrack(p) {
  const byId = TRACK_BY_COURSE[String(p.courseId || '')];
  if (byId) return byId;
  const t = String(p.title || '');
  if (/NCIT|Investigat|Drug Diversion|Sexual Misconduct|Ethics for the Regulatory|Art of Persuasion/i.test(t)) return 'ncit';
  if (/Executive Leadership|\bELPR\b|Staffing a Board|\bSRA\b/i.test(t)) return 'blue';
  if (/Advanced Concepts|\bACRG\b|Getting the Most|Board Chair|Chairing|Introduction to Regulatory Governance|\bIRG\b/i.test(t)) return 'gold';
  return 'none';
}
const LOGO_DIR = '/images/';
const LOGO_BY_COURSE = {
  '126': 'NCITB', '128': 'NCITB', 'ip-ncit-b-us': 'NCITB', 'ip-ncit-b-can': 'NCITB',
  '129': 'NCITS', 'ip-ncit-s': 'NCITS', 'ip-ncit-ait': 'NCITAIT',
  'ncit-workshop-series': 'NCITWS', '169': 'NCITWDDI', '143': 'NCITWIRSM', '146': 'NCITWCSAP', '157': 'NCITWERI',
  '147': 'SRASAB', '142': 'ACRG', '138': 'ELPR', '165': 'BCT'
};
const LOGO_BY_TITLE = [
  [/Applied Investigative|\bAIT\b/i, 'NCITAIT'], [/Workshop Series/i, 'NCITWS'], [/Drug Diversion/i, 'NCITWDDI'], [/Sexual Misconduct/i, 'NCITWIRSM'],
  [/Art of Persuasion|Communications/i, 'NCITWCSAP'], [/Ethics/i, 'NCITWERI'], [/Specialized/i, 'NCITS'], [/NCIT.*Basic|Basic.*NCIT/i, 'NCITB'],
  [/Staffing a Board|\bSRA\b/i, 'SRASAB'], [/Advanced Concepts|\bACRG\b/i, 'ACRG'], [/Executive Leadership|\bELPR\b/i, 'ELPR'],
  [/Getting the Most|Board Chair/i, 'BCT'], [/Introduction to Regulatory Governance|\bIRG\b/i, 'IRG']
];
const LOGO_NAMES = ['NCITB', 'NCITS', 'NCITAIT', 'NCITWS', 'NCITWDDI', 'NCITWIRSM', 'NCITWCSAP', 'NCITWERI', 'SRASAB', 'ACRG', 'ELPR', 'BCT', 'IRG'];
// The course a program belongs to (also its logo file name). Teaching approvals are kept per course.
function courseKeyOf(p) {
  return (LOGO_NAMES.includes(p.logoSet) && p.logoSet) || LOGO_BY_COURSE[String(p.courseId || '')] || (LOGO_BY_TITLE.find(r => r[0].test(String(p.title || ''))) || [])[1] || '';
}
function logoOf(p) { const name = courseKeyOf(p); return name ? LOGO_DIR + name + '.svg' : ''; }
// Is this instructor approved to teach this program? No approvals recorded = approved for everything.
// A program with no recognised course is open to everyone. The Workshop Series is open to anyone approved for any workshop.
const DELIVERY = ['online', 'in-person', 'both'];
const isInPerson = p => /person/i.test(p.format || '') && !/hybrid/i.test(p.format || '');
const isHybrid = p => /hybrid/i.test(p.format || '');
function eligible(inst, prog) {
  // Delivery preference the instructor stated: online only, in person only, or both (not stated = both).
  const d = inst && inst.delivery;
  if (d === 'online' && isInPerson(prog)) return false;
  if (d === 'in-person' && !isInPerson(prog) && !isHybrid(prog)) return false;
  const q = (inst && inst.quals) || [];
  if (!q.length) return true;
  const key = courseKeyOf(prog);
  if (!key || q.includes(key)) return true;
  return key === 'NCITWS' && q.some(k => /^NCITW/.test(k));
}
// Instructors attend the Welcome session only in ACRG, ELPR and SRA: Staffing a Board. Everywhere else it is removed.
function keepsWelcome(p) {
  if (['142', '138', '147'].includes(String(p.courseId || ''))) return true;
  return /Advanced Concepts|\bACRG\b|Executive Leadership|\bELPR\b|Staffing a Board|\bSRA\b/i.test(String(p.title || ''));
}
const isWelcome = s => /^\s*welcome\b/i.test(String(s.title || ''));
let certCache = { keys: null, at: 0 };

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const method = request.method.toUpperCase();

  try {
    if (!env.IA_KV) throw httpErr(500, 'The KV binding IA_KV is missing on this Pages project. Add it under Settings > Bindings, then redeploy.');
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw httpErr(500, 'Access verification isn\'t configured. Add ACCESS_TEAM_DOMAIN and ACCESS_AUD, then redeploy.');

    const ident = await verifyAccess(request, env);
    if (!ident) return json({ error: 'Your sign-in expired or is missing. Reload the page to sign in again.' }, 401);
    if (typeof ident === 'object') {
      // An Access service token (the daily cron Worker). It may only run the reminder job, and must also present CRON_SECRET.
      const ok = parts[0] === 'cron' && parts[1] === 'reminders' && env.CRON_SECRET && safeEq(request.headers.get('X-Cron-Secret') || '', env.CRON_SECRET);
      if (!ok) return json({ error: 'Not allowed.' }, 403);
      const dry = url.searchParams.get('dry') === '1';
      let zoom = { configured: zoomConfigured(env) };
      if (zoom.configured) { try { zoom = await zoomSync(env, { dry, by: 'daily check' }); } catch (e) { zoom = { configured: true, error: e.message }; } }
      const reminders = await runReminders(env, url);
      return json({ ...reminders, zoom });
    }
    const email = ident;

    const me = await whoAmI(email, env);
    if (!me.isStaff && !me.instructor) {
      return json({ error: `${email} isn't on the CLEAR Learning instructor list. Contact CLEAR Learning staff if you think this is a mistake.` }, 403);
    }
    me.origin = String(env.PORTAL_URL || url.origin).replace(/\/+$/, '');

    const body = (method === 'GET' || method === 'DELETE') ? null : await request.json().catch(() => ({}));
    const [a, b, c, d] = parts;

    // ---------- Instructor routes ----------
    if (a === 'me' && method === 'GET') return json(publicMe(me));

    if (a === 'portal' && method === 'GET') {
      return json(await portal(env, me, url.searchParams.get('as')));
    }

    if (a === 'response' && b && method === 'PUT') {
      if (!me.instructor) throw httpErr(403, 'Your email isn\'t linked to an instructor record, so there\'s nothing to save. Staff can enter answers from the dashboard.');
      return json(await saveResponse(env, me.instructor, b, body, me.email, false));
    }

    if (a === 'profile' && method === 'PUT') {
      if (!me.instructor) throw httpErr(403, 'Your email isn\'t linked to an instructor record.');
      return json(await saveDelivery(env, me.instructor.id, body.delivery, me.email, false));
    }

    if (a === 'report' && b && method === 'GET') return await viewReport(env, b, me);

    if (a === 'expense') {
      if (!env.EXPENSE_WORKER_URL) throw httpErr(501, 'Expense submission isn\'t set up yet.');
      let inst = me.instructor;
      const asId = url.searchParams.get('as');
      if (asId && me.isStaff) inst = me.roster.find(r => r.id === asId) || null;
      if (!inst) throw httpErr(403, 'Your email isn\'t linked to an instructor record.');
      if (b === 'context' && method === 'GET') return json(await expenseContext(env, inst, url.searchParams.get('pid'), me));
      if (b === 'submit' && method === 'POST') {
        if (asId) throw httpErr(403, 'Staff previews can\'t submit reports.');
        return json(await expenseSubmit(env, inst, body, me));
      }
      if (b === 'status' && method === 'GET') return json(await expenseStatus(env, inst));
    }

    if (a === 'my-ics' && b && method === 'GET') {
      let inst = me.instructor;
      const asId = url.searchParams.get('as');
      if (asId && me.isStaff) inst = me.roster.find(r => r.id === asId) || null;
      if (!inst) throw httpErr(403, 'Your email isn\'t linked to an instructor record.');
      const out = await instructorIcs(env, b, inst, true);
      return icsResponse(out.ics, out.name);
    }

    // ---------- Staff routes ----------
    if (a === 'admin') {
      if (!me.isStaff) throw httpErr(403, 'This area is for CLEAR Learning staff.');

      if (b === 'data' && method === 'GET') return json(await adminData(env, me));

      if (b === 'program' && c && method === 'PUT') return json(await saveProgram(env, c, body, me.email));
      if (b === 'program' && c && method === 'DELETE') return json(await deleteProgram(env, c, me.email));

      if (b === 'import' && method === 'POST') return json(await importPrograms(env, body, me));
      if (b === 'import-package' && method === 'POST') return json(await importPackage(env, body, me));

      if (b === 'ics' && c && method === 'PUT') return json(await putProgramIcs(env, c, body, me.email));
      if (b === 'ics' && c && method === 'DELETE') return json(await deleteProgramIcs(env, c, me.email));
      if (b === 'ics' && c && method === 'GET') {
        const iid = url.searchParams.get('iid');
        if (iid) {
          const inst = me.roster.find(r => r.id === iid);
          if (!inst) throw httpErr(404, 'That instructor isn\'t on the roster.');
          const out = await instructorIcs(env, c, inst, true);
          return icsResponse(out.ics, out.name);
        }
        const prog = await getJSON(env, 'program:' + c, null);
        if (!prog) throw httpErr(404, 'That program doesn\'t exist.');
        const stored = await env.IA_KV.get('ics:' + c);
        return icsResponse(stored || buildIcs(prog, prog.sessions || []), fileSafe(prog.title) + '.ics');
      }

      if (b === 'roster' && method === 'PUT') return json(await saveRoster(env, body, me));
      if (b === 'sync-access' && method === 'POST') return json(await syncAccess(env, await getJSON(env, 'roster', [])));

      if (b === 'staff' && method === 'PUT') {
        if (!me.isAdmin) throw httpErr(403, 'Only admins can change the staff list.');
        return json(await saveStaff(env, body, me.email));
      }

      if (b === 'response' && c && d && method === 'PUT') {
        const inst = me.roster.find(r => r.id === c);
        if (!inst) throw httpErr(404, 'That instructor isn\'t on the roster.');
        return json(await saveResponse(env, inst, d, body, me.email, true));
      }

      if (b === 'assignment' && c && method === 'PUT') return json(await saveAssignment(env, c, body, me));
      if (b === 'note' && c && method === 'POST') return json(await addNote(env, c, body, me.email));

      if (b === 'notify' && c === 'announce' && method === 'POST') return json(await notifyAnnounce(env, body, me));
      if (b === 'notify' && c === 'remind' && method === 'POST') return json(await notifyRemind(env, body, me));
      if (b === 'notify' && c === 'selection' && d && method === 'POST') return json(await notifySelection(env, d, body, me));
      if (b === 'notify' && c === 'change' && d && method === 'POST') return json(await notifyChange(env, d, body, me));
      if (b === 'notify' && c === 'custom' && method === 'POST') return json(await notifyCustom(env, body, me));

      if (b === 'zoom' && c === 'sync' && method === 'POST') {
        if (!zoomConfigured(env)) throw httpErr(501, 'Zoom isn\'t connected yet. Add ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET in the Pages project settings, then redeploy.');
        return json(await zoomSync(env, { pid: body.pid || '', by: me.email }));
      }
      if (b === 'zoom' && c === 'assign' && method === 'POST') return json(await zoomAssign(env, body, me.email));

      if (b === 'reports' && method === 'POST') return json(await publishReports(env, body, me));
      if (b === 'reports' && method === 'GET') return json(await listReports(env, me));
      if (b === 'report' && c && method === 'DELETE') return json(await withdrawReport(env, c, me.email));

      if (b === 'schedule' && method === 'GET') return json(await getSchedule(env));
      if (b === 'schedule' && method === 'PUT') return json(await putSchedule(env, body, me.email));

      if (b === 'log' && method === 'GET') return json(await readLog(env));
    }

    return json({ error: 'Not found.' }, 404);
  } catch (e) {
    return json({ error: e.message || 'Server error.' }, e.status || 500);
  }
}

/* ======================= Access (zero trust) ======================= */

async function verifyAccess(request, env) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || getCookie(request, 'CF_Authorization');
  if (!token) return null;
  const segs = token.split('.');
  if (segs.length !== 3) return null;

  let header, payload;
  try {
    header = JSON.parse(b64urlText(segs[0]));
    payload = JSON.parse(b64urlText(segs[1]));
  } catch { return null; }

  let jwk = (await getCerts(env, false)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await getCerts(env, true)).find(k => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(segs[2]),
    new TextEncoder().encode(segs[0] + '.' + segs[1]));
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) return null;
  if (payload.iss !== 'https://' + teamDomain(env)) return null;

  const allowed = String(env.ACCESS_AUD).split(',').map(s => s.trim()).filter(Boolean);
  const tokenAud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!tokenAud.some(x => allowed.includes(x))) return null;

  const email = String(payload.email || '').trim().toLowerCase();
  if (email) return email;
  if (payload.common_name) return { service: String(payload.common_name) }; // service token: no email in the token
  return null;
}

function teamDomain(env) {
  return String(env.ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

async function getCerts(env, force) {
  if (!force && certCache.keys && Date.now() - certCache.at < 3600_000) return certCache.keys;
  const r = await fetch(`https://${teamDomain(env)}/cdn-cgi/access/certs`);
  if (!r.ok) throw httpErr(500, 'Couldn\'t load Access signing keys. Check ACCESS_TEAM_DOMAIN.');
  const j = await r.json();
  certCache = { keys: j.keys || [], at: Date.now() };
  return certCache.keys;
}

async function whoAmI(email, env) {
  const admins = String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const staff = await getJSON(env, 'config:staff', []);
  const roster = await getJSON(env, 'roster', []);
  const staffRec = staff.find(s => String(s.email).toLowerCase() === email);
  const isAdmin = admins.includes(email);
  const instructor = roster.find(r => r.active !== false && (r.emails || []).some(e => String(e).toLowerCase() === email)) || null;
  return {
    email, isAdmin, isStaff: isAdmin || !!staffRec,
    staffName: staffRec ? staffRec.name || '' : '',
    instructor, roster, staff, admins
  };
}

function publicMe(me) {
  return {
    email: me.email, isStaff: me.isStaff, isAdmin: me.isAdmin, staffName: me.staffName,
    instructor: me.instructor ? { id: me.instructor.id, name: me.instructor.name } : null
  };
}

/* ======================= Deadlines ======================= */

function todayET() {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function firstLive(p) {
  return [...(p.sessions || []).map(s => s.date), p.startDate].filter(Boolean).sort()[0] || '';
}
const answerable = p => (p.sessions || []).filter(s => !s.allInstructors);
function pastDeadline(p, today) { return !!(p.deadline && (today || todayET()) > p.deadline); }
function isLocked(p, today) { return p.status !== 'open' || pastDeadline(p, today); }
function withState(p, today) {
  return { ...p, track: trackOf(p), logo: logoOf(p), courseKey: courseKeyOf(p), pastDeadline: pastDeadline(p, today), locked: isLocked(p, today) };
}
// Programs saved before tracks existed have no stored track, so work it out on every read.
function trackOf(p) { return (p.trackSet && TRACKS.includes(p.trackSet) && p.trackSet) || autoTrack(p); }

/* ======================= Instructor portal ======================= */

async function portal(env, me, asId) {
  let inst = me.instructor;
  let viewingAs = false;
  if (asId && me.isStaff) {
    inst = me.roster.find(r => r.id === asId) || null;
    viewingAs = true;
  }
  const today = todayET();
  const all = await listPrograms(env);
  const programs = all.filter(p => (p.status === 'open' || p.status === 'closed') && (!inst || eligible(inst, p))).map(p => withState(p, today));
  if (!inst) return { me: publicMe(me), instructor: null, viewingAs, today, programs, responses: {}, assignments: [] };
  const instOut = { id: inst.id, name: inst.name, delivery: inst.delivery || '', deliveryAt: inst.deliveryAt || '' };

  const rec = await getJSON(env, 'resp:' + inst.id, { programs: {} });
  const responses = {};
  for (const [pid, r] of Object.entries(rec.programs || {})) {
    responses[pid] = { program: r.program || '', sessions: r.sessions || {}, comment: r.comment || '', updatedAt: r.updatedAt, updatedBy: r.updatedBy };
  }

  const assignments = [];
  const visible = all.filter(p => p.status !== 'draft');
  const assigns = await Promise.all(visible.map(p => getJSON(env, 'assign:' + p.id, null)));
  visible.forEach((p, i) => {
    const as = assigns[i];
    if (!as || !as.slots) return;
    for (const [slot, list] of Object.entries(as.slots)) {
      for (const e of list || []) {
        if (e.iid !== inst.id || e.status !== 'Confirmed') continue;
        const s = slot === PROGRAM_SLOT ? null : (p.sessions || []).find(x => x.id === slot);
        if (slot !== PROGRAM_SLOT && !s) continue;
        assignments.push(assignRow(p, slot, s, e.role));
      }
    }
    if (assignments.some(x => x.programId === p.id)) {
      for (const s of (p.sessions || []).filter(x => x.allInstructors)) assignments.push(assignRow(p, s.id, s, 'All instructors attend'));
    }
  });
  assignments.sort((x, y) => String(x.date).localeCompare(String(y.date)) || toMin(x.start) - toMin(y.start));

  const reports = (await getJSON(env, 'reports:' + inst.id, [])).map(r => ({ ...r, url: me.origin + '/api/report/' + r.slug }));
  const expenses = env.EXPENSE_WORKER_URL ? { enabled: true, submitted: await getJSON(env, 'expsub:' + inst.id, []) } : { enabled: false, submitted: [] };
  return { me: publicMe(me), instructor: instOut, viewingAs, today, programs, responses, assignments, reports, expenses };
}

function assignRow(p, slot, s, role) {
  return {
    programId: p.id, programTitle: p.title, cohort: p.cohort || '', track: trackOf(p), logo: logoOf(p), format: p.format, location: p.location, timezone: p.timezone,
    sessionId: slot, sessionTitle: s ? s.title : 'Entire program',
    date: s ? s.date : p.startDate, endDate: s ? (s.endDate || s.date) : p.endDate, start: s ? s.start : '', end: s ? s.end : '',
    zoomLink: s ? s.zoomLink || '' : '', role, hasIcs: !!p.hasIcs
  };
}

async function saveResponse(env, inst, pid, body, by, staffEntry) {
  const prog = await getJSON(env, 'program:' + pid, null);
  if (!prog || prog.status === 'draft') throw httpErr(404, 'That program isn\'t available.');
  if (!staffEntry && prog.status !== 'open') {
    throw httpErr(409, 'Responses for this program are closed. Contact CLEAR Learning staff to make a change.');
  }
  if (!staffEntry && !eligible(inst, prog)) {
    throw httpErr(403, 'This program isn\'t on your list of approved programs. Contact CLEAR Learning staff if you would like to teach it.');
  }
  if (!staffEntry && pastDeadline(prog)) {
    throw httpErr(409, `The response deadline for this program (${longDate(prog.deadline)}) has passed. Contact CLEAR Learning staff to make a change.`);
  }
  body = body || {};
  const program = cleanVal(body.program);
  const sessions = {};
  for (const s of answerable(prog)) {
    const v = cleanVal(body.sessions && body.sessions[s.id]);
    if (v) sessions[s.id] = v;
  }
  const comment = String(body.comment || '').slice(0, 2000);

  const key = 'resp:' + inst.id;
  const rec = await getJSON(env, key, { programs: {} });
  rec.programs = rec.programs || {};
  const prev = rec.programs[pid];
  const history = prev ? (prev.history || []).slice(-24) : [];
  if (prev) history.push({ at: prev.updatedAt, by: prev.updatedBy, program: prev.program, sessions: prev.sessions, comment: prev.comment });

  const now = new Date().toISOString();
  rec.programs[pid] = { program, sessions, comment, updatedAt: now, updatedBy: by + (staffEntry ? ' (staff entry)' : ''), firstAt: prev ? (prev.firstAt || prev.updatedAt) : now, history };
  await putJSON(env, key, rec);
  await log(env, by, staffEntry ? 'Entered availability for an instructor' : (prev ? 'Changed availability' : 'Saved availability'), `${inst.name}: ${prog.title}`);
  return { ok: true, response: { program, sessions, comment, updatedAt: now, updatedBy: rec.programs[pid].updatedBy } };
}

function cleanVal(v) { return VALS.includes(v) ? v : ''; }

/* ======================= Staff: data ======================= */

async function adminData(env, me) {
  const today = todayET();
  const programs = (await listPrograms(env)).map(p => withState(p, today));
  const responses = {};
  const recs = await Promise.all(me.roster.map(r => getJSON(env, 'resp:' + r.id, { programs: {} })));
  me.roster.forEach((r, i) => {
    const out = {};
    for (const [pid, x] of Object.entries(recs[i].programs || {})) {
      out[pid] = { program: x.program || '', sessions: x.sessions || {}, comment: x.comment || '', updatedAt: x.updatedAt, updatedBy: x.updatedBy, changes: (x.history || []).length };
    }
    responses[r.id] = out;
  });
  const assigns = await Promise.all(programs.map(p => getJSON(env, 'assign:' + p.id, null)));
  const assignments = {};
  programs.forEach((p, i) => {
    const a = assigns[i] || { slots: {}, notes: [], history: [], notified: {} };
    a.changes = scheduleChanges(p, a);
    assignments[p.id] = a;
  });
  const zoomLast = await getJSON(env, 'zoom:last', null), zoomReview = await getJSON(env, 'zoom:review', { items: [] });
  return {
    me: publicMe(me), today,
    zoom: { last: zoomLast, review: (zoomReview.items || []).filter(i => { const p = programs.find(x => x.id === i.pid); const s = p && (p.sessions || []).find(x => x.id === i.sid); return s && !s.zoomLink; }), missing: missingLinks(programs, today) },
    programs, roster: me.roster, responses, assignments,
    staff: me.staff, admins: me.admins,
    accessSync: !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CF_ACCESS_GROUP_ID),
    config: {
      email: !!(env.NOTIFY_FLOW_URL && env.NOTIFY_MAILBOX),
      mailbox: env.NOTIFY_MAILBOX || '',
      portalUrl: me.origin,
      staffingUrl: env.STAFFING_DASHBOARD_URL || '',
      expenses: !!env.EXPENSE_WORKER_URL,
      zoom: zoomConfigured(env),
      deadlineDays: DEADLINE_DAYS,
      autoReminders: !!env.CRON_SECRET,
      reminderDays: reminderDays(env)
    }
  };
}

async function listPrograms(env) {
  const keys = [];
  let cursor;
  do {
    const r = await env.IA_KV.list({ prefix: 'program:', cursor });
    keys.push(...r.keys.map(k => k.name));
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  const progs = (await Promise.all(keys.map(k => getJSON(env, k, null)))).filter(Boolean);
  progs.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)) || String(a.title).localeCompare(String(b.title)));
  return progs;
}

/* ======================= Staff: programs ======================= */

function normalizeProgram(id, p, existing) {
  p = p || {};
  const title = String(p.title || '').trim().slice(0, 200);
  if (!title) throw httpErr(400, 'A program needs a title.');
  const courseId = String(p.courseId || keep0(existing, 'courseId') || '').slice(0, 60);
  const ctx = { courseId, title };
  let sessions = (Array.isArray(p.sessions) ? p.sessions : []).map(s => {
    const date = cleanDate(s.date), endDate = cleanDate(s.endDate);
    return {
      id: String(s.id || rid('s')).slice(0, 40),
      title: String(s.title || '').trim().slice(0, 200),
      date, endDate: endDate && endDate > date ? endDate : '',
      start: normTime(s.start),
      end: normTime(s.end),
      zoomLink: cleanUrl(s.zoomLink),
      zoomMeetingId: String(s.zoomMeetingId || '').slice(0, 40),
      zoomSource: ['zoom', 'manual'].includes(s.zoomSource) ? s.zoomSource : '',
      zoomTopic: String(s.zoomTopic || '').slice(0, 200),
      zoomAt: String(s.zoomAt || '').slice(0, 30),
      zoomReplacedAt: String(s.zoomReplacedAt || '').slice(0, 30),
      icsUid: String(s.icsUid || '').slice(0, 200),
      icsUids: (Array.isArray(s.icsUids) ? s.icsUids : []).map(u => String(u).slice(0, 200)).slice(0, 40),
      allInstructors: !!s.allInstructors
    };
  }).filter(s => s.title);
  // A link typed into the program editor is marked as entered by hand, so the Zoom check never replaces it.
  if (existing) {
    const before = new Map((existing.sessions || []).map(s => [s.id, s]));
    for (const s of sessions) {
      const ex = before.get(s.id);
      if (ex && s.zoomLink !== (ex.zoomLink || '') && !p.fromZoom) { s.zoomSource = s.zoomLink ? 'manual' : ''; s.zoomMeetingId = ''; s.zoomTopic = ''; if (ex.zoomLink && s.zoomLink) s.zoomReplacedAt = new Date().toISOString(); }
    }
  }
  // Dates come from every session sent, including a Welcome session removed below, so the cohort start and deadline stay right.
  const allDates = sessions.flatMap(s => [s.date, s.endDate]).filter(Boolean).sort();
  const welcomeKept = keepsWelcome(ctx);
  sessions = sessions.filter(s => !isWelcome(s) || welcomeKept).map(s => isWelcome(s) ? { ...s, allInstructors: true } : s);
  sessions.sort((a, b) => a.date.localeCompare(b.date) || toMin(a.start) - toMin(b.start));
  const startDate = cleanDate(p.startDate) || allDates[0] || '';
  const endDate = cleanDate(p.endDate) || allDates[allDates.length - 1] || startDate;
  const trackSet = TRACKS.includes(p.trackSet) ? p.trackSet : (/^ncit/.test(p.trackSet || '') ? 'ncit' : '');
  const logoSet = LOGO_NAMES.includes(p.logoSet) ? p.logoSet : '';

  // Deadline: automatic = 30 days before the first live session, unless staff set one by hand.
  let deadlineMode = p.deadlineMode === 'manual' || p.deadlineMode === 'auto' ? p.deadlineMode
    : (existing && existing.deadlineMode) || (cleanDate(p.deadline) ? 'manual' : 'auto');
  let deadline = cleanDate(p.deadline);
  if (deadlineMode === 'auto') {
    const first = [allDates[0], startDate].filter(Boolean).sort()[0] || '';
    deadline = first ? addDays(first, -DEADLINE_DAYS) : '';
  }

  const keep = k => existing ? existing[k] : undefined;
  return {
    id, kind: 'program', title, track: trackSet || autoTrack(ctx), trackSet, logoSet,
    cohort: String(p.cohort || '').trim().slice(0, 120),
    quarter: String(p.quarter || '').slice(0, 40),
    format: String(p.format || '').slice(0, 60),
    location: String(p.location || '').slice(0, 120),
    timezone: String(p.timezone || 'ET').slice(0, 40),
    startDate, endDate, deadline, deadlineMode,
    status: STATUSES.includes(p.status) ? p.status : 'draft',
    description: String(p.description || '').slice(0, 4000),
    sessions,
    externalKey: String(p.externalKey || keep('externalKey') || '').slice(0, 200),
    welcome: cleanWelcome(p.welcome !== undefined ? p.welcome : keep('welcome')),
    courseId,
    source: String(p.source || keep('source') || 'manual').slice(0, 40),
    hasIcs: !!keep('hasIcs'), icsName: keep('icsName') || '', icsUpdatedAt: keep('icsUpdatedAt') || '', icsSource: keep('icsSource') || '',
    announcedAt: keep('announcedAt') || '', announcedBy: keep('announcedBy') || '',
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    createdBy: existing ? existing.createdBy : ''
  };
}

async function saveProgram(env, id, body, by) {
  const existing = await getJSON(env, 'program:' + id, null);
  if (existing && body.baseUpdatedAt && existing.updatedAt !== body.baseUpdatedAt) {
    throw httpErr(409, `${existing.updatedBy} changed this program at ${existing.updatedAt}. Reload to see their changes, then edit again.`);
  }
  const p = normalizeProgram(id, body.program, existing);
  p.createdBy = p.createdBy || by;
  p.updatedAt = new Date().toISOString();
  p.updatedBy = by;
  await putJSON(env, 'program:' + id, p);
  const what = !existing ? 'Created' : (existing.status !== p.status ? `Changed status to ${p.status} on` : 'Edited');
  await log(env, by, `${what} program`, p.title);
  return { ok: true, program: withState(p) };
}

async function deleteProgram(env, id, by) {
  const existing = await getJSON(env, 'program:' + id, null);
  if (!existing) throw httpErr(404, 'That program doesn\'t exist.');
  await env.IA_KV.delete('program:' + id);
  await env.IA_KV.delete('assign:' + id);
  await env.IA_KV.delete('ics:' + id);
  await log(env, by, 'Deleted program', existing.title + ' (instructor answers kept in their records)');
  return { ok: true };
}

async function importPrograms(env, body, me) {
  const incoming = Array.isArray(body.programs) ? body.programs : [];
  const existing = await listPrograms(env);
  const sig = p => (String(p.title).trim().toLowerCase() + '|' + p.startDate);
  const have = new Set(existing.map(sig));
  const created = [], skipped = [];
  for (const raw of incoming) {
    const id = rid('p');
    const p = normalizeProgram(id, { ...raw, status: 'draft', source: 'spreadsheet' }, null);
    if (have.has(sig(p))) { skipped.push(p.title); continue; }
    p.createdBy = me.email; p.updatedAt = new Date().toISOString(); p.updatedBy = me.email;
    await putJSON(env, 'program:' + id, p);
    have.add(sig(p));
    created.push(p.title);
  }

  // Add instructor names found in the spreadsheet header
  let addedInstructors = [];
  if (Array.isArray(body.instructors) && body.instructors.length) {
    const roster = await getJSON(env, 'roster', []);
    const names = new Set(roster.map(r => r.name.trim().toLowerCase()));
    for (const n of body.instructors) {
      const name = String(n || '').trim().slice(0, 120);
      if (!name || names.has(name.toLowerCase())) continue;
      roster.push({ id: rid('i'), name, emails: [], active: true, notes: '' });
      names.add(name.toLowerCase());
      addedInstructors.push(name);
    }
    if (addedInstructors.length) {
      roster.sort((x, y) => x.name.localeCompare(y.name));
      await putJSON(env, 'roster', roster);
    }
  }
  await log(env, me.email, 'Imported programs from spreadsheet', `${created.length} created, ${skipped.length} skipped, ${addedInstructors.length} instructors added`);
  return { ok: true, created, skipped, addedInstructors };
}

/* ---------- Agenda Generator package ---------- */

// Reuse existing session IDs on re-import so instructor answers stay attached.
function matchSessions(oldList, newList) {
  const pool = [...(oldList || [])];
  const take = fn => { const i = pool.findIndex(fn); return i < 0 ? null : pool.splice(i, 1)[0]; };
  const norm = s => String(s || '').trim().toLowerCase();
  return (newList || []).map(n => {
    const hit = (n.icsUid && take(o => o.icsUid && o.icsUid === n.icsUid))
      || take(o => norm(o.title) === norm(n.title) && o.date === cleanDate(n.date))
      || take(o => norm(o.title) === norm(n.title))
      || take(o => o.date && o.date === cleanDate(n.date) && toMin(o.start) === toMin(normTime(n.start)));
    // Keep a Zoom link already on the session when the incoming agenda has none.
    const keep = hit && hit.zoomLink && !cleanUrl(n.zoomLink) ? { zoomLink: hit.zoomLink, zoomMeetingId: hit.zoomMeetingId || '', zoomSource: hit.zoomSource || '', zoomTopic: hit.zoomTopic || '' } : {};
    return { ...n, ...keep, id: hit ? hit.id : rid('s') };
  });
}

async function importPackage(env, body, me) {
  if (body.format !== 'clear-availability-package') throw httpErr(400, 'That file isn\'t a portal package from the Program Agenda Generator.');
  const list = Array.isArray(body.programs) ? body.programs : [];
  if (!list.length) throw httpErr(400, 'The package has no programs in it.');
  if (list.length > 60) throw httpErr(400, 'Import 60 programs or fewer at a time.');
  const existing = await listPrograms(env);
  const byKey = new Map(existing.filter(p => p.externalKey).map(p => [p.externalKey, p]));
  const created = [], updated = [], warnings = [];
  const now = new Date().toISOString();

  const adopted = new Set();
  for (const raw of list) {
    const key = String(raw.externalKey || '').slice(0, 200);
    let ex = key ? byKey.get(key) : null;
    if (!ex) {
      // A program added earlier by spreadsheet or by hand has no link to TeamGantt. Adopt it when exactly one
      // unlinked program has the same start date, delivery format and course, so re-sending updates it instead of duplicating it.
      const fam = courseFamily(raw.title), ip = /person/i.test(raw.format || ''), sd = cleanDate(raw.startDate);
      const hits = existing.filter(p => !p.externalKey && !adopted.has(p.id) && p.startDate === sd && /person/i.test(p.format || '') === ip && fam && courseFamily(p.title) === fam);
      if (hits.length === 1) { ex = hits[0]; adopted.add(ex.id); warnings.push(`${raw.title}${raw.cohort ? ' (' + raw.cohort + ')' : ''} was matched to the existing program "${ex.title}" and updated in place. Instructors' answers were kept.`); }
    }
    let p;
    if (ex) {
      const sessions = matchSessions(ex.sessions, raw.sessions);
      const dropped = (ex.sessions || []).filter(o => !sessions.some(s => s.id === o.id));
      if (dropped.length) warnings.push(`${ex.title}${ex.cohort ? ' (' + ex.cohort + ')' : ''}: ${dropped.length} session${dropped.length > 1 ? 's' : ''} no longer in the agenda (${dropped.map(s => s.title).join(', ')}). Answers for them are kept but hidden.`);
      p = normalizeProgram(ex.id, {
        fromZoom: true, // links carried over here are not hand edits
        ...ex, ...pick(raw, ['title', 'cohort', 'format', 'location', 'timezone', 'startDate', 'endDate', 'courseId']),
        quarter: raw.quarter || ex.quarter, sessions,
        deadline: ex.deadline, deadlineMode: ex.deadlineMode, status: ex.status, description: ex.description, externalKey: key
      }, ex);
      p.createdBy = ex.createdBy;
      updated.push(label(p));
    } else {
      const id = rid('p');
      p = normalizeProgram(id, { ...raw, sessions: matchSessions([], raw.sessions), status: 'draft', deadlineMode: 'auto', source: 'agenda-generator', externalKey: key }, null);
      p.createdBy = me.email;
      created.push(label(p));
    }
    if (raw.ics && /^BEGIN:VCALENDAR/i.test(String(raw.ics).trim())) {
      const ics = String(raw.ics);
      if (ics.length > MAX_ICS) warnings.push(`${label(p)}: calendar file too large, skipped.`);
      else {
        await env.IA_KV.put('ics:' + p.id, ics);
        Object.assign(p, { hasIcs: true, icsName: String(raw.icsName || fileSafe(p.title) + '.ics').slice(0, 120), icsUpdatedAt: now, icsSource: 'Agenda Generator' });
      }
    }
    p.updatedAt = now; p.updatedBy = me.email;
    await putJSON(env, 'program:' + p.id, p);
    if (key) byKey.set(key, p);
  }
  await log(env, me.email, 'Imported Agenda Generator package', `${created.length} created, ${updated.length} updated`);
  return { ok: true, created, updated, warnings };
}

async function putProgramIcs(env, pid, body, by) {
  const prog = await getJSON(env, 'program:' + pid, null);
  if (!prog) throw httpErr(404, 'That program doesn\'t exist.');
  const ics = String(body.ics || '');
  if (!/^BEGIN:VCALENDAR/i.test(ics.trim())) throw httpErr(400, 'That doesn\'t look like a calendar (.ics) file.');
  if (ics.length > MAX_ICS) throw httpErr(400, 'That calendar file is too large.');
  await env.IA_KV.put('ics:' + pid, ics);
  Object.assign(prog, { hasIcs: true, icsName: String(body.name || fileSafe(prog.title) + '.ics').slice(0, 120), icsUpdatedAt: new Date().toISOString(), icsSource: 'Uploaded by ' + by });
  await putJSON(env, 'program:' + pid, prog); // updatedAt untouched so an open editor isn't blocked
  await log(env, by, 'Uploaded calendar file', prog.title);
  return { ok: true, program: withState(prog) };
}

async function deleteProgramIcs(env, pid, by) {
  const prog = await getJSON(env, 'program:' + pid, null);
  if (!prog) throw httpErr(404, 'That program doesn\'t exist.');
  await env.IA_KV.delete('ics:' + pid);
  Object.assign(prog, { hasIcs: false, icsName: '', icsUpdatedAt: '', icsSource: '' });
  await putJSON(env, 'program:' + pid, prog);
  await log(env, by, 'Removed calendar file', prog.title);
  return { ok: true, program: withState(prog) };
}

/* ======================= Calendar files ======================= */

function confirmedFor(assign, iid) {
  const out = [];
  for (const [slot, list] of Object.entries((assign && assign.slots) || {})) {
    for (const e of list || []) if (e.iid === iid && e.status === 'Confirmed') out.push({ slot, role: e.role });
  }
  return out;
}

// The instructor's own calendar: the program's stored .ics filtered to their confirmed sessions,
// or one generated from the session details if no file was stored.
async function instructorIcs(env, pid, inst, require) {
  const prog = await getJSON(env, 'program:' + pid, null);
  if (!prog || prog.status === 'draft') throw httpErr(404, 'That program isn\'t available.');
  const mine = confirmedFor(await getJSON(env, 'assign:' + pid, null), inst.id);
  if (require && !mine.length) throw httpErr(404, 'There are no confirmed assignments for this program.');
  const whole = mine.some(m => m.slot === PROGRAM_SLOT);
  const sessions = whole ? (prog.sessions || []) : (prog.sessions || []).filter(s => s.allInstructors || mine.some(m => m.slot === s.id));
  // Online programs: built from the session details so it always carries current times and any Zoom links found since.
  // In-person programs: the Agenda Generator's block-by-block calendar, filtered to the instructor's modules.
  const stored = isInPerson(prog) ? await env.IA_KV.get('ics:' + pid) : null;
  let ics = stored ? (whole ? stored : filterIcs(stored, sessions)) : null;
  const fromFile = !!ics;
  if (!ics) ics = buildIcs(prog, sessions);
  return { ics, name: fileSafe(`${prog.title}${prog.cohort ? ' ' + prog.cohort : ''} - ${inst.name}`) + '.ics', sessions, whole, fromFile, prog, mine };
}

function filterIcs(text, sessions) {
  const src = String(text).replace(/\r?\n/g, '\r\n');
  const start = src.indexOf('BEGIN:VEVENT');
  if (start < 0) return null;
  const head = src.slice(0, start);
  const tailAt = src.lastIndexOf('END:VCALENDAR');
  const events = src.slice(start, tailAt < 0 ? undefined : tailAt).split(/(?=BEGIN:VEVENT)/).filter(e => e.startsWith('BEGIN:VEVENT'));
  const unfold = e => e.replace(/\r\n[ \t]/g, '');
  const uids = new Set(sessions.flatMap(s => [s.icsUid, ...(s.icsUids || [])]).filter(Boolean));
  let kept = events.filter(e => { const m = unfold(e).match(/\r\nUID:([^\r\n]+)/); return m && uids.has(m[1].trim()); });
  if (!kept.length) {
    const dates = new Set(sessions.flatMap(s => [s.date, s.endDate]).filter(Boolean).map(d => d.replace(/-/g, '')));
    kept = events.filter(e => { const m = unfold(e).match(/\r\nDTSTART[^:\r\n]*:(\d{8})T/); return m && dates.has(m[1]); });
  }
  if (!kept.length) return null;
  return head + kept.map(e => e.replace(/\s*$/, '\r\n')).join('') + 'END:VCALENDAR\r\n';
}

function buildIcs(prog, sessions) {
  const tzid = TZIDS[String(prog.timezone || 'ET').toUpperCase()] || ET;
  const stampNow = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CLEAR Learning//Instructor Portal//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  const ev = (uid, when, summary, desc, loc) => {
    lines.push('BEGIN:VEVENT', 'UID:' + uid, 'DTSTAMP:' + stampNow, ...when, fold('SUMMARY:' + icsEsc(summary)), fold('DESCRIPTION:' + icsEsc(desc)));
    if (loc) lines.push(fold('LOCATION:' + icsEsc(loc)));
    lines.push('ORGANIZER;CN=CLEAR Learning:mailto:clearlearning@clearhq.org', 'STATUS:CONFIRMED', 'END:VEVENT');
  };
  const label = prog.title + (prog.cohort ? ' — ' + prog.cohort : '');
  const timed = (sessions || []).filter(s => s.date && toMin(s.start) && toMin(s.end));
  if (timed.length) {
    for (const s of timed) {
      const d = s.date.replace(/-/g, '');
      ev(`${prog.id}-${s.id}@clearhq.org`,
        [`DTSTART;TZID=${tzid}:${d}T${hhmm(toMin(s.start))}00`, `DTEND;TZID=${tzid}:${(s.endDate || s.date).replace(/-/g, '')}T${hhmm(toMin(s.end))}00`],
        s.title + (prog.cohort ? ' — ' + prog.cohort : ''),
        `${label}\n${s.title}: ${whenText(prog, s)}${s.zoomLink ? '\nZoom Link: ' + s.zoomLink : ''}\n\nQuestions: clearlearning@clearhq.org`,
        s.zoomLink || (prog.location && prog.location !== 'Virtual' ? prog.location : ''));
    }
  } else if (prog.startDate) {
    const end = addDays(prog.endDate || prog.startDate, 1).replace(/-/g, '');
    ev(`${prog.id}-program@clearhq.org`, [`DTSTART;VALUE=DATE:${prog.startDate.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${end}`],
      label, `${label}\n${prog.format || ''}${prog.location ? ', ' + prog.location : ''}\n\nQuestions: clearlearning@clearhq.org`, prog.location || '');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

const TZIDS = { ET: 'America/New_York', CT: 'America/Chicago', MT: 'America/Denver', PT: 'America/Los_Angeles', AT: 'America/Halifax', UTC: 'UTC' };
function hhmm(m) { return String(Math.floor(m / 60)).padStart(2, '0') + String(m % 60).padStart(2, '0'); }
function icsEsc(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function fold(line) { if (line.length <= 75) return line; let out = line.slice(0, 75); for (let i = 75; i < line.length; i += 74) out += '\r\n ' + line.slice(i, i + 74); return out; }
function icsResponse(ics, name) {
  return new Response(ics, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' } });
}

/* ======================= Email (Power Automate) ======================= */

async function sendMail(env, msg) {
  if (!env.NOTIFY_FLOW_URL || !env.NOTIFY_MAILBOX) throw httpErr(501, 'Email isn\'t set up yet. Add NOTIFY_FLOW_URL and NOTIFY_MAILBOX in the Pages project settings, then redeploy.');
  const payload = {
    to: (msg.to || []).join(';'), bcc: (msg.bcc || []).join(';'), replyTo: env.NOTIFY_MAILBOX,
    subject: msg.subject, html: msg.html,
    attachments: (msg.attachments || []).map(a => ({ Name: a.name, ContentBytes: a.base64 }))
  };
  const r = await fetch(env.NOTIFY_FLOW_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) throw httpErr(502, `Power Automate didn't accept the email (HTTP ${r.status}). Check the flow's run history.`);
}

function b64utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const H = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* ---------- Email layout ----------
   Matches the CLEAR Learning welcome emails: tables, bgcolor attributes and inline styles only, so older
   Outlook versions (which use Word to display email) keep the formatting. */
const EF = 'font-family:Arial,Helvetica,sans-serif;';
const EBODY = EF + 'font-size:14px;line-height:21px;color:#1a1014;';
const LOGO_CL = 'https://assets-002.noviams.com/novi-file-uploads/clear/logos/CLEAR_Learning_Logo_horizontal__2_.png';
const SOCIAL = 'https://assets-002.noviams.com/novi-file-uploads/clear/TalentLMS/';
// Give every paragraph, cell, list and link its own font and colour, since Outlook doesn't inherit styles.
function outlookify(html) {
  const addStyle = (tag, base) => (m, attrs) => {
    const st = (attrs || '').match(/style="([^"]*)"/);
    const rest = (attrs || '').replace(/\s*style="[^"]*"/, '');
    return `<${tag}${rest} style="${base}${st ? st[1] : ''}">`;
  };
  return String(html)
    .replace(/<p(\s[^>]*)?>/g, addStyle('p', 'margin:0 0 16px 0;' + EBODY))
    .replace(/<td(\s[^>]*)?>/g, addStyle('td', EBODY))
    .replace(/<ul(\s[^>]*)?>/g, addStyle('ul', 'margin:0 0 16px 0;padding-left:24px;' + EBODY))
    .replace(/<ol(\s[^>]*)?>/g, addStyle('ol', 'margin:0 0 16px 0;padding-left:24px;' + EBODY))
    .replace(/<li(\s[^>]*)?>/g, addStyle('li', 'margin:0 0 6px 0;' + EBODY))
    .replace(/<a (href="[^"]*")>/g, '<a $1 style="color:#0144db;text-decoration:underline;">');
}
// The outer cell's top padding is the space above the button: Outlook ignores margins on lists and tables but keeps cell padding.
function emailButton(btn) {
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:16px 0 8px 0;">
<table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#64092c" align="center" style="background-color:#64092c;padding:12px 26px;">
<a href="${H(btn.href)}" style="${EF}font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;display:inline-block;">${H(btn.label)}</a></td></tr></table>
</td></tr></table>`;
}
function emailShell(title, inner, origin, button) {
  const btn = button || { label: 'Open the Instructor Portal', href: origin };
  const foot = (txt, extra = '') => `<tr><td align="center" style="${EF}font-size:12px;line-height:17px;color:#ffffff;${extra}">${txt}</td></tr>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${H(title)}</title></head>
<body style="margin:0;padding:0;background-color:#f5f0f2;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f5f0f2" style="background-color:#f5f0f2;"><tr><td align="center" bgcolor="#f5f0f2" style="padding:24px 16px;">
<table width="620" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" align="center" style="width:620px;max-width:620px;background-color:#ffffff;">
<tr><td bgcolor="#ffffff" align="left" style="padding:24px 32px;"><img src="${LOGO_CL}" alt="CLEAR Learning" width="240" border="0" style="display:block;width:240px;height:auto;"></td></tr>
<tr><td height="4" bgcolor="#c9933a" style="font-size:0;line-height:0;height:4px;background-color:#c9933a;">&nbsp;</td></tr>
<tr><td bgcolor="#ffffff" style="padding:32px 32px 8px 32px;${EBODY}">
<table width="556" cellpadding="0" cellspacing="0" border="0" align="center" style="width:100%;max-width:556px;"><tr><td style="${EBODY}">
${outlookify(inner)}
${emailButton(btn)}
<p style="margin:24px 0 28px 0;${EF}font-size:12px;line-height:18px;color:#4a3040;">Sign in with this email address; you will receive a one-time code by email. If you have any questions or require assistance, please contact us at <a href="mailto:clearlearning@clearhq.org" style="color:#0144db;font-weight:bold;">clearlearning@clearhq.org</a> or <strong style="color:#64092c;">859-269-1289</strong>.</p>
</td></tr></table></td></tr>
<tr><td bgcolor="#64092c" align="center" style="background-color:#64092c;padding:28px 32px;">
<table width="556" cellpadding="0" cellspacing="0" border="0" align="center">
${foot('Best regards,', 'font-size:14px;font-weight:bold;padding-bottom:4px;')}
${foot('Council on Licensure, Enforcement and Regulation', 'font-size:13px;font-weight:bold;padding-bottom:2px;')}
${foot('Promoting Regulatory Excellence', 'font-style:italic;padding-bottom:14px;')}
${foot('<a href="https://www.clearhq.org" style="color:#ffffff;text-decoration:none;">www.clearhq.org</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="mailto:clearlearning@clearhq.org" style="color:#ffffff;text-decoration:none;">clearlearning@clearhq.org</a>', 'padding-bottom:4px;')}
${foot('+1.859.269.1401&nbsp;&nbsp;|&nbsp;&nbsp;108 Wind Haven Dr., Ste. A, Nicholasville, KY 40356', 'padding-bottom:18px;')}
<tr><td align="center"><table cellpadding="0" cellspacing="0" border="0" align="center"><tr>
<td style="padding:0 5px;"><a href="https://twitter.com/CLEARHQ"><img src="${SOCIAL}email_x.png" alt="X" width="26" height="26" border="0" style="display:block;"></a></td>
<td style="padding:0 5px;"><a href="https://facebook.com/CLEARHQ/"><img src="${SOCIAL}email_facebook.png" alt="Facebook" width="26" height="26" border="0" style="display:block;"></a></td>
<td style="padding:0 5px;"><a href="https://www.linkedin.com/company/council-on-licensure-enforcement-and-regulation-clear-/"><img src="${SOCIAL}Email_linkedin.png" alt="LinkedIn" width="26" height="26" border="0" style="display:block;"></a></td>
</tr></table></td></tr></table></td></tr>
</table></td></tr></table></body></html>`;
}
// Staff note: the soft pink box with a gold edge, as a table so Outlook keeps both colours.
function noteBlock(note) {
  if (!note) return '';
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;"><tr><td width="4" bgcolor="#c9933a" style="background-color:#c9933a;font-size:0;line-height:0;">&nbsp;</td>
<td bgcolor="#faf4f6" style="background-color:#faf4f6;padding:14px 18px;">${H(note).replace(/\r?\n/g, '<br>')}</td></tr></table>`;
}
// Rich text from the Compose window: keep simple formatting and links, drop everything else (including Word styling).
function sanitizeRich(html) {
  let s = String(html || '').slice(0, 60000)
    .replace(/<(script|style|head|title|xml)[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(\/?)(div|h[1-6]|blockquote)(\s[^>]*)?>/gi, '<$1p>')
    .replace(/<(\/?)b(\s[^>]*)?>/gi, '<$1strong>').replace(/<(\/?)i(\s[^>]*)?>/gi, '<$1em>');
  s = s.replace(/<(\/?)([a-z][a-z0-9:]*)(\s[^>]*)?>/gi, (m, close, tag, attrs) => {
    tag = tag.toLowerCase();
    if (!['p', 'br', 'strong', 'em', 'u', 'ul', 'ol', 'li', 'a'].includes(tag)) return '';
    if (close) return `</${tag}>`;
    if (tag === 'br') return '<br>';
    if (tag === 'a') {
      const h = (attrs || '').match(/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const url = h ? (h[2] || h[3] || h[4] || '').replace(/&amp;/g, '&') : '';
      return /^(https:\/\/|mailto:)/i.test(url) ? `<a href="${H(url)}">` : '<a>';
    }
    return `<${tag}>`;
  });
  s = s.replace(/<a>([\s\S]*?)<\/a>/g, '$1').replace(/<p>\s*(<br>)?\s*<\/p>/g, '').trim();
  if (!/<(p|ul|ol)>/.test(s)) s = `<p>${s}</p>`;
  return s;
}
function whenText(p, s) {
  if (!s.start) return s.endDate ? `${longDate(s.date)} – ${longDate(s.endDate)}` : longDate(s.date);
  if (s.endDate) return `${longDate(s.date)}, ${s.start} – ${longDate(s.endDate)}, ${s.end} ${tz(p)}`;
  return `${longDate(s.date)}, ${s.start} – ${s.end} ${tz(p)}`;
}
function programLine(p) {
  const n = answerable(p).length, ip = /person/i.test(p.format || '');
  return `<tr><td style="padding:10px 0;border-bottom:1px solid #eadfe3;"><strong style="color:#64092c;">${H(p.title)}</strong>${p.cohort ? `<br><span style="color:#4a3040;">${H(p.cohort)}</span>` : ''}
    <br>${H(rangeText(p.startDate, p.endDate))} · ${H(p.format || '')}${p.location && p.location !== 'Virtual' ? ', ' + H(p.location) : ''} · ${n ? n + (ip ? ' module' : ' live session') + (n > 1 ? 's' : '') : 'staffed as a whole program'}
    ${p.deadline ? `<br><strong>Respond by ${H(longDate(p.deadline))}</strong>` : ''}</td></tr>`;
}
const tz = p => p.timezone || 'ET';

function activeRecipients(roster) {
  return roster.filter(r => r.active !== false && (r.emails || []).length).map(r => ({ r, email: r.emails[0] }));
}

async function notifyAnnounce(env, body, me) {
  const ids = Array.isArray(body.pids) ? body.pids : [];
  const progs = (await Promise.all(ids.map(id => getJSON(env, 'program:' + id, null)))).filter(Boolean);
  if (!progs.length) throw httpErr(400, 'Choose at least one program to announce.');
  if (!body.test && progs.some(p => p.status !== 'open')) throw httpErr(400, 'Only open programs can be announced. Open them first.');
  progs.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  const build = list => ({
    subject: (body.test ? '[TEST] ' : '') + (list.length === 1 ? `New CLEAR Learning program open for instructors: ${list[0].title}` : `${list.length} new CLEAR Learning programs are open in the Instructor Portal`),
    html: emailShell('New programs are open for availability', `<p>Hello,</p>
<p>CLEAR Learning has posted ${list.length === 1 ? 'a new program that is aligned' : list.length + ' new programs that are aligned'} with your instruction preferences. Please mark the sessions you are able to teach, and those you are not, by each program's response date. You can update your answers in the portal at any time before that date.</p>
${noteBlock(body.note)}
<table style="width:100%;border-collapse:collapse">${list.map(programLine).join('')}</table>
<p style="font-size:13px;color:#6E6B70">All session times are listed in Eastern Time. In the portal, you have the option to change the time zone to one of your choosing.</p>`, me.origin)
  });
  // Each instructor hears only about programs they are approved to teach. People with the same list share one BCC email.
  const groups = new Map();
  for (const x of activeRecipients(me.roster)) {
    const list = progs.filter(p => eligible(x.r, p));
    if (!list.length) continue;
    const k = list.map(p => p.id).join('|');
    if (!groups.has(k)) groups.set(k, { list, emails: [] });
    groups.get(k).emails.push(x.email);
  }
  const total = [...groups.values()].reduce((n, g) => n + g.emails.length, 0);
  if (body.preview) {
    const first = [...groups.values()][0];
    return { ok: true, preview: { ...build(first ? first.list : progs), count: body.test ? 1 : total, to: body.test ? me.email : (total ? `${total} approved instructor${total > 1 ? 's' : ''} in ${groups.size} email${groups.size > 1 ? 's' : ''}, BCC from ${env.NOTIFY_MAILBOX || '(mailbox)'}${groups.size > 1 ? '. Each email lists only the programs its recipients are approved for; this preview shows the first.' : ''}` : 'Nobody is approved for these programs') } };
  }
  if (body.test) { await sendMail(env, { to: [me.email], ...build(progs) }); return { ok: true, sent: 1, announcedAt: null }; }
  if (!total) throw httpErr(400, 'No active instructors with an email address are approved for these programs.');
  for (const g of groups.values()) {
    for (let i = 0; i < g.emails.length; i += 400) await sendMail(env, { to: [env.NOTIFY_MAILBOX], bcc: g.emails.slice(i, i + 400), ...build(g.list) });
  }
  const at = new Date().toISOString();
  for (const p of progs) { p.announcedAt = at; p.announcedBy = me.email; await putJSON(env, 'program:' + p.id, p); }
  await log(env, me.email, 'Announced programs by email', `${progs.map(p => p.title).join('; ')} to ${total} approved instructors`);
  return { ok: true, sent: total, announcedAt: at };
}

async function notifyRemind(env, body, me) {
  const ids = Array.isArray(body.pids) ? body.pids : [];
  const today = todayET();
  const progs = (await Promise.all(ids.map(id => getJSON(env, 'program:' + id, null)))).filter(p => p && p.status === 'open' && !pastDeadline(p, today));
  if (!progs.length) throw httpErr(400, 'Choose at least one open program that is still taking answers.');
  const recips = activeRecipients(me.roster);
  const recs = await Promise.all(recips.map(x => getJSON(env, 'resp:' + x.r.id, { programs: {} })));
  // Only instructors who have not responded to a program at all are reminded about it.
  const missing = recips.map((x, i) => ({ ...x, list: progs.filter(p => eligible(x.r, p) && !(recs[i].programs || {})[p.id]) })).filter(x => x.list.length);
  const build = x => reminderEmail(x, body.note, me.origin, body.test, null);
  if (body.preview) {
    const sample = missing[0] || { r: { name: 'Instructor, Sample' }, list: progs };
    return { ok: true, preview: { ...build(sample), count: missing.length, to: missing.length ? `${missing.length} instructors, one email each` : 'Nobody: everyone has answered' } };
  }
  if (body.test) { const m = build(missing[0] || { r: { name: me.staffName || 'Staff' }, list: progs }); await sendMail(env, { to: [me.email], ...m }); return { ok: true, sent: 1 }; }
  if (!missing.length) return { ok: true, sent: 0 };
  if (missing.length > 40) {
    // Stay under the Functions subrequest limit: one BCC message listing every program.
    const m = build({ r: { name: '' }, list: progs });
    m.html = m.html.replace('Hello ,', 'Hello,');
    await sendMail(env, { to: [env.NOTIFY_MAILBOX], bcc: missing.map(x => x.email), ...m });
  } else {
    for (const x of missing) await sendMail(env, { to: [x.email], ...build(x) });
  }
  await log(env, me.email, 'Sent availability reminders', `${missing.length} instructors: ${progs.map(p => p.title).join('; ')}`);
  return { ok: true, sent: missing.length };
}

async function notifySelection(env, pid, body, me) {
  const prog = await getJSON(env, 'program:' + pid, null);
  if (!prog) throw httpErr(404, 'That program doesn\'t exist.');
  const key = 'assign:' + pid;
  const assign = await getJSON(env, key, { slots: {}, notes: [], history: [], notified: {} });
  const ids = Array.isArray(body.iids) ? body.iids : [];
  if (!ids.length) throw httpErr(400, 'Choose at least one confirmed instructor to email.');
  const results = [];
  let previewOut = null;
  for (const iid of ids) {
    const inst = me.roster.find(r => r.id === iid);
    if (!inst) { results.push({ iid, ok: false, error: 'Not on the roster' }); continue; }
    if (!(inst.emails || []).length) { results.push({ iid, ok: false, error: `${inst.name} has no email address` }); continue; }
    const mine = confirmedFor(assign, iid);
    if (!mine.length) { results.push({ iid, ok: false, error: `${inst.name} has no confirmed slots` }); continue; }
    const sessions = sessionsFor(prog, mine);
    const n = sessions.length, ip = isInPerson(prog);
    const subject = (body.test ? '[TEST] ' : '') + `You're confirmed to teach: ${prog.title}${prog.cohort ? ' (' + prog.cohort + ')' : ''}`;
    const html = emailShell("You've been selected to teach", `<p>Hello ${H(firstName(inst.name))},</p>
<p>Thank you for sharing your availability. You're confirmed to teach in <strong>${H(prog.title)}</strong>${prog.cohort ? `, ${H(prog.cohort)}` : ''}${n ? ` (${n} ${ip ? 'module' : 'session'}${n > 1 ? 's' : ''})` : ''}.</p>${noteBlock(body.note)}
<p>Your ${ip ? 'modules' : 'sessions'}, dates and times are on the My assignments page of the Instructor Portal. ${ip ? '' : 'Zoom links appear there before the first session. '}You can also download calendar files from that page.</p>`, me.origin, { label: 'View your assignments', href: me.origin + '/#/mine' });
    if (body.preview) { previewOut = { subject, html, to: inst.emails[0], count: ids.length }; break; }
    await sendMail(env, { to: body.test ? [me.email] : [inst.emails[0]], subject, html });
    results.push({ iid, ok: true });
    if (!body.test) {
      assign.notified = assign.notified || {};
      assign.notified[iid] = { at: new Date().toISOString(), by: me.email, sig: slotSig(mine), snap: snapFor(prog, mine), kind: 'selection' };
    }
  }
  if (body.preview) return { ok: true, preview: previewOut || { subject: '', html: '<p>Nothing to preview.</p>', to: '', count: 0, error: (results[0] || {}).error } };
  if (!body.test && results.some(r => r.ok)) {
    const cur = await getJSON(env, key, { slots: {}, notes: [], history: [] });
    cur.notified = { ...(cur.notified || {}), ...assign.notified };
    await putJSON(env, key, cur); // updatedAt untouched, like notes
    await log(env, me.email, 'Emailed selection notices', `${prog.title}: ${results.filter(r => r.ok).length} sent`);
    return { ok: true, results, notified: cur.notified, changes: scheduleChanges(prog, cur) };
  }
  return { ok: true, results, notified: assign.notified || {} };
}

function reminderEmail(x, note, origin, test, daysLeft) {
  const many = x.list.length > 1;
  const lead = daysLeft == null
    ? `We haven't received your availability yet for the program${many ? 's' : ''} below.`
    : `The response date for the program${many ? 's' : ''} below is ${daysLeft === 1 ? 'tomorrow' : 'in ' + daysLeft + ' days'}, and we haven't received your availability yet.`;
  return {
    subject: (test ? '[TEST] ' : '') + 'Reminder: please share your availability for CLEAR Learning programs',
    html: emailShell('Your availability is still needed', `<p>Hello${x.r.name ? ' ' + H(firstName(x.r.name)) : ''},</p>
<p>${lead} Marking sessions "Not available" is just as helpful to our planning as marking them available.</p>${noteBlock(note)}
<table style="width:100%;border-collapse:collapse">${x.list.map(programLine).join('')}</table>`, origin)
  };
}

/* ---------- Automatic reminders (daily cron) ---------- */
function reminderDays(env) { return String(env.REMINDER_DAYS || '7,2').split(',').map(n => parseInt(n, 10)).filter(n => n >= 0 && n < 120); }
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); }
function safeEq(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

async function runReminders(env, url) {
  const today = todayET(), days = reminderDays(env), dry = url.searchParams.get('dry') === '1';
  const origin = String(env.PORTAL_URL || url.origin).replace(/\/+$/, '');
  const progs = (await listPrograms(env)).filter(p => p.status === 'open' && p.deadline && !pastDeadline(p, today));
  const todo = [];
  for (const p of progs) {
    const n = daysBetween(today, p.deadline);
    if (!days.includes(n)) continue;
    const key = `reminded:${p.id}:${p.deadline}:${n}`;
    if (await env.IA_KV.get(key)) continue; // already ran today
    todo.push({ p, n, key });
  }
  if (!todo.length) return { ok: true, today, days, programs: [], sent: 0, message: 'No programs reach a reminder day today.' };
  const roster = await getJSON(env, 'roster', []);
  const recips = activeRecipients(roster);
  const recs = await Promise.all(recips.map(x => getJSON(env, 'resp:' + x.r.id, { programs: {} })));
  const missing = recips.map((x, i) => {
    const mine = todo.filter(t => eligible(x.r, t.p) && !(recs[i].programs || {})[t.p.id]);
    return { ...x, list: mine.map(t => t.p), daysLeft: Math.min(...mine.map(t => t.n)) };
  }).filter(x => x.list.length);
  const summary = todo.map(t => ({ program: label(t.p), daysBefore: t.n, nonResponders: missing.filter(m => m.list.includes(t.p)).length }));
  if (dry) return { ok: true, today, days, dryRun: true, programs: summary, wouldSend: missing.length };
  if (missing.length > 40) {
    const m = reminderEmail({ r: { name: '' }, list: todo.map(t => t.p) }, '', origin, false, Math.min(...todo.map(t => t.n)));
    await sendMail(env, { to: [env.NOTIFY_MAILBOX], bcc: missing.map(x => x.email), ...m });
  } else {
    for (const x of missing) await sendMail(env, { to: [x.email], ...reminderEmail(x, '', origin, false, x.daysLeft) });
  }
  const at = new Date().toISOString();
  for (const t of todo) {
    await env.IA_KV.put(t.key, at, { expirationTtl: 60 * 60 * 24 * 90 });
    const cur = await getJSON(env, 'program:' + t.p.id, null);
    if (cur) {
      cur.reminders = [...(cur.reminders || []), { at, daysBefore: t.n, count: missing.filter(m => m.list.includes(t.p)).length }].slice(-10);
      await putJSON(env, 'program:' + t.p.id, cur); // updatedAt untouched so an open editor isn't blocked
    }
  }
  await log(env, 'automatic reminders', 'Sent availability reminders', summary.map(s => `${s.program}: ${s.nonResponders} (${s.daysBefore} days before)`).join('; '));
  return { ok: true, today, days, programs: summary, sent: missing.length };
}

/* ---------- Schedule change tracking ---------- */
function sessionsFor(prog, mine) {
  const whole = mine.some(m => m.slot === PROGRAM_SLOT);
  return whole ? (prog.sessions || []) : (prog.sessions || []).filter(s => s.allInstructors || mine.some(m => m.slot === s.id));
}
// What an instructor was told: their sessions' titles, dates, times and Zoom links (or the program dates if staffed whole).
function snapFor(prog, mine) {
  const ss = sessionsFor(prog, mine);
  if (!ss.length) return [{ id: PROGRAM_SLOT, title: 'Entire program', date: prog.startDate || '', endDate: prog.endDate || '', start: '', end: '', zoomLink: '', location: prog.location || '' }];
  return ss.map(s => ({ id: s.id, title: s.title, date: s.date, endDate: s.endDate || '', start: s.start, end: s.end, zoomLink: s.zoomLink || '', location: prog.location || '' }));
}
function diffSnap(prog, before, after) {
  const out = [];
  const old = new Map((before || []).map(s => [s.id, s]));
  for (const s of after) {
    const o = old.get(s.id);
    if (!o) { out.push({ id: s.id, kind: 'added', title: s.title }); continue; }
    old.delete(s.id);
    const what = [];
    if (o.date !== s.date || o.endDate !== s.endDate || o.start !== s.start || o.end !== s.end) what.push('date or time');
    if (o.zoomLink && o.zoomLink !== s.zoomLink) what.push('Zoom link'); // a link added for the first time is not a change
    if (o.title !== s.title) what.push('title');
    if (o.location !== s.location && s.id === PROGRAM_SLOT) what.push('location');
    if (what.length) out.push({ id: s.id, kind: 'changed', title: s.title, what, was: o });
  }
  for (const o of old.values()) out.push({ id: o.id, kind: 'removed', title: o.title, was: o });
  return out;
}
// Zoom links aren't in emails, so a link replaced after the instructor's last email is added as a change.
function withZoomSwaps(prog, mine, n, diffs) {
  const out = [...diffs];
  for (const s of sessionsFor(prog, mine)) {
    if (!s.zoomReplacedAt || s.zoomReplacedAt <= n.at) continue;
    const x = out.find(d => d.id === s.id);
    if (x) { if (x.kind === 'changed' && !x.what.includes('Zoom link')) x.what.push('Zoom link'); }
    else out.push({ id: s.id, kind: 'changed', title: s.title, what: ['Zoom link'], was: { ...s } });
  }
  return out;
}
// For the dashboard: confirmed instructors whose schedule changed after their last email.
function scheduleChanges(prog, assign) {
  const out = {};
  for (const [iid, n] of Object.entries((assign && assign.notified) || {})) {
    if (!n || !n.snap) continue;
    const mine = confirmedFor(assign, iid);
    if (!mine.length || slotSig(mine) !== n.sig) continue; // assignment itself changed: a new selection notice covers it
    const d = withZoomSwaps(prog, mine, n, diffSnap(prog, n.snap, snapFor(prog, mine)));
    if (d.length) out[iid] = d.map(x => x.kind === 'changed' ? `${x.title}: ${x.what.join(', ')}` : `${x.title}: ${x.kind}`);
  }
  return out;
}

async function notifyChange(env, pid, body, me) {
  const prog = await getJSON(env, 'program:' + pid, null);
  if (!prog) throw httpErr(404, 'That program doesn\'t exist.');
  const key = 'assign:' + pid;
  const assign = await getJSON(env, key, { slots: {}, notes: [], history: [], notified: {} });
  const ids = Array.isArray(body.iids) ? body.iids : [];
  if (!ids.length) throw httpErr(400, 'Choose at least one instructor to email.');
  const results = [], updates = {};
  let previewOut = null;
  for (const iid of ids) {
    const inst = me.roster.find(r => r.id === iid);
    const n = (assign.notified || {})[iid];
    const mine = confirmedFor(assign, iid);
    if (!inst || !(inst.emails || []).length) { results.push({ iid, ok: false, error: `${inst ? inst.name : 'Instructor'} has no email address` }); continue; }
    if (!n || !n.snap) { results.push({ iid, ok: false, error: `${inst.name} hasn't been sent a selection notice yet; send that instead` }); continue; }
    if (!mine.length || slotSig(mine) !== n.sig) { results.push({ iid, ok: false, error: `${inst.name}'s assignment changed; send a new selection notice instead` }); continue; }
    const cur = snapFor(prog, mine), diffs = withZoomSwaps(prog, mine, n, diffSnap(prog, n.snap, cur));
    if (!diffs.length) { results.push({ iid, ok: false, error: `Nothing has changed for ${inst.name} since their last email` }); continue; }
    const byId = new Map(diffs.map(x => [x.id, x]));
    const cell = 'padding:8px 0;border-bottom:1px solid #EEECEF';
    const rows = cur.map(s => {
      const dx = byId.get(s.id);
      const flag = dx ? `<span style="background:#F8EDD3;color:#7A5410;font-size:11px;font-weight:700;padding:1px 7px;border-radius:9px;margin-left:6px">${dx.kind === 'added' ? 'New' : 'Updated'}</span>` : '';
      const when = s.id === PROGRAM_SLOT ? rangeText(s.date, s.endDate) + (s.location && s.location !== 'Virtual' ? ', ' + s.location : '') : whenText(prog, s);
      let was = '';
      if (dx && dx.kind === 'changed') {
        const w = dx.was, bits = [];
        if (dx.what.includes('date or time')) bits.push('Previously ' + (s.id === PROGRAM_SLOT ? rangeText(w.date, w.endDate) : whenText(prog, w)));
        if (dx.what.includes('location')) bits.push('Previously at ' + (w.location || 'no location'));
        if (dx.what.includes('Zoom link')) bits.push('Zoom link replaced');
        if (dx.what.includes('title')) bits.push('Previously titled ' + w.title);
        was = `<br><span style="color:#9B1C1C;font-size:12px">${H(bits.join('. '))}</span>`;
      }
      return `<tr><td style="${cell}"><strong>${H(s.title)}</strong>${flag}<br>${H(when)}${s.zoomLink ? `<br><a href="${H(s.zoomLink)}">${H(s.zoomLink)}</a>` : ''}${was}</td></tr>`;
    }).join('') + diffs.filter(x => x.kind === 'removed').map(x => `<tr><td style="${cell};color:#6E6B70"><s>${H(x.title)}</s> <span style="font-size:11px;font-weight:700">Removed</span><br>${H(x.was.id === PROGRAM_SLOT ? rangeText(x.was.date, x.was.endDate) : whenText(prog, x.was))}</td></tr>`).join('');
    const subject = (body.test ? '[TEST] ' : '') + `Schedule update: ${prog.title}${prog.cohort ? ' (' + prog.cohort + ')' : ''}`;
    const html = emailShell('Your teaching schedule has changed', `<p>Hello ${H(firstName(inst.name))},</p>
<p>There has been a change to your schedule for <strong>${H(prog.title)}</strong>${prog.cohort ? `, ${H(prog.cohort)}` : ''}. Your current schedule is below, with the changes marked.</p>${noteBlock(body.note)}
<table style="width:100%;border-collapse:collapse">${rows}</table>
<p>If you added these sessions to your calendar, update them, or download a new calendar file from My assignments and delete the old entries.</p>`, me.origin, { label: 'View your assignments', href: me.origin + '/#/mine' });
    if (body.preview) { previewOut = { subject, html, to: inst.emails[0], count: ids.length }; break; }
    await sendMail(env, { to: body.test ? [me.email] : [inst.emails[0]], subject, html });
    results.push({ iid, ok: true });
    if (!body.test) updates[iid] = { ...n, at: new Date().toISOString(), by: me.email, snap: cur, kind: 'change' };
  }
  if (body.preview) return { ok: true, preview: previewOut || { subject: '', html: '<p>Nothing to preview.</p>', to: '', count: 0, error: (results[0] || {}).error } };
  const fresh = await getJSON(env, key, { slots: {}, notes: [], history: [] });
  if (Object.keys(updates).length) {
    fresh.notified = { ...(fresh.notified || {}), ...updates };
    await putJSON(env, key, fresh);
    await log(env, me.email, 'Emailed schedule change notices', `${prog.title}: ${Object.keys(updates).length} sent`);
  }
  return { ok: true, results, notified: fresh.notified || {}, changes: scheduleChanges(prog, fresh) };
}

/* ---------- Zoom links ---------- */
// Reads the upcoming meetings on the Zoom user TalentLMS creates them under and matches each live session by
// date, start time and length. Title words only break ties. Nothing is created or changed in Zoom or TalentLMS.
const ZOOM_WINDOW = 30;   // minutes either side of the session start a meeting may begin
const ZOOM_SURE = 15;     // a match is automatic when the best meeting starts within this many minutes...
const ZOOM_MARGIN = 15;   // ...and scores at least this much better than the next one
let zoomTok = { token: '', exp: 0 };
function zoomConfigured(env) { return !!(env.ZOOM_ACCOUNT_ID && env.ZOOM_CLIENT_ID && env.ZOOM_CLIENT_SECRET); }
async function zoomToken(env) {
  if (zoomTok.token && Date.now() < zoomTok.exp) return zoomTok.token;
  const r = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(env.ZOOM_ACCOUNT_ID)}`,
    { method: 'POST', headers: { Authorization: 'Basic ' + btoa(env.ZOOM_CLIENT_ID + ':' + env.ZOOM_CLIENT_SECRET) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw httpErr(502, `Zoom didn't accept the app credentials (${j.reason || j.error || r.status}). Check the three ZOOM_ settings and that the app is activated.`);
  zoomTok = { token: j.access_token, exp: Date.now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000 };
  return zoomTok.token;
}
async function zoomMeetings(env) {
  const user = env.ZOOM_USER || 'clearlearning@clearhq.org', tok = await zoomToken(env), out = [];
  let next = '';
  do {
    const r = await fetch(`https://api.zoom.us/v2/users/${encodeURIComponent(user)}/meetings?type=upcoming&page_size=300${next ? '&next_page_token=' + encodeURIComponent(next) : ''}`, { headers: { Authorization: 'Bearer ' + tok } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw httpErr(502, `Zoom couldn't list meetings for ${user} (${j.message || r.status}). Check the app's meeting permissions and ZOOM_USER.`);
    out.push(...(j.meetings || []));
    next = j.next_page_token || '';
  } while (next && out.length < 3000);
  return out.filter(m => m.start_time && m.join_url).map(m => ({ id: String(m.id), topic: String(m.topic || ''), start: Date.parse(m.start_time), duration: +m.duration || 0, join_url: m.join_url }));
}
function zonedUtc(date, clock, tz) {
  const mins = toMin(clock); const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, Math.floor(mins / 60), mins % 60);
  const off = ms => { const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
    const g = k => +p.find(x => x.type === k).value; return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) - ms; };
  let t = guess - off(guess); t = guess - off(t); return t;
}
const STOP = new Set(['session', 'sessions', 'live', 'instructor', 'led', 'program', 'online', 'with', 'from', 'that', 'this', 'your', 'cohort', 'open', 'closed', 'ncit', 'clear', 'and', 'the', 'for']);
const words = s => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !STOP.has(w));
function meetingScore(sess, m) {
  const dt = Math.abs(m.start - sess.utc) / 60000;
  if (dt > ZOOM_WINDOW) return null;
  const dd = Math.abs((m.duration || sess.dur) - sess.dur);
  const topic = m.topic.toLowerCase(), hits = sess.words.filter(w => topic.includes(w)).length;
  return { ...m, dt, dd, hits, score: dt * 2 + Math.min(dd, 120) * 0.5 - Math.min(hits, 4) * 6 };
}
const tzOf = p => TZIDS[String(p.timezone || 'ET').toUpperCase()] || ET;
async function zoomSync(env, opts = {}) {
  const today = todayET(), now = new Date().toISOString();
  const meetings = await zoomMeetings(env);
  const all = await listPrograms(env);
  const taken = new Map();
  for (const p of all) for (const s of p.sessions || []) if (s.zoomMeetingId) taken.set(s.zoomMeetingId, p.id + '|' + s.id);
  const progs = all.filter(p => (p.status === 'open' || p.status === 'closed') && !isInPerson(p) && (!opts.pid || p.id === opts.pid));
  const review = [], found = [];
  let unchanged = 0, replaced = 0, waiting = 0;
  for (const p of progs) {
    let dirty = false;
    for (const s of p.sessions || []) {
      if (!s.date || !s.start || !s.end || s.date < today || s.zoomSource === 'manual') continue;
      const me = p.id + '|' + s.id;
      const sess = { utc: zonedUtc(s.date, s.start, tzOf(p)), dur: toMin(s.end) - toMin(s.start), words: words(s.title + ' ' + p.title) };
      const cands = meetings.filter(m => !taken.has(m.id) || taken.get(m.id) === me).map(m => meetingScore(sess, m)).filter(Boolean).sort((a, b) => a.score - b.score);
      if (!cands.length) { if (!s.zoomLink) waiting++; continue; }
      const best = cands[0], next = cands[1];
      const sure = best.dt <= ZOOM_SURE && (!next || next.score - best.score >= ZOOM_MARGIN);
      if (!sure) {
        if (!s.zoomLink) review.push({ pid: p.id, sid: s.id, program: label(p), title: s.title, date: s.date, start: s.start, end: s.end, timezone: p.timezone || 'ET',
          candidates: cands.slice(0, 4).map(c => ({ id: c.id, topic: c.topic, start: new Date(c.start).toISOString(), duration: c.duration, join_url: c.join_url, dt: Math.round(c.dt) })) });
        continue;
      }
      if (s.zoomMeetingId === best.id && s.zoomLink === best.join_url) { unchanged++; continue; }
      const swap = !!(s.zoomLink && s.zoomLink !== best.join_url);
      if (swap) replaced++;
      found.push(`${label(p)}: ${s.title}`);
      if (!opts.dry) Object.assign(s, { zoomLink: best.join_url, zoomMeetingId: best.id, zoomSource: 'zoom', zoomTopic: best.topic, zoomAt: now }, swap ? { zoomReplacedAt: now } : {});
      taken.set(best.id, me);
      dirty = true;
    }
    if (dirty && !opts.dry) await putJSON(env, 'program:' + p.id, p); // updatedAt untouched so an open editor isn't blocked
  }
  const summary = { ok: true, at: now, meetings: meetings.length, found: found.length, replaced, unchanged, review: review.length, waiting, by: opts.by || '', dryRun: !!opts.dry };
  if (!opts.dry) {
    const prev = await getJSON(env, 'zoom:review', { items: [] });
    const items = opts.pid ? [...(prev.items || []).filter(i => i.pid !== opts.pid), ...review] : review;
    await putJSON(env, 'zoom:review', { at: now, items });
    await putJSON(env, 'zoom:last', summary);
    if (found.length || review.length) await log(env, opts.by || 'system', 'Checked Zoom for session links', `${found.length} found, ${review.length} to review${replaced ? ', ' + replaced + ' replaced' : ''}`);
  }
  return summary;
}
async function zoomAssign(env, body, by) {
  const prog = await getJSON(env, 'program:' + body.pid, null);
  const s = prog && (prog.sessions || []).find(x => x.id === body.sid);
  if (!s) throw httpErr(404, 'That session no longer exists.');
  const link = cleanUrl(body.join_url);
  if (!link) throw httpErr(400, 'Enter the Zoom link, starting with https://');
  if (s.zoomLink && s.zoomLink !== cleanUrl(body.join_url)) s.zoomReplacedAt = new Date().toISOString();
  Object.assign(s, body.meetingId
    ? { zoomLink: link, zoomMeetingId: String(body.meetingId).slice(0, 40), zoomSource: 'zoom', zoomTopic: String(body.topic || '').slice(0, 200), zoomAt: new Date().toISOString() }
    : { zoomLink: link, zoomMeetingId: '', zoomSource: 'manual', zoomTopic: '', zoomAt: new Date().toISOString() });
  await putJSON(env, 'program:' + prog.id, prog);
  const rv = await getJSON(env, 'zoom:review', { items: [] });
  rv.items = (rv.items || []).filter(i => !(i.pid === prog.id && i.sid === s.id));
  await putJSON(env, 'zoom:review', rv);
  await log(env, by, body.meetingId ? 'Matched a Zoom meeting' : 'Entered a Zoom link', `${label(prog)}: ${s.title}`);
  return { ok: true, session: s };
}
// Live online programs whose first session is within a week, with sessions still missing a link.
function missingLinks(programs, today) {
  const out = [];
  for (const p of programs) {
    if (!(p.status === 'open' || p.status === 'closed') || isInPerson(p)) continue;
    const first = firstLive(p); if (!first || daysBetween(today, first) > 7) continue;
    const miss = (p.sessions || []).filter(s => s.date >= today && !s.zoomLink);
    if (miss.length) out.push({ pid: p.id, program: label(p), first, sessions: miss.map(s => ({ sid: s.id, title: s.title, date: s.date, start: s.start, end: s.end })) });
  }
  return out.sort((a, b) => a.first.localeCompare(b.first));
}

/* ---------- Custom email ---------- */
function textToHtml(s) {
  return String(s || '').trim().split(/\n\s*\n/).map(par => `<p>${H(par).replace(/\n/g, '<br>').replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`).join('');
}
async function customRecipients(env, body, me) {
  const aud = String(body.audience || '');
  const act = me.roster.filter(r => r.active !== false);
  if (aud === 'all') return act;
  if (aud === 'pick') { const ids = new Set(body.iids || []); return me.roster.filter(r => ids.has(r.id)); }
  const prog = await getJSON(env, 'program:' + body.pid, null);
  if (!prog) throw httpErr(400, 'Choose a program for these recipients.');
  if (aud === 'program-confirmed') {
    const a = await getJSON(env, 'assign:' + prog.id, { slots: {} });
    return act.filter(r => confirmedFor(a, r.id).length);
  }
  const recs = await Promise.all(act.map(r => getJSON(env, 'resp:' + r.id, { programs: {} })));
  const rOf = i => (recs[i].programs || {})[prog.id];
  if (aud === 'program-responded') return act.filter((r, i) => rOf(i));
  if (aud === 'program-not-responded') return act.filter((r, i) => !rOf(i) && eligible(r, prog));
  if (aud === 'program-available') return act.filter((r, i) => { const x = rOf(i); return x && (x.program === 'A' || Object.values(x.sessions || {}).includes('A')); });
  throw httpErr(400, 'Choose who should receive this email.');
}
async function notifyCustom(env, body, me) {
  const subject = String(body.subject || '').trim().slice(0, 200), text = String(body.body || '').slice(0, 20000);
  const rich = body.bodyHtml ? sanitizeRich(body.bodyHtml) : '';
  if (!subject) throw httpErr(400, 'Add a subject.');
  if (!text.trim()) throw httpErr(400, 'Write a message.');
  const people = (await customRecipients(env, body, me)).filter(r => (r.emails || []).length);
  const greet = body.greet !== false;
  const build = name => ({
    subject: (body.test ? '[TEST] ' : '') + subject,
    html: emailShell(subject, `${greet ? `<p>Hello${name ? ' ' + H(firstName(name)) : ''},</p>` : ''}${rich || textToHtml(text)}`, me.origin)
  });
  const individual = people.length <= 40;
  if (body.preview) return { ok: true, preview: { ...build(individual && people[0] ? people[0].name : ''), count: people.length,
    to: people.length ? (individual ? `${people.length} recipient${people.length > 1 ? 's' : ''}, one email each: ${people.slice(0, 12).map(r => r.name).join('; ')}${people.length > 12 ? '…' : ''}` : `${env.NOTIFY_MAILBOX || '(mailbox)'}, with ${people.length} instructors in BCC`) : 'Nobody matches these recipients' } };
  if (body.test) { await sendMail(env, { to: [me.email], ...build(people[0] ? people[0].name : '') }); return { ok: true, sent: 1 }; }
  if (!people.length) throw httpErr(400, 'Nobody matches these recipients.');
  if (individual) for (const r of people) await sendMail(env, { to: [r.emails[0]], ...build(r.name) });
  else await sendMail(env, { to: [env.NOTIFY_MAILBOX], bcc: people.map(r => r.emails[0]), ...build('') });
  await log(env, me.email, 'Sent a custom email', `"${subject}" to ${people.length} instructors`);
  return { ok: true, sent: people.length };
}

function slotSig(mine) { return mine.map(m => m.slot + ':' + m.role).sort().join('|'); }
function firstName(name) { const s = String(name || ''); return s.includes(',') ? s.split(',')[1].trim().split(/\s+/)[0] : s.split(/\s+/)[0]; }

/* ======================= Staff: roster & staff ======================= */

async function saveRoster(env, body, me) {
  const list = Array.isArray(body.roster) ? body.roster : [];
  // Instructors set their own delivery preference; a staff save only changes it where staff edited it,
  // so an instructor's change made while staff had the list open isn't overwritten.
  const prevById = new Map((await getJSON(env, 'roster', [])).map(r => [r.id, r]));
  const seen = new Map();
  const roster = list.map(r => {
    const name = String(r.name || '').trim().slice(0, 120);
    if (!name) throw httpErr(400, 'Every instructor needs a name.');
    const emails = [...new Set((Array.isArray(r.emails) ? r.emails : String(r.emails || '').split(/[,;\s]+/))
      .map(e => String(e).trim().toLowerCase()).filter(Boolean))];
    for (const e of emails) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw httpErr(400, `"${e}" (${name}) isn't a valid email address.`);
      if (seen.has(e)) throw httpErr(400, `${e} is listed for both ${seen.get(e)} and ${name}. Each email can belong to one instructor.`);
      seen.set(e, name);
    }
    const quals = [...new Set((Array.isArray(r.quals) ? r.quals : []).filter(k => LOGO_NAMES.includes(k)))];
    const prev = prevById.get(r.id) || {};
    const delivery = r.deliveryEdited ? (DELIVERY.includes(r.delivery) ? r.delivery : '') : (prev.delivery || '');
    const deliveryAt = r.deliveryEdited ? new Date().toISOString() : (prev.deliveryAt || '');
    const deliveryBy = r.deliveryEdited ? me.email + ' (staff)' : (prev.deliveryBy || '');
    return { id: r.id || rid('i'), name, emails, active: r.active !== false, notes: String(r.notes || '').slice(0, 500), quals, delivery, deliveryAt, deliveryBy };
  });
  roster.sort((x, y) => x.name.localeCompare(y.name));
  await putJSON(env, 'roster', roster);
  await log(env, me.email, 'Saved instructor roster', `${roster.length} instructors, ${roster.filter(r => r.active).length} active`);
  let sync = { configured: false };
  try { sync = await syncAccess(env, roster); } catch (e) { sync = { configured: true, synced: false, message: e.message }; }
  return { ok: true, roster, sync };
}

async function saveDelivery(env, iid, value, by, staff) {
  const v = DELIVERY.includes(value) ? value : '';
  if (!v) throw httpErr(400, 'Choose online, in person, or both.');
  const roster = await getJSON(env, 'roster', []);
  const r = roster.find(x => x.id === iid);
  if (!r) throw httpErr(404, 'That instructor isn\'t on the roster.');
  Object.assign(r, { delivery: v, deliveryAt: new Date().toISOString(), deliveryBy: by + (staff ? ' (staff)' : '') });
  await putJSON(env, 'roster', roster);
  await log(env, by, 'Set delivery preference', `${r.name}: ${v}`);
  return { ok: true, delivery: v, deliveryAt: r.deliveryAt };
}

async function syncAccess(env, roster) {
  if (!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CF_ACCESS_GROUP_ID)) {
    return { configured: false, message: 'Automatic Access sync isn\'t set up. Copy the email list into the Access group by hand.' };
  }
  const emails = [...new Set(roster.filter(r => r.active !== false).flatMap(r => r.emails || []))];
  if (!emails.length) return { configured: true, synced: false, message: 'No active instructor emails yet, so the Access group was left as is.' };

  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/access/groups/${env.CF_ACCESS_GROUP_ID}`;
  const headers = { Authorization: 'Bearer ' + env.CF_API_TOKEN, 'Content-Type': 'application/json' };
  const g = await (await fetch(base, { headers })).json();
  if (!g.success) throw httpErr(502, 'Cloudflare couldn\'t read the Access group: ' + cfErr(g));
  const res = await (await fetch(base, {
    method: 'PUT', headers,
    body: JSON.stringify({
      name: g.result.name,
      include: emails.map(email => ({ email: { email } })),
      exclude: g.result.exclude || [],
      require: g.result.require || []
    })
  })).json();
  if (!res.success) throw httpErr(502, 'Cloudflare didn\'t update the Access group: ' + cfErr(res));
  await log(env, 'system', 'Synced Access group', `${emails.length} instructor emails`);
  return { configured: true, synced: true, count: emails.length, message: `Access group updated with ${emails.length} instructor emails.` };
}

function cfErr(j) { return (j.errors && j.errors[0] && j.errors[0].message) || 'unknown error'; }

async function saveStaff(env, body, by) {
  const list = (Array.isArray(body.staff) ? body.staff : []).map(s => ({
    email: String(s.email || '').trim().toLowerCase(),
    name: String(s.name || '').trim().slice(0, 120)
  })).filter(s => s.email);
  for (const s of list) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email)) throw httpErr(400, `"${s.email}" isn't a valid email address.`);
  await putJSON(env, 'config:staff', list);
  await log(env, by, 'Saved staff list', `${list.length} staff`);
  return { ok: true, staff: list };
}

/* ======================= Staff: selection ======================= */

async function saveAssignment(env, pid, body, me) {
  const prog = await getJSON(env, 'program:' + pid, null);
  if (!prog) throw httpErr(404, 'That program doesn\'t exist.');
  const key = 'assign:' + pid;
  const cur = await getJSON(env, key, { slots: {}, notes: [], history: [], notified: {} });
  if (body.baseUpdatedAt !== undefined && (cur.updatedAt || null) !== (body.baseUpdatedAt || null)) {
    throw httpErr(409, `${cur.updatedBy} changed the selections for this program at ${cur.updatedAt}. Reload to see their changes.`);
  }
  const valid = new Set([PROGRAM_SLOT, ...answerable(prog).map(s => s.id)]);
  const ids = new Set(me.roster.map(r => r.id));
  const slots = {};
  for (const [k, arr] of Object.entries(body.slots || {})) {
    if (!valid.has(k)) continue;
    const seen = new Set();
    const list = (arr || []).filter(e => ids.has(e.iid) && !seen.has(e.iid) && seen.add(e.iid)).map(e => ({
      iid: e.iid,
      role: ROLES.includes(e.role) ? e.role : 'Lead',
      status: e.status === 'Confirmed' ? 'Confirmed' : 'Tentative'
    }));
    if (list.length) slots[k] = list;
  }
  const history = (cur.history || []).slice(-29);
  if (cur.updatedAt) history.push({ at: cur.updatedAt, by: cur.updatedBy, slots: cur.slots });
  const next = { slots, notes: cur.notes || [], history, notified: cur.notified || {}, updatedAt: new Date().toISOString(), updatedBy: me.email };
  await putJSON(env, key, next);
  await log(env, me.email, 'Updated selections', prog.title);
  return { ok: true, assignment: { ...next, changes: scheduleChanges(prog, next) } };
}

async function addNote(env, pid, body, by) {
  const prog = await getJSON(env, 'program:' + pid, null);
  if (!prog) throw httpErr(404, 'That program doesn\'t exist.');
  const text = String(body.text || '').trim().slice(0, 2000);
  if (!text) throw httpErr(400, 'Write a note before adding it.');
  const key = 'assign:' + pid;
  const cur = await getJSON(env, key, { slots: {}, notes: [], history: [] });
  cur.notes = [...(cur.notes || []), { at: new Date().toISOString(), by, text }];
  await putJSON(env, key, cur); // notes don't change updatedAt, so they never block a selection save
  return { ok: true, notes: cur.notes };
}

/* ======================= Welcome email details ======================= */
// In-person welcome emails need venue and contact details the schedule doesn't hold; staff enter them in the program editor.
const WELCOME_KEYS = ['city', 'dates', 'vname', 'vstreet', 'vcity', 'reg', 'session', 'room', 'parking', 'cname', 'cphone', 'cemail'];
function cleanWelcome(w) {
  const out = {};
  if (w && typeof w === 'object') for (const k of WELCOME_KEYS) { const v = String(w[k] || '').trim().slice(0, 600); if (v) out[k] = v; }
  return out;
}

/* ======================= Evaluation reports ======================= */
// Staff publish each instructor's report from the evaluation report tool. Every report gets an unguessable link;
// only that instructor (or staff) can open it once signed in.
function slugId() { const b = new Uint8Array(16); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); }
const normName = s => String(s || '').toLowerCase().replace(/\s*\(.*?\)\s*/g, ' ').replace(/[^a-z,]+/g, ' ').replace(/\s+/g, ' ').replace(/\s*,\s*/, ',').trim();
async function publishReports(env, body, me) {
  const list = Array.isArray(body.reports) ? body.reports : [];
  if (!list.length) throw httpErr(400, 'There are no reports to publish.');
  if (list.length > 60) throw httpErr(400, 'Publish 60 reports or fewer at a time.');
  const byName = new Map(me.roster.map(r => [normName(r.name), r]));
  const published = [], unmatched = [], emailed = [], notEmailed = [];
  const now = new Date().toISOString();
  for (const raw of list) {
    const inst = byName.get(normName(raw.instructor));
    if (!inst) { unmatched.push(String(raw.instructor || '(no instructor)')); continue; }
    const html = String(raw.html || '');
    if (!/<html/i.test(html) || html.length > 900_000) throw httpErr(400, `The report for ${inst.name} isn't a valid report page or is too large.`);
    const slug = slugId();
    const meta = { slug, title: String(raw.title || 'Evaluation report').slice(0, 200), cohort: String(raw.cohort || '').slice(0, 300), createdAt: now, by: me.email };
    await env.IA_KV.put('report:' + slug, JSON.stringify({ ...meta, iid: inst.id, inst: inst.name, html }));
    const idx = await getJSON(env, 'reports:' + inst.id, []);
    idx.unshift(meta);
    await putJSON(env, 'reports:' + inst.id, idx.slice(0, 200));
    published.push({ inst: inst.name, slug });
    if (body.notify !== false && env.NOTIFY_FLOW_URL && (inst.emails || []).length) {
      try {
        await sendMail(env, { to: [inst.emails[0]], subject: 'A new evaluation report is available in the Instructor Portal',
          html: emailShell('A new evaluation report is available', `<p>Hello ${H(firstName(inst.name))},</p>
<p>A new evaluation report is available for you in the Instructor Portal${meta.cohort ? `, covering <strong style="color:#64092c;">${H(meta.cohort)}</strong>` : ''}. It summarizes participant ratings and comments from the module evaluations.</p>
<p>The report opens in your browser. To keep a copy, use your browser's print option and choose Save as PDF. All of your reports are also listed on the Evaluation reports page of the portal.</p>`, me.origin, { label: 'View your report', href: me.origin + '/api/report/' + slug }) });
        emailed.push(inst.name);
      } catch (e) { notEmailed.push(inst.name); }
    } else if (body.notify !== false) notEmailed.push(inst.name);
  }
  if (published.length) await log(env, me.email, 'Published evaluation reports', `${published.length} published${unmatched.length ? ', ' + unmatched.length + ' not matched to the roster' : ''}`);
  return { ok: true, published, unmatched, emailed, notEmailed };
}
async function listReports(env, me) {
  const out = [];
  const idxs = await Promise.all(me.roster.map(r => getJSON(env, 'reports:' + r.id, [])));
  me.roster.forEach((r, i) => idxs[i].forEach(x => out.push({ ...x, iid: r.id, inst: r.name, url: me.origin + '/api/report/' + x.slug })));
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { reports: out };
}
async function withdrawReport(env, slug, by) {
  const rec = await getJSON(env, 'report:' + slug, null);
  if (!rec) throw httpErr(404, 'That report no longer exists.');
  await env.IA_KV.delete('report:' + slug);
  const idx = (await getJSON(env, 'reports:' + rec.iid, [])).filter(x => x.slug !== slug);
  await putJSON(env, 'reports:' + rec.iid, idx);
  await log(env, by, 'Withdrew an evaluation report', `${rec.inst}: ${rec.title}`);
  return { ok: true };
}
async function viewReport(env, slug, me) {
  const rec = await getJSON(env, 'report:' + slug, null);
  const allowed = rec && (me.isStaff || (me.instructor && me.instructor.id === rec.iid));
  if (!allowed) return new Response('<!DOCTYPE html><title>Report not found</title><p style="font-family:Arial,sans-serif;padding:30px">This report isn\'t available. It may have been withdrawn, or it belongs to another instructor.</p>', { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (me.instructor && me.instructor.id === rec.iid && !rec.viewedAt) {
    rec.viewedAt = new Date().toISOString();
    await env.IA_KV.put('report:' + slug, JSON.stringify(rec));
    const idx = await getJSON(env, 'reports:' + rec.iid, []);
    const m = idx.find(x => x.slug === slug); if (m) { m.viewedAt = rec.viewedAt; await putJSON(env, 'reports:' + rec.iid, idx); }
  }
  // Reports are static pages: scripts are blocked so a report can't run code in the portal.
  return new Response(rec.html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "script-src 'none'; object-src 'none'; base-uri 'none'" } });
}

/* ======================= Expenses and hours ======================= */
// Instructors submit expense and hours reports to the CLEAR expense system (its Worker and SharePoint list).
// The portal fills in what it knows, reads only the signed-in instructor's own record from the expense system,
// sets name, email, tier and rate itself, and recalculates the totals before forwarding the report.
const EXPENSE_PROGRAM = {
  '126': 'NCIT Basic', '128': 'NCIT Basic', 'ip-ncit-b-us': 'NCIT Basic', 'ip-ncit-b-can': 'NCIT Basic',
  '129': 'NCIT Specialized', 'ip-ncit-s': 'NCIT Specialized', 'ip-ncit-ait': 'NCIT AIT',
  '143': 'NCIT IRSM', '169': 'NCIT DDI', '146': 'NCIT Comms', '157': 'NCIT Ethics',
  '138': 'ELPR', '147': 'SRA SAB', '142': 'BMT ACRG', '165': 'BCT GMFYB'
};
function expenseProgramFor(p) {
  if (EXPENSE_PROGRAM[p.courseId]) return EXPENSE_PROGRAM[p.courseId];
  const key = courseKeyOf(p);
  return { NCITB: 'NCIT Basic', NCITS: 'NCIT Specialized', NCITAIT: 'NCIT AIT', NCITWIRSM: 'NCIT IRSM', NCITWDDI: 'NCIT DDI', NCITWCSAP: 'NCIT Comms', NCITWERI: 'NCIT Ethics', ELPR: 'ELPR', SRASAB: 'SRA SAB', ACRG: 'BMT ACRG', BCT: 'BCT GMFYB', IRG: 'BMT IRG' }[key] || '';
}
const expBase = env => String(env.EXPENSE_WORKER_URL || '').replace(/\/+$/, '');
async function expenseFetch(env, path, opts = {}) {
  const r = await fetch(expBase(env) + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(env.EXPENSE_TOKEN ? { 'X-Auth-Token': env.EXPENSE_TOKEN } : {}), ...(opts.headers || {}) } });
  return r;
}
async function expenseConfig(env) {
  const cfg = { perdiem: 75, travelPct: 75, mileage: 0.67, tier1: 0, tier2: 0 };
  try { const r = await expenseFetch(env, '/expense/config'); if (r.ok) { const j = await r.json(); for (const k of Object.keys(cfg)) if (j[k] !== undefined && j[k] !== null && j[k] !== '') cfg[k] = Number(j[k]); } } catch (e) {}
  return cfg;
}
// The instructor's own entry in the expense system's instructor list, matched by sign-in email, then by name.
async function expenseInstructor(env, inst) {
  let list = [];
  try {
    if (env.EXPENSE_TOKEN) {
      const r = await expenseFetch(env, '/kv?key=expense_instructors');
      if (r.ok) { const j = await r.json(); const v = j.value; list = typeof v === 'string' ? JSON.parse(v) : (v || []); }
    }
    if (!list.length) {
      const r = await expenseFetch(env, '/expense/instructors');
      if (r.ok) { const j = await r.json(); list = j.instructors || []; }
    }
  } catch (e) { list = []; }
  const emails = (inst.emails || []).map(e => e.toLowerCase());
  return list.find(x => x.email && emails.includes(String(x.email).toLowerCase()))
    || list.find(x => normName(x.name) === normName(inst.name))
    || list.find(x => { const n = normName(inst.name).split(','); return n.length === 2 && normName(x.name) === normName(n[1] + ' ' + n[0]); })
    || null;
}
const rateFor = (cfg, tier) => String(tier || '').includes('1') ? cfg.tier1 : String(tier || '').includes('2') ? cfg.tier2 : 0;
async function expenseContext(env, inst, pid, me) {
  const prog = await getJSON(env, 'program:' + pid, null);
  if (!prog || prog.status === 'draft') throw httpErr(404, 'That program isn\'t available.');
  const mine = confirmedFor(await getJSON(env, 'assign:' + pid, null), inst.id);
  if (!mine.length) throw httpErr(403, 'You aren\'t confirmed to teach in this program.');
  const sessions = sessionsFor(prog, mine).slice().sort((a, b) => a.date.localeCompare(b.date) || toMin(a.start) - toMin(b.start));
  const ip = isInPerson(prog);
  // One teaching row per date: the scheduled hours and what was taught.
  const byDate = new Map();
  const add = (date, hours, label) => { const d = byDate.get(date) || { date, hours: 0, modules: [] }; d.hours += hours; if (label && !d.modules.includes(label)) d.modules.push(label); byDate.set(date, d); };
  if (!sessions.length) {
    for (let d = prog.startDate; d && d <= (prog.endDate || prog.startDate); d = addDays(d, 1)) add(d, 0, 'Entire program');
  } else for (const s of sessions) {
    if (s.endDate && s.endDate > s.date) { for (let d = s.date; d <= s.endDate; d = addDays(d, 1)) add(d, 0, s.title); } // multi-day module: hours entered by the instructor
    else add(s.date, Math.max(0, (toMin(s.end) - toMin(s.start)) / 60), s.title);
  }
  const days = [...byDate.values()].map(d => ({ date: d.date, hours: Math.round(d.hours * 4) / 4, modules: d.modules.join('; ') }));
  const cfg = await expenseConfig(env);
  const rec = await expenseInstructor(env, inst);
  const last = days.length ? days[days.length - 1].date : prog.endDate;
  const subs = (await getJSON(env, 'expsub:' + inst.id, [])).filter(s => s.pid === pid);
  return {
    ok: true, cfg,
    me: { name: rec ? rec.name || inst.name : inst.name, portalName: inst.name, email: (rec && rec.email) || (inst.emails || [])[0] || me.email,
      phone: rec ? rec.phone || '' : '', street: rec ? rec.street || '' : '', city: rec ? rec.city || '' : '', state: rec ? rec.state || '' : '',
      zip: rec ? rec.zip || '' : '', country: rec ? rec.country || '' : '', tier: rec ? String(rec.tier || '') : '', rate: rec ? rateFor(cfg, rec.tier) : 0, found: !!rec },
    program: { id: prog.id, title: prog.title, cohort: prog.cohort || '', option: expenseProgramFor(prog), delivery: ip ? 'in-person' : 'virtual',
      destination: ip ? (prog.location || '') : 'Virtual', first: days.length ? days[0].date : prog.startDate, last },
    days, opensOn: last, open: todayET() >= last, submitted: subs
  };
}
async function expenseSubmit(env, inst, body, me) {
  const pid = String(body.pid || '');
  const ctx = await expenseContext(env, inst, pid, me);
  if (!ctx.open) throw httpErr(409, `Expense and hours reports for this program open on ${longDate(ctx.opensOn)}, after your last session.`);
  const r = body.report || {};
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const teachingDays = (Array.isArray(r.teachingDays) ? r.teachingDays : []).slice(0, 60).map(d => ({ date: cleanDate(d.date), hours: Math.max(0, Math.min(24, num(d.hours))), program: String(d.program || '').slice(0, 300) })).filter(d => d.date || d.hours);
  const perDiemDays = (Array.isArray(r.perDiemDays) ? r.perDiemDays : []).slice(0, 60);
  const expenseLines = ctx.program.delivery === 'in-person' ? (Array.isArray(r.expenseLines) ? r.expenseLines : []).slice(0, 100) : [];
  const totalHours = teachingDays.reduce((s, d) => s + d.hours, 0);
  if (!totalHours) throw httpErr(400, 'Enter the hours for at least one teaching day.');
  const rate = num(ctx.me.rate), teachingPay = Math.round(totalHours * rate * 100) / 100;
  const perDiemTotal = Math.round(perDiemDays.reduce((s, d) => s + num(d.allowance), 0) * 100) / 100;
  const expenseTotal = Math.round(expenseLines.reduce((s, e) => s + num(e.amount), 0) * 100) / 100;
  const grandTotal = Math.round((teachingPay + perDiemTotal + expenseTotal) * 100) / 100;
  const id = 'EXP-' + Date.now();
  const report = {
    ...r, id, status: 'Pending', submittedAt: new Date().toISOString(), type: 'instructor',
    name: ctx.me.name, email: ctx.me.email, instructorName: ctx.me.name, instructorTier: ctx.me.tier, instructorRate: rate,
    phone: String(r.phone || ctx.me.phone || '').slice(0, 60), address: String(r.address || '').slice(0, 400),
    event: ctx.program.option || ctx.program.title, cohort: ctx.program.cohort,
    destination: ctx.program.delivery === 'virtual' ? 'Virtual' : String(r.destination || ctx.program.destination).slice(0, 200),
    teachingDays, perDiemDays, expenseLines, totalHours, teachingPay, perDiemTotal, expenseTotal, grandTotal,
    reimbursementTotal: grandTotal, personalMeals: 0, totalAmex: 0, submittedVia: 'Instructor Portal'
  };
  const res = await expenseFetch(env, '/expense/volunteer-submit', { method: 'POST', body: JSON.stringify(report) });
  if (res.status >= 400) throw httpErr(502, `The expense system didn't accept the report (${res.status}). Please try again, or contact clearlearning@clearhq.org.`);
  const list = await getJSON(env, 'expsub:' + inst.id, []);
  list.unshift({ id, pid, title: ctx.program.title, cohort: ctx.program.cohort, submittedAt: report.submittedAt, grandTotal, totalHours });
  await putJSON(env, 'expsub:' + inst.id, list.slice(0, 100));
  await log(env, me.email, 'Submitted an expense and hours report', `${inst.name}: ${ctx.program.title}${ctx.program.cohort ? ' (' + ctx.program.cohort + ')' : ''}, $${grandTotal.toFixed(2)}`);
  return { ok: true, id, grandTotal };
}
// Report status from the expense system (needs EXPENSE_TOKEN). Only this instructor's reports are returned.
async function expenseStatus(env, inst) {
  const mine = await getJSON(env, 'expsub:' + inst.id, []);
  if (!env.EXPENSE_TOKEN || !mine.length) return { ok: true, statuses: {} };
  try {
    const r = await expenseFetch(env, '/expense/getall', { method: 'POST', body: '{}' });
    if (!r.ok) return { ok: true, statuses: {} };
    const data = await r.json();
    const rows = Array.isArray(data) ? data : (data.value || data.items || []);
    const choice = v => v && typeof v === 'object' ? (v.Value || v.value || '') : (v || '');
    const ids = new Set(mine.map(x => x.id)), out = {};
    for (const x of rows) {
      const id = x.Title || x.id || '';
      if (!ids.has(id)) continue;
      out[id] = { status: choice(x.field_18) || choice(x.Status) || x.status || 'Pending', decidedAt: x.field_20 || x.DecidedAt || x.decidedAt || '' };
    }
    return { ok: true, statuses: out };
  } catch (e) { return { ok: true, statuses: {} }; }
}

/* ======================= Program Scheduler ======================= */
// One shared schedule for all staff. Each save names the version it was based on, so two people
// editing at once can't silently overwrite each other.
async function getSchedule(env) {
  const rec = await getJSON(env, 'schedule', null);
  return rec ? { state: rec.state, version: rec.version, updatedAt: rec.updatedAt, updatedBy: rec.updatedBy } : { state: null, version: 0 };
}
async function putSchedule(env, body, by) {
  const cur = await getJSON(env, 'schedule', null);
  const curVer = cur ? cur.version : 0;
  if ((body.baseVersion || 0) !== curVer) {
    const e = httpErr(409, `${cur.updatedBy} saved changes to the schedule at ${new Date(cur.updatedAt).toLocaleString('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })} ET.`);
    throw e;
  }
  const state = body.state;
  if (!state || typeof state !== 'object' || !Array.isArray(state.cohorts) || !Array.isArray(state.templates)) throw httpErr(400, 'That isn\'t a valid schedule.');
  const text = JSON.stringify(state);
  if (text.length > 4_000_000) throw httpErr(400, 'The schedule is too large to save.');
  const rec = { state, version: curVer + 1, updatedAt: new Date().toISOString(), updatedBy: by };
  await env.IA_KV.put('schedule', JSON.stringify(rec));
  if (!cur) await log(env, by, 'Started the shared program schedule', `${state.cohorts.length} cohorts`);
  return { ok: true, version: rec.version, updatedAt: rec.updatedAt };
}

/* ======================= Activity log ======================= */

async function log(env, by, action, detail) {
  const inv = String(9999999999999 - Date.now()).padStart(13, '0');
  const meta = { at: new Date().toISOString(), by: String(by).slice(0, 120), action: String(action).slice(0, 120), detail: String(detail || '').slice(0, 600) };
  await env.IA_KV.put(`log:${inv}:${rid('')}`, '', { metadata: meta, expirationTtl: 60 * 60 * 24 * 730 });
}

async function readLog(env) {
  const r = await env.IA_KV.list({ prefix: 'log:', limit: 300 });
  return { entries: r.keys.map(k => k.metadata).filter(Boolean) };
}

/* ======================= Helpers ======================= */

async function getJSON(env, key, fallback) {
  const v = await env.IA_KV.get(key, 'json');
  return v === null ? fallback : v;
}
async function putJSON(env, key, val) { await env.IA_KV.put(key, JSON.stringify(val)); }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
function rid(prefix) { return (prefix ? prefix + '_' : '') + crypto.randomUUID().replace(/-/g, '').slice(0, 10); }
function courseFamily(title) {
  const t = String(title || '');
  const rules = [[/Applied Investigative|\bAIT\b/i, 'ait'], [/Workshop Series/i, 'ws'], [/Specialized/i, 'spec'], [/Canadian|\bCAN\b/i, 'bcan'], [/NCIT.*Basic|Basic.*NCIT|NCIT B\b/i, 'bus'],
    [/Advanced Concepts|\bACRG\b/i, 'acrg'], [/Executive Leadership|\bELPR\b/i, 'elpr'], [/Staffing a Board|\bSRA\b/i, 'sra'], [/Getting the Most|Board Chair/i, 'chair'],
    [/Drug Diversion/i, 'ddi'], [/Sexual Misconduct/i, 'irsm'], [/Ethics/i, 'ethics'], [/Persuasion|Communications/i, 'comm']];
  const hit = rules.find(r => r[0].test(t));
  return hit ? hit[1] : '';
}
function keep0(o, k) { return o ? o[k] : undefined; }
function pick(o, keys) { const r = {}; for (const k of keys) if (o[k] !== undefined && o[k] !== '') r[k] = o[k]; return r; }
function label(p) { return p.title + (p.cohort ? ` (${p.cohort})` : ''); }
// Minutes after midnight from "1:30 PM" or "13:30"; 0 if unreadable.
function toMin(t) {
  const s = String(t || '').trim();
  let m = s.match(/^(\d{1,2}):(\d{2})\s*([AP])\.?M\.?$/i);
  if (m) return (+m[1] % 12 + (/p/i.test(m[3]) ? 12 : 0)) * 60 + +m[2];
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  return m ? +m[1] * 60 + +m[2] : 0;
}
function normTime(t) {
  const s = String(t || '').trim().slice(0, 20);
  if (!s) return '';
  if (!/^\d{1,2}:\d{2}(\s*[AP]\.?M\.?)?$/i.test(s)) return s;
  const m = toMin(s), h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
function cleanUrl(u) { const s = String(u || '').trim().slice(0, 500); return /^https:\/\/\S+$/i.test(s) ? s : ''; }
function cleanDate(d) { const s = String(d || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; }
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(iso) { if (!iso) return ''; const [y, m, d] = iso.split('-').map(Number); return `${MON[m - 1]} ${d}, ${y}`; }
function rangeText(a, b) {
  if (!a) return '';
  if (!b || a === b) return longDate(a);
  const [y1, m1] = a.split('-').map(Number), [y2, m2, d2] = b.split('-').map(Number);
  if (y1 === y2 && m1 === m2) return `${MON[m1 - 1]} ${+a.slice(8)} – ${d2}, ${y2}`;
  if (y1 === y2) return `${MON[m1 - 1]} ${+a.slice(8)} – ${MON[m2 - 1]} ${d2}, ${y2}`;
  return `${longDate(a)} – ${longDate(b)}`;
}
function fileSafe(s) { return String(s || 'calendar').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'calendar'; }
function getCookie(req, name) {
  const m = (req.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
function b64urlBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlText(s) { return new TextDecoder().decode(b64urlBytes(s)); }
