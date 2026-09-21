// Webhook Twilio (SMS entrant) : STOP => désabonnement définitif ; toute autre réponse => la séquence se met en pause.
import { sb, applyInbound, siteUrl, validSignature } from '../lib/core.mjs';
const STOP = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|arret|arrêt|desabonner|désabonner)\s*[.!]*\s*$/i;
const xml = (s = '') => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${s}</Response>`, { headers: { 'content-type': 'text/xml' } });

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const form = await req.formData(), params = {};
  for (const [k, v] of form.entries()) params[k] = String(v);
  const token = process.env.TWILIO_AUTH_TOKEN || '';
  const url = process.env.TWILIO_WEBHOOK_URL || `${siteUrl()}/api/sms-inbound`;
  if (!token || !validSignature(url, params, req.headers.get('x-twilio-signature'), token)) return new Response('Forbidden', { status: 403 });
  const key = String(params.From || '').replace(/\D/g, '').slice(-10);
  if (key.length < 10) return xml();
  const stop = STOP.test(params.Body || '');
  const db = sb();
  const day = new Date().toISOString().slice(0, 10);
  for (const userId of await db.findSent(key)) {
    await applyInbound(db, userId, (c) => String(c.tel || '').replace(/\D/g, '').slice(-10) === key,
      stop ? { optout: true, optoutSource: 'stop', optoutAt: day } : { replied: true });
  }
  return xml(); // Twilio envoie lui-même la confirmation de désabonnement pour STOP
};
export const config = { path: '/api/sms-inbound' };
