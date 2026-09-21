// Lien « se désabonner » des emails. GET = page de confirmation, POST = désabonnement (aussi utilisé par le « one-click » des clients mail).
import { sb, applyInbound, verify } from '../lib/core.mjs';
const page = (t) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>D4U</title><body style="margin:0;background:#050506;color:#e4e6ea;font:16px/1.6 system-ui;display:grid;place-items:center;min-height:100vh;padding:24px"><main style="max-width:420px">${t}</main>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
export default async (req) => {
  const url = new URL(req.url), u = url.searchParams.get('u') || '', c = url.searchParams.get('c') || '', t = url.searchParams.get('t') || '';
  if (!/^[0-9a-f-]{36}$/i.test(u) || !/^[\w-]{1,40}$/.test(c) || !verify(u, c, t)) return page('<p>Lien invalide ou expiré.</p>');
  if (req.method === 'POST') {
    await applyInbound(sb(), u, (x) => x.id === c, { optout: true, optoutSource: 'email', optoutAt: new Date().toISOString().slice(0, 10) });
    return page('<p style="font-size:20px">C’est fait.</p><p style="color:#8d939c">Tu ne recevras plus de messages de ce salon.</p>');
  }
  return page(`<p style="font-size:20px">Ne plus recevoir de messages ?</p><form method="POST"><button style="margin-top:16px;padding:14px 22px;background:#e9ecf0;color:#050506;border:0;border-radius:2px;font:600 13px system-ui;letter-spacing:.14em;text-transform:uppercase;cursor:pointer">Me désabonner</button></form>`);
};
export const config = { path: '/api/unsubscribe' };
