-- Ejecutar en Supabase SQL Editor para habilitar login de administrador
create table if not exists app_admin (
  id uuid default gen_random_uuid() primary key,
  email text unique not null,
  password_hash text not null,
  created_at timestamptz default now()
);

-- RLS: solo service_role puede acceder (la app backend usa service_role y omite RLS)
alter table app_admin enable row level security;
