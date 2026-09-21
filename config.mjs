// Sert /config.js : URL et clé publique (anon) de Supabase, lues dans les variables d'environnement Netlify.
// La clé anon est publique par conception (la sécurité vient des règles RLS de la base). Ne JAMAIS y mettre la clé service.
export default async () => {
  const url = process.env.SUPABASE_URL || '', key = process.env.SUPABASE_ANON_KEY || '';
  const body = url && key ? `window.D4U_CONFIG=${JSON.stringify({ supabaseUrl: url, supabaseAnonKey: key })};` : 'window.D4U_CONFIG=null;';
  return new Response(body, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' } });
};
export const config = { path: '/config.js' };
