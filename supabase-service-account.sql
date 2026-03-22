-- Service Account JSON para Drive (cuenta empresa)
-- Evita depender de variables de entorno en Vercel
create table if not exists service_account_creds (
  id text primary key default 'default',
  json_data jsonb not null,
  updated_at timestamptz default now()
);

alter table service_account_creds enable row level security;

-- Para generar el INSERT con tu JSON local:
--   node -e "require('dotenv').config(); const j=process.env.GOOGLE_SERVICE_ACCOUNT_JSON; console.log(\"insert into service_account_creds (id, json_data) values ('default', '\"+j.replace(/'/g,\"''\")+\"'::jsonb) on conflict (id) do update set json_data = excluded.json_data, updated_at = now();\")"
-- Luego pega el resultado en Supabase SQL Editor y ejecuta.
