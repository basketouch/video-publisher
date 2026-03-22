-- Ejecuta este script en Supabase: SQL Editor → New query → pegar → Run
-- Esto permite que tu app inserte filas en publish_queue

-- Política para INSERT (tu app añade vídeos a la cola)
drop policy if exists "Allow inserts on publish_queue" on publish_queue;
create policy "Allow inserts on publish_queue" 
  on publish_queue for insert 
  with check (true);

-- Política para SELECT (n8n puede leer las filas)
drop policy if exists "Allow select on publish_queue" on publish_queue;
create policy "Allow select on publish_queue" 
  on publish_queue for select 
  using (true);
