-- D4U Private Barber — schéma Supabase
-- À exécuter une seule fois : Supabase > SQL Editor > New query > coller > Run.
-- Créer le projet dans une région européenne (ex. Frankfurt ou Paris) pour héberger les données en Europe.

-- Un barbier = une ligne. « state » : ses réglages, clients, messages (écrit par l'app).
-- « server_state » : ce que le serveur a fait (envois, STOP, réponses) — écrit UNIQUEMENT par le serveur.
create table if not exists public.barbers (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  state        jsonb not null default '{}'::jsonb,
  server_state jsonb not null default '{"patches":{},"messages":[]}'::jsonb,
  seq          integer not null default 0,
  updated_at   timestamptz not null default now()
);

alter table public.barbers enable row level security;

drop policy if exists "barbers_select_own" on public.barbers;
drop policy if exists "barbers_insert_own" on public.barbers;
drop policy if exists "barbers_update_own" on public.barbers;
create policy "barbers_select_own" on public.barbers for select to authenticated using (auth.uid() = user_id);
create policy "barbers_insert_own" on public.barbers for insert to authenticated with check (auth.uid() = user_id);
create policy "barbers_update_own" on public.barbers for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- L'app (rôle « authenticated ») ne peut écrire que « state » : jamais server_state ni seq.
revoke all on public.barbers from anon, authenticated;
grant select on public.barbers to authenticated;
grant insert (user_id, state) on public.barbers to authenticated;
grant update (state, updated_at) on public.barbers to authenticated;

-- Journal des numéros contactés : sert à retrouver le barbier quand un client répond STOP.
-- Aucune règle d'accès : réservé au serveur (clé service).
create table if not exists public.sent_log (
  user_id   uuid not null references auth.users(id) on delete cascade,
  phone_key text not null,
  at        timestamptz not null default now(),
  primary key (user_id, phone_key)
);
create index if not exists sent_log_phone_idx on public.sent_log (phone_key);
alter table public.sent_log enable row level security;
revoke all on public.sent_log from anon, authenticated;
