// Appelé par l'app quand le barbier active les relances : traite son compte tout de suite (dans les heures d'envoi).
import { sb, processBarber } from '../lib/core.mjs';
export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return Response.json({ error: 'Non connecté' }, { status: 401 });
  const db = sb();
  const user = await db.userFromToken(token);
  if (!user) return Response.json({ error: 'Session invalide' }, { status: 401 });
  try { return Response.json(await processBarber(db, user.id, { budgetMs: 20000 })); }
  catch (e) { return Response.json({ error: String(e.message).slice(0, 200) }, { status: 500 }); }
};
export const config = { path: '/api/run-now' };
