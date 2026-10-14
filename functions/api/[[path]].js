/* CLEAR Learning Instructor Availability — API
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
     PORTAL_URL             link put in emails, e.g. https://availability.clearhq.org (defaults to this site)

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
function logoOf(p) {
  const name = (LOGO_NAMES.includes(p.logoSet) && p.logoSet) || LOGO_BY_COURSE[String(p.courseId || '')] || (LOGO_BY_TITLE.find(r => r[0].test(String(p.title || ''))) || [])[1] || '';
  return name ? LOGO_DIR + name + '.svg' : '';
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

    const email = await verifyAccess(request, env);
    if (!email) return json({ error: 'Your sign-in expired or is missing. Reload the page to sign in again.' }, 401);

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

  return String(payload.email || '').trim().toLowerCase() || null;
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
  return { ...p, track: trackOf(p), logo: logoOf(p), pastDeadline: pastDeadline(p, today), locked: isLocked(p, today) };
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
  const programs = all.filter(p => p.status === 'open' || p.status === 'closed').map(p => withState(p, today));
  if (!inst) return { me: publicMe(me), instructor: null, viewingAs, today, programs, responses: {}, assignments: [] };

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

  return { me: publicMe(me), instructor: { id: inst.id, name: inst.name }, viewingAs, today, programs, responses, assignments };
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
  programs.forEach((p, i) => { assignments[p.id] = assigns[i] || { slots: {}, notes: [], history: [], notified: {} }; });
  return {
    me: publicMe(me), today,
    programs, roster: me.roster, responses, assignments,
    staff: me.staff, admins: me.admins,
    accessSync: !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CF_ACCESS_GROUP_ID),
    config: {
      email: !!(env.NOTIFY_FLOW_URL && env.NOTIFY_MAILBOX),
      mailbox: env.NOTIFY_MAILBOX || '',
      portalUrl: me.origin,
      staffingUrl: env.STAFFING_DASHBOARD_URL || '',
      deadlineDays: DEADLINE_DAYS
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
      icsUid: String(s.icsUid || '').slice(0, 200),
      icsUids: (Array.isArray(s.icsUids) ? s.icsUids : []).map(u => String(u).slice(0, 200)).slice(0, 40),
      allInstructors: !!s.allInstructors
    };
  }).filter(s => s.title);
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
    return { ...n, id: hit ? hit.id : rid('s') };
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
  const stored = await env.IA_KV.get('ics:' + pid);
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
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CLEAR Learning//Instructor Availability//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
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
function emailShell(title, inner, origin) {
  return `<div style="font-family:'Open Sans',Arial,sans-serif;color:#2B2B2B;max-width:640px;margin:0 auto">
<div style="background:#64092C;color:#fff;padding:18px 22px;border-radius:8px 8px 0 0"><div style="font-size:12px;opacity:.85;font-weight:600">CLEAR Learning</div><div style="font-size:20px;font-weight:800;margin-top:2px">${H(title)}</div></div>
<div style="border:1px solid #DEDCE0;border-top:0;padding:20px 22px;border-radius:0 0 8px 8px;font-size:14px;line-height:1.55">${inner}
<p style="margin:22px 0 6px"><a href="${H(origin)}" style="background:#64092C;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block">Open the instructor availability portal</a></p>
<p style="font-size:12px;color:#6E6B70;margin-top:16px">Sign in with this email address; you'll get a one-time code by email. Questions: reply to this message or write to clearlearning@clearhq.org.</p></div></div>`;
}
function noteBlock(note) { return note ? `<p style="background:#F8EDD3;border-left:4px solid #DDA838;padding:10px 14px;border-radius:4px;white-space:pre-wrap">${H(note)}</p>` : ''; }
function whenText(p, s) {
  if (!s.start) return s.endDate ? `${longDate(s.date)} – ${longDate(s.endDate)}` : longDate(s.date);
  if (s.endDate) return `${longDate(s.date)}, ${s.start} – ${longDate(s.endDate)}, ${s.end} ${tz(p)}`;
  return `${longDate(s.date)}, ${s.start} – ${s.end} ${tz(p)}`;
}
function programLine(p) {
  const n = answerable(p).length, ip = /person/i.test(p.format || '');
  return `<tr><td style="padding:10px 0;border-bottom:1px solid #EEECEF"><strong style="color:#64092C">${H(p.title)}</strong>${p.cohort ? `<br><span style="color:#6E6B70">${H(p.cohort)}</span>` : ''}
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
  const subject = (body.test ? '[TEST] ' : '') + (progs.length === 1 ? `New CLEAR Learning program open for instructors: ${progs[0].title}` : `${progs.length} new CLEAR Learning programs are open for instructor availability`);
  const html = emailShell('New programs are open for availability', `<p>Hello,</p>
<p>CLEAR Learning has posted ${progs.length === 1 ? 'a new program' : progs.length + ' new programs'}. Please mark the sessions you could teach, and the ones you can't, by each program's response date.</p>
${noteBlock(body.note)}
<table style="width:100%;border-collapse:collapse">${progs.map(programLine).join('')}</table>
<p style="font-size:13px;color:#6E6B70">All session times are listed in Eastern Time. The portal can show them in your own time zone. You can change your answers at any time until the response date.</p>`, me.origin);
  const recips = activeRecipients(me.roster);
  if (body.preview) return { ok: true, preview: { subject, html, count: body.test ? 1 : recips.length, to: body.test ? me.email : `${env.NOTIFY_MAILBOX || '(mailbox)'}, with instructors in BCC` } };
  if (body.test) await sendMail(env, { to: [me.email], subject, html });
  else {
    if (!recips.length) throw httpErr(400, 'No active instructors have an email address yet.');
    for (let i = 0; i < recips.length; i += 400) {
      await sendMail(env, { to: [env.NOTIFY_MAILBOX], bcc: recips.slice(i, i + 400).map(x => x.email), subject, html });
    }
    const at = new Date().toISOString();
    for (const p of progs) { p.announcedAt = at; p.announcedBy = me.email; await putJSON(env, 'program:' + p.id, p); }
    await log(env, me.email, 'Announced programs by email', `${progs.map(p => p.title).join('; ')} to ${recips.length} instructors`);
  }
  return { ok: true, sent: body.test ? 1 : recips.length, announcedAt: body.test ? null : new Date().toISOString() };
}

async function notifyRemind(env, body, me) {
  const ids = Array.isArray(body.pids) ? body.pids : [];
  const today = todayET();
  const progs = (await Promise.all(ids.map(id => getJSON(env, 'program:' + id, null)))).filter(p => p && p.status === 'open' && !pastDeadline(p, today));
  if (!progs.length) throw httpErr(400, 'Choose at least one open program that is still taking answers.');
  const recips = activeRecipients(me.roster);
  const recs = await Promise.all(recips.map(x => getJSON(env, 'resp:' + x.r.id, { programs: {} })));
  const units = p => answerable(p).length ? answerable(p).map(s => s.id) : [PROGRAM_SLOT];
  const missing = recips.map((x, i) => {
    const list = progs.filter(p => {
      const r = (recs[i].programs || {})[p.id];
      if (!r) return true;
      return units(p).some(u => u === PROGRAM_SLOT ? !r.program : !((r.sessions || {})[u] || r.program));
    });
    return { ...x, list };
  }).filter(x => x.list.length);
  const build = x => ({
    subject: (body.test ? '[TEST] ' : '') + 'Reminder: please share your availability for CLEAR Learning programs',
    html: emailShell('Your availability is still needed', `<p>Hello ${H(firstName(x.r.name))},</p>
<p>We don't have your full answers yet for the program${x.list.length > 1 ? 's' : ''} below. Even a "not available" helps us plan.</p>${noteBlock(body.note)}
<table style="width:100%;border-collapse:collapse">${x.list.map(programLine).join('')}</table>`, me.origin)
  });
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
    const cal = await instructorIcs(env, pid, inst, true);
    const roleOf = slot => (mine.find(m => m.slot === slot) || {}).role || '';
    const rows = cal.whole && !(prog.sessions || []).length
      ? `<tr><td style="padding:8px 0;border-bottom:1px solid #EEECEF"><strong>Entire program</strong><br>${H(rangeText(prog.startDate, prog.endDate))}${prog.location && prog.location !== 'Virtual' ? ', ' + H(prog.location) : ''}</td><td style="padding:8px 0;border-bottom:1px solid #EEECEF;text-align:right">${H(roleOf(PROGRAM_SLOT))}</td></tr>`
      : cal.sessions.map(s => `<tr><td style="padding:8px 0;border-bottom:1px solid #EEECEF"><strong>${H(s.title)}</strong><br>${H(whenText(prog, s))}${s.zoomLink ? `<br><a href="${H(s.zoomLink)}">${H(s.zoomLink)}</a>` : ''}</td><td style="padding:8px 0;border-bottom:1px solid #EEECEF;text-align:right;white-space:nowrap">${H(roleOf(s.id) || roleOf(PROGRAM_SLOT) || (s.allInstructors ? 'All instructors attend' : ''))}</td></tr>`).join('');
    const subject = (body.test ? '[TEST] ' : '') + `You're confirmed to teach: ${prog.title}${prog.cohort ? ' (' + prog.cohort + ')' : ''}`;
    const html = emailShell("You've been selected to teach", `<p>Hello ${H(firstName(inst.name))},</p>
<p>Thank you for sharing your availability. You're confirmed for the following in <strong>${H(prog.title)}</strong>${prog.cohort ? `, ${H(prog.cohort)}` : ''}:</p>${noteBlock(body.note)}
<table style="width:100%;border-collapse:collapse">${rows}</table>
<p>A calendar file is attached. Open it to add ${cal.sessions.length > 1 || cal.whole ? 'these sessions' : 'this session'} to your calendar${(prog.sessions || []).some(s => s.zoomLink) ? ' with the Zoom links' : ''}. ${(prog.format || '').match(/person/i) ? '' : 'Times are Eastern Time; the portal can show them in your time zone. '}You'll also find this assignment on the My assignments tab of the portal.</p>`, me.origin);
    if (body.preview) { previewOut = { subject, html, to: inst.emails[0], attachment: cal.name + (cal.fromFile ? ' (filtered from the program\'s calendar file)' : ' (built from the session details; no calendar file uploaded)'), count: ids.length }; break; }
    await sendMail(env, { to: body.test ? [me.email] : [inst.emails[0]], subject, html, attachments: [{ name: cal.name, base64: b64utf8(cal.ics) }] });
    results.push({ iid, ok: true });
    if (!body.test) {
      assign.notified = assign.notified || {};
      assign.notified[iid] = { at: new Date().toISOString(), by: me.email, sig: slotSig(mine) };
    }
  }
  if (body.preview) return { ok: true, preview: previewOut || { subject: '', html: '<p>Nothing to preview.</p>', to: '', count: 0, error: (results[0] || {}).error } };
  if (!body.test && results.some(r => r.ok)) {
    const cur = await getJSON(env, key, { slots: {}, notes: [], history: [] });
    cur.notified = { ...(cur.notified || {}), ...assign.notified };
    await putJSON(env, key, cur); // updatedAt untouched, like notes
    await log(env, me.email, 'Emailed selection notices', `${prog.title}: ${results.filter(r => r.ok).length} sent`);
    return { ok: true, results, notified: cur.notified };
  }
  return { ok: true, results, notified: assign.notified || {} };
}

function slotSig(mine) { return mine.map(m => m.slot + ':' + m.role).sort().join('|'); }
function firstName(name) { const s = String(name || ''); return s.includes(',') ? s.split(',')[1].trim().split(/\s+/)[0] : s.split(/\s+/)[0]; }

/* ======================= Staff: roster & staff ======================= */

async function saveRoster(env, body, me) {
  const list = Array.isArray(body.roster) ? body.roster : [];
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
    return { id: r.id || rid('i'), name, emails, active: r.active !== false, notes: String(r.notes || '').slice(0, 500) };
  });
  roster.sort((x, y) => x.name.localeCompare(y.name));
  await putJSON(env, 'roster', roster);
  await log(env, me.email, 'Saved instructor roster', `${roster.length} instructors, ${roster.filter(r => r.active).length} active`);
  let sync = { configured: false };
  try { sync = await syncAccess(env, roster); } catch (e) { sync = { configured: true, synced: false, message: e.message }; }
  return { ok: true, roster, sync };
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
  return { ok: true, assignment: next };
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
