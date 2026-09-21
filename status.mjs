// Dit à l'app si l'envoi réel est branché (pour ne jamais afficher « envoyé » à tort).
import { providersReady, hours } from '../lib/core.mjs';
export default async () => {
  const p = providersReady(false), h = hours();
  return Response.json({ sms: p.sms, email: p.email, hours: `${h.start} h – ${h.end} h` }, { headers: { 'cache-control': 'no-store' } });
};
export const config = { path: '/api/status' };
