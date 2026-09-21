// Faux Supabase (auth + REST + RLS simplifiée) + faux Twilio + faux Resend, et adaptateur vers les vraies fonctions Netlify.
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

export function createFake({ root }) {
  const db = { users: new Map(), tokens: new Map(), refresh: new Map(), barbers: new Map(), sent_log: [] };
  const log = { sms: [], email: [], twilioFail: {}, confirmEmail: false, denied: [] };
  const ANON = 'ANON', SERVICE = 'SERVICE';
  const fns = new Map(); // path -> handler
  let server, port;

  const send = (res, code, obj, extra = {}) => { const b = obj === undefined ? '' : (typeof obj === 'string' ? obj : JSON.stringify(obj)); res.writeHead(code, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'apikey,authorization,content-type,prefer,x-twilio-signature', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS', 'content-type': typeof obj === 'string' ? 'text/plain' : 'application/json', ...extra }); res.end(b); };
  const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
  const mkSession = (u) => { const at = 'at_' + crypto.randomUUID(), rt = 'rt_' + crypto.randomUUID(); db.tokens.set(at, u.id); db.refresh.set(rt, u.id); return { access_token: at, refresh_token: rt, expires_in: 3600, user: { id: u.id, email: u.email } }; };
  const who = (req) => { const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); if (t === SERVICE) return { role: 'service' }; if (db.tokens.has(t)) return { role: 'user', id: db.tokens.get(t) }; return { role: 'anon' }; };
  const filt = (q) => { const f = {}; for (const [k, v] of q.entries()) if (v.startsWith('eq.')) f[k] = v.slice(3); return f; };
  const getPath = (o, p) => p.split('->').reduce((a, k) => (k.startsWith('>') ? a?.[k.slice(1)] : a?.[k]), o);

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    if (req.method === 'OPTIONS') return send(res, 204);
    // --- fonctions Netlify réelles
    if (fns.has(p)) {
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
      const r = await fns.get(p)(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body }));
      const buf = Buffer.from(await r.arrayBuffer()); const h = {}; r.headers.forEach((v, k) => { h[k] = v; }); h['access-control-allow-origin'] = '*';
      res.writeHead(r.status, h); return res.end(buf);
    }
    // --- site statique
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(root, 'public/index.html'))); }
    // --- auth
    if (p === '/auth/v1/signup') {
      const b = JSON.parse((await readBody(req)).toString());
      if ((b.password || '').length < 8) return send(res, 422, { msg: 'Password should be at least 8 characters.' });
      if ([...db.users.values()].some((u) => u.email === b.email)) return send(res, 422, { msg: 'User already registered' });
      const u = { id: crypto.randomUUID(), email: b.email, password: b.password }; db.users.set(u.id, u);
      return send(res, 200, log.confirmEmail ? { id: u.id, email: u.email } : mkSession(u));
    }
    if (p === '/auth/v1/token') {
      const b = JSON.parse((await readBody(req)).toString()), gt = url.searchParams.get('grant_type');
      if (gt === 'password') { const u = [...db.users.values()].find((x) => x.email === b.email && x.password === b.password); return u ? send(res, 200, mkSession(u)) : send(res, 400, { error_description: 'Invalid login credentials' }); }
      const id = db.refresh.get(b.refresh_token); if (!id) return send(res, 400, { error_description: 'Invalid Refresh Token' });
      return send(res, 200, mkSession(db.users.get(id)));
    }
    if (p === '/auth/v1/user') { const w = who(req); if (w.role !== 'user') return send(res, 401, { msg: 'invalid' }); const u = db.users.get(w.id); return send(res, 200, { id: u.id, email: u.email }); }
    // --- REST barbers (RLS + privilèges de colonnes simulés)
    if (p === '/rest/v1/barbers') {
      const w = who(req), f = filt(url.searchParams);
      if (w.role === 'anon') { log.denied.push('anon'); return send(res, 403, { message: 'permission denied' }); }
      if (req.method === 'GET') {
        let rows = [...db.barbers.values()];
        if (w.role === 'user') rows = rows.filter((r) => r.user_id === w.id);
        if (f.user_id) rows = rows.filter((r) => r.user_id === f.user_id);
        if (url.searchParams.get('state->auto->>on') === 'eq.true') rows = rows.filter((r) => r.state?.auto?.on === true);
        const sel = (url.searchParams.get('select') || '*').split(',');
        return send(res, 200, rows.map((r) => (sel[0] === '*' ? r : Object.fromEntries(sel.map((k) => [k, r[k]])))));
      }
      if (req.method === 'PATCH') {
        const b = JSON.parse((await readBody(req)).toString());
        if (w.role === 'user') { const bad = Object.keys(b).filter((k) => !['state', 'updated_at'].includes(k)); if (bad.length) { log.denied.push('col:' + bad.join()); return send(res, 403, { message: 'permission denied for columns ' + bad }); } }
        let rows = [...db.barbers.values()].filter((r) => (!f.user_id || r.user_id === f.user_id) && (f.seq === undefined || String(r.seq) === f.seq) && (w.role !== 'user' || r.user_id === w.id));
        rows.forEach((r) => Object.assign(r, b));
        return String(req.headers.prefer || '').includes('return=representation') ? send(res, 200, rows) : send(res, 204);
      }
      if (req.method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString());
        if (w.role === 'user' && (b.user_id !== w.id || Object.keys(b).some((k) => !['user_id', 'state'].includes(k)))) return send(res, 403, { message: 'denied' });
        if (db.barbers.has(b.user_id)) return send(res, 409, { message: 'duplicate' });
        db.barbers.set(b.user_id, { user_id: b.user_id, state: b.state || {}, server_state: { patches: {}, messages: [] }, seq: 0, updated_at: new Date().toISOString() });
        return send(res, 201);
      }
    }
    if (p === '/rest/v1/sent_log') {
      if (who(req).role !== 'service') return send(res, 403, { message: 'denied' });
      if (req.method === 'GET') { const f = filt(url.searchParams); return send(res, 200, db.sent_log.filter((r) => r.phone_key === f.phone_key).map((r) => ({ user_id: r.user_id }))); }
      const rows = JSON.parse((await readBody(req)).toString()); for (const r of rows) { if (!db.sent_log.some((x) => x.user_id === r.user_id && x.phone_key === r.phone_key)) db.sent_log.push(r); } return send(res, 201);
    }
    // --- Twilio
    if (/\/Messages\.json$/.test(p)) {
      const b = new URLSearchParams((await readBody(req)).toString()), to = b.get('To');
      if (log.twilioFail[to]) return send(res, 400, { code: log.twilioFail[to], message: 'fail' });
      log.sms.push({ to, body: b.get('Body'), auth: req.headers.authorization, from: b.get('From'), svc: b.get('MessagingServiceSid') });
      return send(res, 201, { sid: 'SM' + log.sms.length });
    }
    // --- Resend
    if (p === '/emails') { const b = JSON.parse((await readBody(req)).toString()); log.email.push({ ...b, auth: req.headers.authorization }); return send(res, 200, { id: 'em' + log.email.length }); }
    send(res, 404, { error: 'not found ' + p });
  }
  return {
    db, log, ANON, SERVICE,
    register(p, fn) { fns.set(p, fn); },
    async start() { server = http.createServer((q, r) => handle(q, r).catch((e) => { console.error('fake error', e); send(r, 500, { error: String(e) }); })); await new Promise((r) => server.listen(0, '127.0.0.1', r)); port = server.address().port; return port; },
    get url() { return `http://127.0.0.1:${port}`; },
    stop() { return new Promise((r) => server.close(r)); },
  };
}
