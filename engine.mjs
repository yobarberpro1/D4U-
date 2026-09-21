// Planificateur : toutes les heures, traite les barbiers dont les relances automatiques sont activées.
// Les envois n'ont lieu que pendant les heures d'envoi (par défaut 10 h – 19 h, fuseau du barbier).
import { sb, processBarber } from '../lib/core.mjs';
export default async () => {
  const db = sb(), t0 = Date.now(), out = [];
  const ids = await db.listAutoBarbers();
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; } // équité entre barbiers
  for (const id of ids) {
    if (Date.now() - t0 > 22000) { out.push({ userId: id, skipped: 'time' }); continue; }
    try { out.push(await processBarber(db, id, { budgetMs: Math.max(2000, 24000 - (Date.now() - t0)) })); }
    catch (e) { out.push({ userId: id, error: String(e.message).slice(0, 200) }); }
  }
  console.log(JSON.stringify({ barbers: ids.length, ms: Date.now() - t0, out }));
  return new Response('ok');
};
export const config = { schedule: '@hourly' };
