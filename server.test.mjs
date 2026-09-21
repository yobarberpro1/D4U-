import crypto from 'node:crypto';
import { createFake } from './fake.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const root = new URL('..', import.meta.url).pathname;
const fake = createFake({ root });
await fake.start();
Object.assign(process.env, {
  SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: 'SERVICE', SUPABASE_ANON_KEY: 'ANON',
  TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15145550000', TWILIO_API_BASE: fake.url,
  RESEND_API_KEY: 're_x', EMAIL_FROM: 'relance@d4u.test', RESEND_API_BASE: fake.url,
  SITE_URL: 'https://d4u.test', UNSUB_SECRET: 'sekret', DEFAULT_TZ: 'America/Toronto',
});
const core = await import('../netlify/lib/core.mjs');
const inbound = (await import('../netlify/functions/sms-inbound.mjs')).default;
const unsub = (await import('../netlify/functions/unsubscribe.mjs')).default;
const status = (await import('../netlify/functions/status.mjs')).default;
const runNow = (await import('../netlify/functions/run-now.mjs')).default;
const engineFn = (await import('../netlify/functions/engine.mjs')).default;
const cfgFn = (await import('../netlify/functions/config.mjs')).default;
const db = core.sb();

const D0 = '2026-09-21';
const ago = (n) => { const d = new Date(D0 + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const hist = (n) => [ago(n + 42), ago(n + 21), ago(n)];
const C = (id, o) => Object.assign({ id, key: id, prenom: id, nom: 'X', tel: '', email: '', lastVisit: '', dates: [], visits: 0, first: '', next: '', noshow: false, optout: false, stage: 0, lastSentDay: null, firstSentDay: null, relanced: false, replied: false, recovered: false }, o);
const withHist = (n) => ({ dates: hist(n), lastVisit: ago(n), first: ago(n + 42), visits: 3 });
const mkState = (extra = {}) => ({
  onboarded: true, sample: false,
  profile: { nom: 'Studio Cuts', lien: 'https://book.example.com/s', contact: '514 555 0123', freq: 21, adapt: true, prix: 35 },
  auto: { on: true, consent: true, noshow: true, retard: true, dormant: true, sms: true, email: true },
  clients: [
    C('marcus', { prenom: 'Marcus', tel: '514-555-0101', email: 'marcus@ex.com', ...withHist(47) }),
    C('kevin', { prenom: 'Kevin', tel: '514-555-0102', ...withHist(82) }),
    C('jordan', { prenom: 'Jordan', email: 'jordan@ex.com', ...withHist(31) }),
    C('actif', { prenom: 'Actif', tel: '514-555-0103', ...withHist(5) }),
    C('stop', { prenom: 'Stoppé', tel: '514-555-0104', optout: true, ...withHist(90) }),
    C('nocontact', { prenom: 'Sans', ...withHist(90) }),
  ], messages: [], ...extra,
});
async function newBarber(state) {
  const id = crypto.randomUUID();
  fake.db.barbers.set(id, { user_id: id, state, server_state: { patches: {}, messages: [] }, seq: 0, updated_at: new Date().toISOString() });
  return id;
}
const ss = (id) => fake.db.barbers.get(id).server_state;
const T1 = new Date('2026-09-21T15:00:00Z'), T2 = new Date('2026-09-25T15:00:00Z'), T3 = new Date('2026-10-02T15:00:00Z');

// ---------- 1. premier passage
let id = await newBarber(mkState());
let r = await core.processBarber(db, id, { now: T1 });
ok(r.sent === 3 && r.simulated === 0 && r.failed === 0, `1er passage : 3 relances réelles (${JSON.stringify(r)})`);
ok(fake.log.sms.length === 2 && fake.log.email.length === 1, 'SMS : Marcus + Kevin ; email : Jordan');
const smsTo = fake.log.sms.map((s) => s.to).sort();
ok(smsTo.join() === '+15145550101,+15145550102', 'numéros au format international ' + smsTo.join());
ok(fake.log.sms[0].body.includes('https://book.example.com/s') && fake.log.sms[0].body.includes('Réponds STOP'), 'SMS : lien de réservation + mention STOP');
ok(fake.log.sms[0].auth === 'Basic ' + Buffer.from('ACtest:tok').toString('base64') && fake.log.sms[0].from === '+15145550000', 'SMS : authentification Twilio + expéditeur');
const em = fake.log.email[0];
ok(em.to[0] === 'jordan@ex.com' && em.from.startsWith('Studio Cuts <relance@d4u.test>') && /^https:\/\/d4u\.test\/api\/unsubscribe\?u=/.test(em.headers['List-Unsubscribe'].slice(1)), 'email : expéditeur au nom du salon + lien de désabonnement signé');
ok(!em.text.includes('Réponds STOP') && em.text.includes('Pour ne plus recevoir de messages : https://d4u.test/api/unsubscribe'), 'email : pas de « Réponds STOP », lien de désabonnement à la place');
ok(em.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click' && em.reply_to === undefined, 'email : en-têtes one-click (pas de reply_to car contact = téléphone)');
let S1 = ss(id);
ok(S1.messages.length === 3 && S1.messages.every((m) => m.status === 'envoye' && m.simulated === false && m.srv), 'server_state : 3 messages envoyés, non simulés');
ok(['marcus', 'kevin', 'jordan'].every((c) => S1.patches[c] && S1.patches[c].stage === 1 && S1.patches[c].lastSentDay === D0 && S1.patches[c].relanced === true), 'server_state : séquence avancée pour les 3 clients');
ok(!S1.patches.actif && !S1.patches.stop && !S1.patches.nocontact, 'actif / désabonné / sans contact : jamais touchés');
ok(fake.db.sent_log.length === 2, 'journal des numéros contactés (pour retrouver le barbier sur un STOP)');

// ---------- 2. pas de doublon, fenêtre horaire
r = await core.processBarber(db, id, { now: T1 });
ok(r.sent === 0 && r.simulated === 0, 'repassage le même jour : aucun doublon');
r = await core.processBarber(db, id, { now: new Date('2026-09-21T07:00:00Z') });
ok(r.skipped === 'window' && fake.log.sms.length === 2, 'hors des heures d’envoi (3 h à Montréal) : rien ne part');

// ---------- 3. relance 2 (J+4) : canaux alternés
r = await core.processBarber(db, id, { now: T2 });
ok(r.sent === 3 && fake.log.email.length === 3 && fake.log.sms.length === 3, `relance 2 : Marcus + Jordan par email, Kevin (sans email) par SMS (${JSON.stringify(r)})`);

// ---------- 4. STOP entrant (signature Twilio)
const sig = (params, url = 'https://d4u.test/api/sms-inbound', tok = 'tok') => crypto.createHmac('sha1', tok).update(url + Object.keys(params).sort().map((k) => k + params[k]).join('')).digest('base64');
const post = (params, signature) => inbound(new Request('https://d4u.test/api/sms-inbound', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, body: new URLSearchParams(params) }));
let p1 = { From: '+15145550102', To: '+15145550000', Body: 'STOP' };
ok((await post(p1, 'mauvaise-signature')).status === 403, 'webhook SMS : signature invalide refusée');
ok((await post(p1, sig(p1))).status === 200, 'webhook SMS : STOP accepté (signature valide)');
let P = ss(id).patches;
ok(P.kevin.optout === true && P.kevin.optoutSource === 'stop' && P.kevin.stage === 2, 'STOP de Kevin : désabonnement enregistré sans perdre sa séquence');
let p2 = { From: '+15145550101', To: '+15145550000', Body: 'Oui je réserve demain !' };
await post(p2, sig(p2));
ok(ss(id).patches.marcus.replied === true, 'réponse de Marcus : séquence mise en pause (replied)');
let p3 = { From: '+15149999999', To: '+15145550000', Body: 'STOP' };
ok((await post(p3, sig(p3))).status === 200 && !ss(id).patches.unknown, 'STOP d’un numéro inconnu : ignoré sans erreur');

// ---------- 5. lien de désabonnement email
const u = core.unsubUrl(id, 'jordan');
let g = await unsub(new Request(u));
ok(g.status === 200 && (await g.text()).includes('Me désabonner'), 'lien email : page de confirmation');
ok((await (await unsub(new Request(u.replace(/t=\w+/, 't=deadbeef')))).text()).includes('invalide'), 'lien email : jeton falsifié refusé');
await unsub(new Request(u, { method: 'POST' }));
ok(ss(id).patches.jordan.optout === true && ss(id).patches.jordan.optoutSource === 'email', 'lien email : désabonnement enregistré (POST)');

// ---------- 6. relance 3 : désabonnés et répondants exclus
const nSms = fake.log.sms.length, nMail = fake.log.email.length;
r = await core.processBarber(db, id, { now: T3 });
ok(r.sent === 0 && fake.log.sms.length === nSms && fake.log.email.length === nMail, `relance 3 : Kevin (STOP), Jordan (désabonné), Marcus (a répondu) → aucun envoi (${JSON.stringify(r)})`);

// ---------- 7. sans fournisseur : simulation, jamais « envoyé » à tort
const saved = { ...process.env }; for (const k of ['TWILIO_ACCOUNT_SID', 'RESEND_API_KEY']) delete process.env[k];
const smsBefore = fake.log.sms.length;
let id2 = await newBarber(mkState());
r = await core.processBarber(db, id2, { now: T1 });
ok(r.sent === 0 && r.simulated === 3 && fake.log.sms.length === smsBefore, 'aucun fournisseur configuré : 3 envois SIMULÉS, rien ne part');
ok(ss(id2).messages.every((m) => m.simulated === true), 'messages marqués simulés');
ok((await (await status()).json()).sms === false, '/api/status : sms=false');
Object.assign(process.env, saved);
ok((await (await status()).json()).sms === true && (await (await status()).json()).email === true, '/api/status : sms/email=true quand les clés sont là');

// ---------- 8. données d'exemple : jamais d'envoi réel
let id3 = await newBarber(mkState({ sample: true }));
const before = fake.log.sms.length;
r = await core.processBarber(db, id3, { now: T1 });
ok(r.sent === 0 && r.simulated === 3 && fake.log.sms.length === before, 'clients d’exemple : simulation même avec les clés réelles (jamais de SMS aux faux numéros)');

// ---------- 9. échecs Twilio
fake.log.twilioFail['+15145550102'] = 21211;
let id4 = await newBarber(mkState());
r = await core.processBarber(db, id4, { now: T1 });
let m4 = ss(id4).messages.find((m) => m.clientId === 'kevin');
ok(r.sent === 2 && r.failed === 1 && m4.status === 'a_envoyer' && m4.tries === 3, 'numéro invalide (21211) : échec définitif, pas de réessai, autres envois OK');
r = await core.processBarber(db, id4, { now: T1 });
ok(r.sent === 0 && r.failed === 0, 'échec définitif : pas de nouvel essai à chaque passage');
delete fake.log.twilioFail['+15145550102']; fake.log.twilioFail['+15145550101'] = 21610;
let id5 = await newBarber(mkState());
await core.processBarber(db, id5, { now: T1 });
ok(ss(id5).patches.marcus.optout === true && ss(id5).patches.marcus.optoutSource === 'stop', 'Twilio 21610 (déjà désabonné) : client marqué désabonné');
delete fake.log.twilioFail['+15145550101'];

// ---------- 10. plafond par passage
let id6 = await newBarber(mkState());
const before6 = fake.log.sms.length + fake.log.email.length;
r = await core.processBarber(db, id6, { now: T1, maxSend: 1 });
ok(r.sent === 1 && r.left === 2, 'plafond par passage : 1 envoi, 2 restent en file');
r = await core.processBarber(db, id6, { now: T1, maxSend: 5 });
ok(r.sent === 2 && fake.log.sms.length + fake.log.email.length === before6 + 3, 'passage suivant : le reste part, aucun doublon (3 au total)');

// ---------- 11. règle de l'horloge logique : une action locale plus récente gagne
const st7 = mkState(); st7.clients[0].stAt = Date.now() + 60000; // Marcus vient d'être marqué « repris rendez-vous » dans l'app
let id7 = await newBarber(st7);
fake.db.barbers.get(id7).server_state = { patches: { marcus: { stage: 2, lastSentDay: ago(1), firstSentDay: ago(9), relanced: true, stAt: Date.now() - 100000 } }, messages: [] };
const E7 = core.makeEngine(st7, fake.db.barbers.get(id7).server_state, D0);
ok(JSON.parse(E7.seq()).marcus.stage === 0, 'patch serveur plus ancien que l’action locale : ignoré');

// ---------- 12. planificateur + run-now + config
let id8 = await newBarber(mkState());
const idOff = await newBarber(mkState({ auto: { on: false, consent: true } }));
const before8 = ss(idOff).messages.length;
process.env.SEND_HOUR_START = '0'; process.env.SEND_HOUR_END = '24';
await engineFn();
ok(ss(id8).messages.length === 3 && ss(idOff).messages.length === before8, 'planificateur : traite uniquement les barbiers avec relances ON');
let idA = fake.db.users.size; const user = { id: crypto.randomUUID(), email: 'a@b.co', password: 'x' }; fake.db.users.set(user.id, user);
const tokA = 'tok_' + user.id; fake.db.tokens.set(tokA, user.id);
fake.db.barbers.set(user.id, { user_id: user.id, state: mkState(), server_state: { patches: {}, messages: [] }, seq: 0, updated_at: '' });
let rn = await runNow(new Request('https://d4u.test/api/run-now', { method: 'POST', headers: { authorization: 'Bearer ' + tokA } }));
ok(rn.status === 200 && (await rn.json()).sent === 3, '/api/run-now : traite le compte de l’utilisateur connecté');
ok((await runNow(new Request('https://d4u.test/api/run-now', { method: 'POST', headers: { authorization: 'Bearer nope' } }))).status === 401, '/api/run-now : jeton invalide refusé');
ok((await runNow(new Request('https://d4u.test/api/run-now'))).status === 405, '/api/run-now : GET refusé');
delete process.env.SEND_HOUR_START; delete process.env.SEND_HOUR_END;
ok((await (await cfgFn()).text()).includes('"supabaseUrl"') && !(await (await cfgFn()).text()).includes('SERVICE'), '/config.js : URL + clé anon uniquement (jamais la clé service)');

// ---------- 13. écritures concurrentes (optimiste)
const idC = await newBarber(mkState());
const w1 = core.applyInbound(db, idC, (c) => c.id === 'marcus', { replied: true }), w2 = core.applyInbound(db, idC, (c) => c.id === 'kevin', { optout: true, optoutSource: 'stop' });
await Promise.all([w1, w2]);
ok(ss(idC).patches.marcus?.replied === true && ss(idC).patches.kevin?.optout === true, 'deux événements simultanés : aucun n’écrase l’autre');

await fake.stop();
console.log(fails ? `\n${fails} ÉCHEC(S)` : '\nTOUT PASSE'); process.exit(fails ? 1 : 0);
