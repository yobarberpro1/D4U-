# D4U Private Barber — kit de déploiement (Netlify + Supabase)

Ce que ça ajoute à l'app : comptes barbiers, données sauvegardées dans Supabase, et un planificateur Netlify
qui envoie les relances **même quand l'app est fermée**, enregistre les STOP / réponses et arrête les séquences.
Sans clés Twilio/Resend, tout reste en **simulation** (et l'app l'affiche).

## 1. Supabase (10 min)
1. Nouveau projet, région **européenne** (Frankfurt ou Paris) si tu veux héberger les données en Europe.
2. SQL Editor > New query > coller `supabase/schema.sql` > Run.
3. Authentication > Providers > Email : pour tes premiers tests, désactive « Confirm email » (sinon chaque barbier doit cliquer un lien reçu par email).
4. Project Settings > API : copie **Project URL**, **anon key** et **service_role key**.

## 2. Netlify (10 min)
1. Déploie ce dossier tel quel (Git recommandé : Add new site > Import from Git ; ou `npx netlify-cli deploy --prod`).
   Les fonctions planifiées ne tournent que sur un déploiement de production publié.
2. Site configuration > Environment variables : renseigne toutes les variables de `.env.example`
   (au minimum `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SITE_URL`, `UNSUB_SECRET`).
3. Redéploie après avoir ajouté les variables.
4. Vérifie : `https://ton-site.netlify.app/api/status` répond `{"sms":false,"email":false,...}` ; l'app affiche « Connexion » au clic sur « Récupérer mes clients ».

## 3. Envoi réel (quand tu es prêt)
**SMS (Twilio)** : crée un Messaging Service avec un numéro d'envoi, renseigne `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_MESSAGING_SERVICE_SID`. Dans Twilio, règle le webhook « A message comes in » sur
`https://ton-site.netlify.app/api/sms-inbound` (HTTP POST) : c'est ce qui enregistre les STOP et les réponses.
**Email (Resend)** : vérifie ton domaine, renseigne `RESEND_API_KEY` et `EMAIL_FROM`.
Dès que les clés sont là, `/api/status` passe à `true` et l'app affiche « Envoi réel » pour ce canal.
Les clients d'exemple ne reçoivent JAMAIS de message réel (protection intégrée).

## Comment ça marche
- **Toutes les heures** (`engine.mjs`), pour chaque barbier avec relances ON + accord des clients coché : le serveur exécute
  le **même moteur que l'app** (`netlify/lib/engine-src.mjs`, généré depuis l'app), pendant les heures d'envoi (10 h – 19 h, fuseau du barbier),
  au plus 40 messages par passage. Il écrit son travail dans `server_state` ; l'app le fusionne à l'ouverture et toutes les minutes.
- **Règle anti-conflit** : chaque client a une horloge `stAt` ; entre l'app et le serveur, l'action la plus récente gagne
  (ex. « RDV repris » marqué dans l'app n'est pas écrasé par un vieil envoi).
- **STOP / réponse SMS** → `/api/sms-inbound` (signature Twilio vérifiée). **Lien de désabonnement email** → `/api/unsubscribe` (lien signé, one-click).
- Un envoi qui échoue n'est jamais marqué « envoyé » ; numéro invalide = pas de réessai ; destinataire déjà désabonné chez Twilio (21610) = client désabonné.

## À valider avant de vendre (je ne peux pas le faire à ta place)
- **Consentement et conformité** : la case « mes clients m'ont donné leur accord » engage le barbier. Fais valider les règles applicables
  (CASL au Canada, RGPD / règles SMS et emails commerciaux en France) et les mentions d'identification de l'expéditeur.
- **Twilio** : les règles d'enregistrement des numéros d'envoi (Canada, États-Unis, Europe) changent selon le pays et le type de numéro.
- **Région des données** : Supabase en Europe fixe où sont stockées les données ; vérifie aussi la région d'exécution des fonctions Netlify
  et les régions de Twilio et Resend si tu dois tout garder en Europe.
- **Test réel** : envoie d'abord à ton propre numéro et à ton propre email avec un faux client.

## Limites connues du MVP
Pas de paiement (Stripe) ni de facturation des SMS ; un fuseau horaire par défaut (champ `profile.tz` prévu, pas encore dans l'interface) ;
plusieurs appareils : la dernière sauvegarde gagne ; le planificateur lit les barbiers un par un (largement suffisant pour quelques dizaines de barbiers).

## Tests
`npm test` (Node ≥ 18) : 41 vérifications contre un faux Supabase / Twilio / Resend (envois, STOP, désabonnement, plafonds, échecs, simulation, concurrence).
