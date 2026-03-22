# Video Publisher POC

Webapp ligera para conectar Google Drive, listar vídeos, seleccionar uno, rellenar metadatos y crear filas en la tabla `publish_queue` de Supabase. n8n tomará esas filas para publicar.

## Requisitos previos

- Node.js 18+
- Cuenta Google Cloud con OAuth configurado
- Proyecto Supabase

## Tablas Supabase

Ejecuta en el SQL Editor de Supabase:

**1. Tabla publish_queue**
```sql
create table publish_queue (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  description text default '',
  drive_file_id text not null,
  drive_file_name text not null,
  platforms text[] default '{}',
  scheduled_at timestamptz,
  options jsonb default '{}',
  status text default 'pending',
  created_at timestamptz default now()
);

-- Si usas la clave anon en lugar de service_role, permite inserts:
-- create policy "Allow service inserts" on publish_queue for insert with check (true);
```

**2. Tabla app_admin (login)** – Ejecuta el contenido de `supabase-app-admin.sql`
Usuario: configurable con `ADMIN_EMAIL` en variables de entorno. La contraseña se configura la primera vez. El usuario no se muestra en pantalla (por seguridad).

## Configuración

1. Copia `.env.example` a `.env`
2. Rellena las variables de entorno en Cursor o en `.env` (nunca subas `.env` a git)

### Variables necesarias

| Variable | Descripción |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | Client ID de OAuth en Google Cloud |
| `GOOGLE_CLIENT_SECRET` | Client secret de OAuth |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3000/api/auth/callback` (o `https://video.basketouch.com/api/auth/callback` en prod) |
| `SUPABASE_URL` | URL del proyecto Supabase |
| `SUPABASE_SERVICE_KEY` | Service role key (solo backend) |
| `SESSION_SECRET` | Secreto para cookies de sesión |

### Google Cloud Console

1. Crea un proyecto o usa uno existente
2. API y servicios → Credenciales → Crear credenciales → ID de cliente OAuth
3. Tipo: Aplicación web
4. URIs de redirección autorizados: `http://localhost:3000/api/auth/callback` y `https://video.basketouch.com/api/auth/callback` (producción)
5. Scope usado: `https://www.googleapis.com/auth/drive.readonly`

## Uso

```bash
npm install
npm start
```

Abre http://localhost:3000:

1. **Conectar Google Drive** → autoriza la app
2. Ver la lista de vídeos
3. **Seleccionar** uno → completar título, descripción, plataformas, fecha
4. Se crea una fila en `publish_queue` con `status=pending`

n8n puede hacer polling o usar webhooks sobre esa tabla para publicar en LinkedIn/YouTube.

## Despliegue en Vercel

1. **Sube el proyecto a GitHub**
   ```bash
   git init
   git add .
   git commit -m "Video Publisher"
   git remote add origin https://github.com/TU_USUARIO/video-publisher.git
   git push -u origin main
   ```

2. **Conecta con Vercel**
   - Ve a [vercel.com](https://vercel.com) e importa el repo de GitHub
   - Añade las variables de entorno en Vercel → Project → Settings → Environment Variables:
     - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
     - `GOOGLE_REDIRECT_URI` = `https://video.basketouch.com/api/auth/callback`
     - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
     - `SESSION_SECRET` (genera uno seguro, ej: `openssl rand -hex 32`)
     - `DEFAULT_DRIVE_FOLDER_ID` (opcional)
   - Despliega

3. **Google Cloud Console**
   - Añade en "URIs de redirección autorizados": `https://video.basketouch.com/api/auth/callback`

4. **n8n**
   - Importa `publish_queue_n8n_workflow_fixed.json` o `publish_queue_n8n_workflow_legacy.json`
   - Configura la variable de entorno `SUPABASE_SERVICE_KEY` en n8n (Settings → Variables)
   - URLs ya configuradas:
     - Supabase: `https://piavkbvjdjxxsvgzofao.supabase.co`
     - Backend: `https://video.basketouch.com/api/process_publish`
   - El workflow corre cada 5 min, procesa filas `pending` y llama al backend
