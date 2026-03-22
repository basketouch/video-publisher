-- Tokens OAuth de Google (Drive + YouTube) para que process_publish pueda usarlos
create table if not exists drive_tokens (
  id uuid default gen_random_uuid() primary key,
  email text unique not null,
  tokens jsonb not null,
  updated_at timestamptz default now()
);

alter table drive_tokens enable row level security;
