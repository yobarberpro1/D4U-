// D4U : cœur serveur partagé par les fonctions Netlify.
// - accès Supabase (REST, sans dépendance)
// - moteur de relance : EXACTEMENT le même code que l'app (engine-src.mjs est généré depuis l'app)
// - envoi réel : Twilio (SMS) et Resend (email). Sans clés, les envois restent simulés et marqués comme tels.
import vm from 'node:vm';
import crypto from 'node:crypto';
import ENGINE_SRC from './engine-src.mjs';

const script = new vm.Script(ENGINE_SRC, { filename: 'd4u-engine.js' });
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

/* ---------- heures d'envoi ---------- */
export const hours = () => ({ start: +env('SEND_HOUR_START', 10), end: +env('SEND_HOUR_END', 19) });
export function localNow(tz, d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: +g('hour') };
}
export const inWindow = (h) => h >= hours().start && h < hours().end;

/* ---------- Supabase ---------- */
export function sb() {
  const url = env('SUPABASE_URL', ''), key = env('SUPABASE_SERVICE_ROLE_KEY', '');
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants');
  const base = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  async function req(method, path, body, extra) {
    const r = await fetch(url + path, { method, headers: { ...base, ...(extra || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    if (!r.ok) throw new Error(`Supabase ${r.status} ${method} ${path.split('?')[0]}: ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  }
  return {
    async listAutoBarbers() { return (await req('GET', '/rest/v1/barbers?select=user_id&state->auto->>on=eq.true&limit=1000')).map((r) => r.user_id); },
    async getBarber(id) { return ((await req('GET', `/rest/v1/barbers?user_id=eq.${id}&select=user_id,state,server_state,seq`)) || [])[0] || null; },
    async getServerState(id) { return ((await req('GET', `/rest/v1/barbers?user_id=eq.${id}&select=server_state,seq`)) || [])[0] || null; },
    // écriture optimiste : ne réussit que si personne d'autre n'a écrit entre-temps
    async saveServerState(id, seq, ss) {
      const r = await req('PATCH', `/rest/v1/barbers?user_id=eq.${id}&seq=eq.${seq}`, { server_state: ss, seq: seq + 1 }, { Prefer: 'return=representation' });
      return Array.isArray(r) && r.length === 1;
    },
    async logSent(rows) { if (rows.length) await req('POST', '/rest/v1/sent_log?on_conflict=user_id,phone_key', rows, { Prefer: 'resolution=merge-duplicates,return=minimal' }); },
    async findSent(phoneKey) { return (await req('GET', `/rest/v1/sent_log?phone_key=eq.${phoneKey}&select=user_id`)).map((r) => r.user_id); },
    async userFromToken(token) {
      const r = await fetch(url + '/auth/v1/user', { headers: { apikey: key, Authorization: 'Bearer ' + token } });
      if (!r.ok) return null;
      const u = await r.json();
      return u && u.id ? u : null;
    },
  };
}

/* ---------- moteur (code de l'app exécuté côté serveur) ---------- */
export function makeEngine(state, serverState, today) {
  const store = { 'relanceur.v1': JSON.stringify(state) };
  const ctx = { localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } } };
  ctx.window = ctx;
  vm.createContext(ctx);
  script.runInContext(ctx);
  const E = ctx.window.__E;
  E.boot(serverState || { patches: {}, messages: [] }, today);
  return E;
}

/* ---------- fournisseurs d'envoi ---------- */
export function providersReady(sample = false) {
  if (sample) return { sms: false, email: false };
  return {
    sms: !!(env('TWILIO_ACCOUNT_SID') && env('TWILIO_AUTH_TOKEN') && (env('TWILIO_MESSAGING_SERVICE_SID') || env('TWILIO_FROM'))),
    email: !!(env('RESEND_API_KEY') && env('EMAIL_FROM')),
  };
}
export async function sendSms(to, body) {
  const sid = env('TWILIO_ACCOUNT_SID'), tok = env('TWILIO_AUTH_TOKEN'), apiBase = env('TWILIO_API_BASE', 'https://api.twilio.com');
  const form = new URLSearchParams({ To: to, Body: body });
  if (env('TWILIO_MESSAGING_SERVICE_SID')) form.set('MessagingServiceSid', env('TWILIO_MESSAGING_SERVICE_SID')); else form.set('From', env('TWILIO_FROM'));
  const r = await fetch(`${apiBase}/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
  });
  const t = await r.text();
  if (!r.ok) { const e = new Error(`Twilio ${r.status} ${t.slice(0, 160)}`); try { e.code = JSON.parse(t).code; } catch (_) {} throw e; }
  return JSON.parse(t).sid;
}
export async function sendEmail({ to, subject, text, fromName, replyTo, unsubUrl }) {
  const apiBase = env('RESEND_API_BASE', 'https://api.resend.com');
  const from = `${(fromName || 'D4U').replace(/[<>"]/g, '')} <${env('EMAIL_FROM')}>`;
  const body = { from, to: [to], subject, text, headers: { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
  if (replyTo) body.reply_to = replyTo;
  const r = await fetch(`${apiBase}/emails`, { method: 'POST', headers: { Authorization: 'Bearer ' + env('RESEND_API_KEY'), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`Resend ${r.status} ${t.slice(0, 160)}`);
  return JSON.parse(t).id;
}

/* ---------- désabonnement par email : lien signé ---------- */
const secret = () => env('UNSUB_SECRET', env('SUPABASE_SERVICE_ROLE_KEY', ''));
export const sign = (userId, clientId) => crypto.createHmac('sha256', secret()).update(`${userId}.${clientId}`).digest('hex').slice(0, 32);
export const verify = (userId, clientId, t) => { const a = Buffer.from(sign(userId, clientId)), b = Buffer.from(String(t || '')); return a.length === b.length && crypto.timingSafeEqual(a, b); };
export const siteUrl = () => env('SITE_URL', env('URL', '')).replace(/\/$/, '');
export const unsubUrl = (userId, clientId) => `${siteUrl()}/api/unsubscribe?u=${userId}&c=${clientId}&t=${sign(userId, clientId)}`;

/* ---------- fusion des écritures serveur ---------- */
export function mergeSS(cur, ours) {
  const out = { ...(cur || {}), patches: { ...((cur && cur.patches) || {}) }, messages: [] };
  for (const [id, p] of Object.entries(ours.patches || {})) {
    const c = out.patches[id];
    if (!c) { out.patches[id] = p; continue; }
    const newer = (p.stAt || 0) >= (c.stAt || 0) ? p : c, older = newer === p ? c : p;
    out.patches[id] = { ...older, ...newer, stAt: Math.max(p.stAt || 0, c.stAt || 0) };
  }
  const byId = new Map(((cur && cur.messages) || []).map((m) => [m.id, m]));
  for (const id of ours.dropped || []) byId.delete(id);
  for (const m of ours.messages || []) { const o = byId.get(m.id); if (!(o && o.status === 'envoye' && m.status !== 'envoye')) byId.set(m.id, m); }
  out.messages = [...byId.values()].slice(-5000);
  return out;
}
async function writeSS(db, userId, ours, mutate) {
  for (let i = 0; i < 6; i++) {
    const cur = await db.getServerState(userId);
    if (!cur) return false;
    const merged = mutate ? mutate(cur.server_state || { patches: {}, messages: [] }) : mergeSS(cur.server_state, ours);
    if (await db.saveServerState(userId, cur.seq, merged)) return true;
  }
  throw new Error('server_state : écritures concurrentes, réessaie');
}

/* ---------- événements entrants (STOP, réponse, lien de désabonnement) ---------- */
export async function applyInbound(db, userId, find, fields) {
  const row = await db.getBarber(userId);
  const hits = ((row && row.state && row.state.clients) || []).filter(find);
  if (!hits.length) return 0;
  await writeSS(db, userId, null, (ss) => {
    const patches = { ...(ss.patches || {}) };
    for (const c of hits) { const prev = patches[c.id] || {}; patches[c.id] = { ...prev, ...fields, stAt: Math.max(Date.now(), (prev.stAt || 0) + 1, (c.stAt || 0) + 1) }; }
    return { ...ss, patches };
  });
  return hits.length;
}

/* ---------- traitement d'un barbier ---------- */
const PERMANENT = new Set([21211, 21214, 21614, 21408]); // numéro invalide / destination interdite
export async function processBarber(db, userId, o = {}) {
  const t0 = Date.now(), budget = o.budgetMs ?? 20000, maxSend = o.maxSend ?? +env('MAX_SENDS_PER_RUN', 40);
  const row = await db.getBarber(userId);
  const S = { userId, sent: 0, simulated: 0, failed: 0, left: 0, skipped: null };
  if (!row || !row.state || !Object.keys(row.state).length) return { ...S, skipped: 'no-state' };
  const st = row.state;
  if (!(st.auto && st.auto.on && st.auto.consent)) return { ...S, skipped: 'auto-off' };
  const tz = (st.profile && st.profile.tz) || env('DEFAULT_TZ', 'America/Toronto');
  const ln = localNow(tz, o.now);
  if (!o.ignoreWindow && !inWindow(ln.hour)) return { ...S, skipped: 'window' };

  const E = makeEngine(st, row.server_state, ln.date);
  const before = JSON.parse(E.seq());
  E.prepare();
  const queue = JSON.parse(E.queue());
  const prov = providersReady(E.sample());
  const profile = JSON.parse(E.profile());
  const footer = E.footer();
  const smsKeys = [], optouts = [];
  const ours = () => {
    const after = JSON.parse(E.seq()), patches = {};
    for (const [id, p] of Object.entries(after)) if (JSON.stringify(p) !== JSON.stringify(before[id])) patches[id] = p;
    return { patches, messages: JSON.parse(E.out()), dropped: JSON.parse(E.dropped()) };
  };
  const persist = () => writeSS(db, userId, ours());

  let n = 0;
  for (const q of queue) {
    if (n >= maxSend || Date.now() - t0 > budget) { S.left++; continue; }
    n++;
    try {
      if (q.channel === 'sms' && prov.sms) {
        if (!/^\d{10,15}$/.test(q.phone || '')) { const e = new Error('numéro invalide'); e.permanent = true; throw e; }
        await sendSms('+' + q.phone, q.text);
        E.sent(q.id, 'sms', false); S.sent++; smsKeys.push(q.phone.slice(-10));
      } else if (q.channel === 'email' && prov.email) {
        const link = unsubUrl(userId, q.clientId);
        await sendEmail({ to: q.email, subject: 'Ton prochain rendez-vous chez ' + (profile.nom || ''), text: q.text.replace(footer, 'Pour ne plus recevoir de messages : ' + link), fromName: profile.nom, replyTo: /@/.test(profile.contact || '') ? profile.contact : '', unsubUrl: link });
        E.sent(q.id, 'email', false); S.sent++;
      } else { E.sent(q.id, q.channel, true); S.simulated++; }
    } catch (e) {
      S.failed++;
      if (e.code === 21610) optouts.push(q); // Twilio : le destinataire s'est désabonné (STOP)
      E.fail(q.id, e.message, !!e.permanent || PERMANENT.has(e.code));
    }
    if (n % 10 === 0) await persist();
  }
  await persist();
  await db.logSent([...new Set(smsKeys)].map((k) => ({ user_id: userId, phone_key: k, at: new Date().toISOString() }))).catch(() => {});
  for (const q of optouts) await applyInbound(db, userId, (c) => c.id === q.clientId, { optout: true, optoutSource: 'stop', optoutAt: ln.date });
  return S;
}

/* ---------- signature Twilio ---------- */
export function validSignature(url, params, signature, token) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', token).update(data).digest('base64');
  const a = Buffer.from(expected), b = Buffer.from(signature || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
