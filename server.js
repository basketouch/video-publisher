require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const cookieSession = require('cookie-session');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Validar variables de entorno (en Vercel no usamos process.exit para ver el error)
const required = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SESSION_SECRET'];
const missingVars = required.filter(k => !process.env[k]);
if (missingVars.length && require.main === module) {
  console.error('Faltan variables de entorno:', missingVars.join(', '));
  process.exit(1);
}

const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI
  || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/api/auth/callback` : `http://localhost:${PORT}/api/auth/callback`);

// Supabase client (solo backend) - solo si las vars existen para evitar crash al cargar
let supabase = null;
function getSupabase() {
  if (!supabase && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  }
  return supabase;
}

// OAuth2 client (redirectUri opcional: si no se pasa, usa env)
function getOAuth2Client(redirectUri) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri || GOOGLE_REDIRECT_URI
  );
}

// Obtiene redirect_uri desde la petición (evita mismatch con dominios custom)
function getRedirectUri(req) {
  const protocol = req.protocol || 'https';
  const host = req.get('host') || req.get('x-forwarded-host') || 'localhost:3000';
  return `${protocol}://${host}/api/auth/callback`;
}

// Trust proxy (necesario en Vercel para que secure cookies y X-Forwarded-* funcionen)
app.set('trust proxy', 1);

// Middleware
app.use(bodyParser.json());

// Si faltan vars de entorno (ej. en Vercel), responder con error claro en vez de crash
app.use((req, res, next) => {
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    return res.status(503).json({
      error: 'Configuración incompleta',
      message: `Faltan variables de entorno en Vercel: ${missing.join(', ')}. Añádelas en Project → Settings → Environment Variables.`
    });
  }
  next();
});
app.use(cookieSession({
  name: 'session',
  keys: [process.env.SESSION_SECRET],
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' // Necesario para OAuth redirect desde Google
}));

// --- Rutas ---

// Redirige a Google para autorizar Drive (solo cuando no hay sesión)
app.get('/auth', (req, res) => {
  const redirectUri = getRedirectUri(req);
  const oauth2Client = getOAuth2Client(redirectUri);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive.readonly'],
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

// Recibe el code de Google, guarda tokens en sesión
app.get('/api/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.redirect('/?error=no_code');
  }
  try {
    const redirectUri = getRedirectUri(req);
    const oauth2Client = getOAuth2Client(redirectUri);
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens;
    res.redirect('/');
  } catch (err) {
    console.error('Error en auth/callback:', err);
    res.redirect('/?error=auth_failed');
  }
});

// Cerrar sesión
app.get('/auth/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

// Config para el frontend (carpeta por defecto)
app.get('/api/config', (req, res) => {
  res.json({
    defaultFolderId: process.env.DEFAULT_DRIVE_FOLDER_ID || null
  });
});

// Refresca tokens si han caducado y devuelve oauth2Client listo
async function getDriveClient(req) {
  if (!req.session?.tokens) return null;
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(req.session.tokens);
  oauth2Client.on('tokens', (tokens) => {
    req.session.tokens = { ...req.session.tokens, ...tokens };
  });
  return oauth2Client;
}

// Lista carpetas y vídeos de Drive (con navegación por carpeta)
app.get('/api/drive/files', async (req, res) => {
  const oauth2Client = await getDriveClient(req);
  if (!oauth2Client) {
    return res.status(401).json({ error: 'Conecta Google Drive para continuar' });
  }
  try {
    const defaultFolder = process.env.DEFAULT_DRIVE_FOLDER_ID || 'root';
    const parentId = req.query.folder || defaultFolder;
    const isShared = parentId === 'shared';
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    let q;
    if (isShared) {
      q = "sharedWithMe = true and (mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'video/')";
    } else {
      q = `'${parentId}' in parents and (mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'video/')`;
    }

    const { data } = await drive.files.list({
      q,
      fields: 'files(id, name, mimeType, size, modifiedTime)',
      orderBy: isShared ? 'viewedByMeTime desc' : 'folder,name',
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });

    const files = (data.files || []).map(f => ({
      ...f,
      isFolder: f.mimeType === 'application/vnd.google-apps.folder'
    }));

    let folderInfo = null;
    if (parentId !== 'root' && !isShared) {
      try {
        const { data: folder } = await drive.files.get({
          fileId: parentId,
          fields: 'id, name, parents',
          supportsAllDrives: true
        });
        folderInfo = folder;
      } catch {
        folderInfo = { id: parentId, name: 'Carpeta', parents: [] };
      }
    }

    res.json({ files, folder: folderInfo });
  } catch (err) {
    console.error('Error listando Drive:', err);
    res.status(500).json({
      error: err.message || 'No se pudieron cargar los archivos'
    });
  }
});

// Inserta fila en publish_queue de Supabase
app.post('/api/queue', async (req, res) => {
  if (!req.session?.tokens) {
    return res.status(401).json({ error: 'No autorizado. Conecta Google Drive primero.' });
  }
  const { title, description, drive_file_id, drive_file_name, platforms, scheduled_at, options } = req.body;
  if (!title || !drive_file_id || !drive_file_name) {
    return res.status(400).json({ error: 'Faltan campos obligatorios: title, drive_file_id, drive_file_name' });
  }
  try {
    const { data, error } = await getSupabase()
      .from('publish_queue')
      .insert({
        title,
        description: description || '',
        drive_file_id,
        drive_file_name,
        platforms: Array.isArray(platforms) ? platforms : (platforms ? [platforms] : []),
        scheduled_at: scheduled_at || null,
        options: options || {},
        status: 'pending'
      })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error insertando en publish_queue:', err);
    res.status(500).json({
      error: err.message || 'Error al crear la fila',
      details: err.details
    });
  }
});

// Endpoint que n8n llama para procesar cada fila pendiente de publish_queue
// TODO: implementar descarga de Drive + subida a YouTube/LinkedIn (requiere tokens OAuth almacenados)
app.post('/api/process_publish', async (req, res) => {
  const { id, drive_file_id, drive_file_name, title, description, platforms } = req.body;
  if (!id || !drive_file_id) {
    return res.status(400).json({ success: false, error: 'Faltan id o drive_file_id' });
  }
  try {
    // Stub: aún no hay lógica de publicación (Drive requiere OAuth del usuario)
    res.json({
      success: false,
      error: 'process_publish no implementado. Falta lógica de descarga desde Drive y subida a plataformas.'
    });
  } catch (err) {
    console.error('Error en process_publish:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Servir index para SPA
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Archivos estáticos (después de las rutas API)
app.use(express.static(path.join(__dirname, 'public')));

// Export para Vercel; listen solo cuando se ejecuta directamente
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Video Publisher corriendo en http://localhost:${PORT}`);
  });
}
