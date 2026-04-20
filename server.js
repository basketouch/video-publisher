require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const axios = require('axios');
const FormData = require('form-data');
const bodyParser = require('body-parser');
const cookieSession = require('cookie-session');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'info@basketouch.com';
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const VIEWER_USERNAME = (process.env.VIEWER_USERNAME || '').trim().toLowerCase();
const VIEWER_PASSWORD = process.env.VIEWER_PASSWORD || '';
const WEB_PUBLISH_ENABLED = process.env.WEB_PUBLISH_ENABLED === 'true';

const app = express();
const PORT = process.env.PORT || 3000;

// Validar variables de entorno mínimas
const required = ['SESSION_SECRET'];
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

// Service Account para Drive (cuenta empresa)
// Origen: 1) Env vars, 2) Supabase (evita problemas con Vercel)
function parseServiceAccountFromEnv() {
  const base64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  let jsonStr;
  if (base64) {
    try { jsonStr = Buffer.from(base64, 'base64').toString('utf8'); } catch (e) { return null; }
  } else if (raw) {
    jsonStr = raw;
  } else {
    return null;
  }
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('Error parseando Service Account JSON:', e.message);
    return null;
  }
}
let _saCreds = parseServiceAccountFromEnv();
let USE_SA_DRIVE = !!_saCreds;

async function ensureServiceAccountCreds() {
  if (_saCreds) return _saCreds;
  return null;
}

function getDriveServiceAccountClient() {
  if (!_saCreds) return null;
  try {
    return new google.auth.GoogleAuth({
      credentials: _saCreds,
      scopes: ['https://www.googleapis.com/auth/drive.readonly']
    });
  } catch (e) {
    console.error('Error creando Service Account client:', e.message);
    return null;
  }
}

// --- Postiz (opcional): subida + /posts con integration ids del panel Postiz ---
function parsePostizIntegrationMap() {
  const raw = process.env.POSTIZ_INTEGRATION_MAP;
  if (!raw || !String(raw).trim()) return {};
  try {
    const o = JSON.parse(raw);
    return typeof o === 'object' && o !== null ? o : {};
  } catch {
    return {};
  }
}

function postizBaseUrl() {
  return (process.env.POSTIZ_API_BASE || 'https://api.postiz.com/public/v1').replace(/\/$/, '');
}

function getPostizIntegrationId(platform, map) {
  const keys = platform === 'instagram_reel' ? ['instagram_reel', 'instagram'] : [platform];
  for (const k of keys) {
    const v = map[k];
    if (v && typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function resolvePublishRoute(platform, map) {
  if (getPostizIntegrationId(platform, map)) return 'postiz';
  if (platform === 'youtube') return 'youtube';
  return null;
}

function youtubePrivacyForPostiz() {
  const p = (process.env.YOUTUBE_PRIVACY || 'private').toLowerCase();
  if (p === 'public') return 'public';
  if (p === 'unlisted') return 'unlisted';
  return 'private';
}

function buildPostizPostItem(platform, integrationId, title, description, media, options) {
  const safeTitle = (title || 'Video').trim();
  const ytTitle =
    safeTitle.length >= 2 ? safeTitle.slice(0, 100) : `${safeTitle}..`.slice(0, 100);
  const textBody = [title, description].filter(Boolean).join('\n\n') || safeTitle;
  const valueWithVideo = [
    {
      content: (description || title || ' ').slice(0, 50000),
      image: [{ id: media.id, path: media.path }]
    }
  ];

  switch (platform) {
    case 'youtube':
      return {
        integration: { id: integrationId },
        value: [
          {
            content: description || '',
            image: [{ id: media.id, path: media.path }]
          }
        ],
        settings: {
          __type: 'youtube',
          title: ytTitle,
          type: youtubePrivacyForPostiz(),
          selfDeclaredMadeForKids: 'no'
        }
      };
    case 'linkedin':
      return {
        integration: { id: integrationId },
        value: valueWithVideo,
        settings: { __type: 'linkedin' }
      };
    case 'x':
      return {
        integration: { id: integrationId },
        value: valueWithVideo,
        settings: { __type: 'x', who_can_reply_post: 'everyone' }
      };
    case 'threads':
      return {
        integration: { id: integrationId },
        value: valueWithVideo,
        settings: { __type: 'threads' }
      };
    case 'tiktok':
      return {
        integration: { id: integrationId },
        value: valueWithVideo,
        settings: {
          __type: 'tiktok',
          privacy_level: process.env.POSTIZ_TIKTOK_PRIVACY || 'PUBLIC_TO_EVERYONE',
          duet: true,
          stitch: true,
          comment: true,
          autoAddMusic: 'no',
          brand_content_toggle: false,
          brand_organic_toggle: false,
          video_made_with_ai: false,
          content_posting_method: 'DIRECT_POST'
        }
      };
    case 'instagram':
    case 'instagram_reel':
      return {
        integration: { id: integrationId },
        value: valueWithVideo,
        settings: {
          __type: 'instagram',
          post_type: 'post',
          is_trial_reel: false,
          collaborators: []
        }
      };
    case 'skool': {
      const sk = options?.skool || options?.postiz?.skool || {};
      if (!sk.group || !sk.label) {
        throw new Error('Skool: options.skool.group y options.skool.label son obligatorios');
      }
      return {
        integration: { id: integrationId },
        value: [
          {
            content: textBody,
            image: [{ id: media.id, path: media.path }]
          }
        ],
        settings: {
          __type: 'skool',
          group: sk.group,
          label: sk.label,
          title: (sk.title || title || 'Post').slice(0, 200)
        }
      };
    }
    default:
      throw new Error(`Postiz: plataforma no soportada: ${platform}`);
  }
}

async function streamDriveFileToTemp(drive, fileId, driveFileName) {
  const streamRes = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );
  const base =
    (driveFileName || 'video').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'video';
  const tmp = path.join(os.tmpdir(), `vp-${Date.now()}-${base}`);
  const ws = fs.createWriteStream(tmp);
  await new Promise((resolve, reject) => {
    streamRes.data.pipe(ws);
    streamRes.data.on('error', reject);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
  return tmp;
}

async function uploadMediaToPostiz(tmpPath, mimeType, filename) {
  const apiKey = process.env.POSTIZ_API_KEY;
  if (!apiKey) throw new Error('POSTIZ_API_KEY no configurada');
  const form = new FormData();
  form.append('file', fs.createReadStream(tmpPath), {
    filename: filename || 'video.mp4',
    contentType: mimeType || 'video/mp4'
  });
  const { data } = await axios.post(`${postizBaseUrl()}/upload`, form, {
    headers: { ...form.getHeaders(), Authorization: apiKey },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 0
  });
  if (!data?.path || !data?.id) throw new Error('Postiz upload: respuesta inválida');
  return data;
}

async function postizCreatePost(body) {
  const apiKey = process.env.POSTIZ_API_KEY;
  if (!apiKey) throw new Error('POSTIZ_API_KEY no configurada');
  const { data } = await axios.post(`${postizBaseUrl()}/posts`, body, {
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    timeout: 0
  });
  return data;
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

function getSessionRole(req) {
  if (req.session?.userRole) return req.session.userRole;
  if (req.session?.adminLoggedIn) return 'admin';
  return null;
}

function isAuthenticated(req) {
  return !!getSessionRole(req);
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Inicia sesión' });
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  const role = getSessionRole(req);
  if (role === 'admin') return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Acceso restringido a administradores' });
  return res.redirect('/login');
}

function requirePublishEnabled(req, res, next) {
  if (WEB_PUBLISH_ENABLED) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(410).json({ error: 'Publicación web desactivada en este entorno' });
  }
  return res.redirect('/sala');
}

// --- Rutas públicas (no requieren login admin) ---

// Estado de acceso para login y redirección
app.get('/api/auth/status', async (req, res) => {
  const role = getSessionRole(req);
  res.json({
    authenticated: !!role,
    role,
    needsSetup: false,
    viewerEnabled: !!(VIEWER_USERNAME && VIEWER_PASSWORD),
    adminEnabled: !!(ADMIN_USERNAME && ADMIN_PASSWORD)
  });
});

// Primera vez: crear contraseña (el usuario viene de ADMIN_EMAIL en env)
app.post('/api/admin/setup', async (req, res) => {
  res.status(410).json({ error: 'Setup por web desactivado. Configura ADMIN_USERNAME y ADMIN_PASSWORD en variables de entorno.' });
});

// Login único para admin/viewer
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Credenciales incorrectas' });
  }
  const normalizedUsername = username.trim().toLowerCase();

  if (VIEWER_USERNAME && VIEWER_PASSWORD && normalizedUsername === VIEWER_USERNAME) {
    if (password !== VIEWER_PASSWORD) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
    req.session.userRole = 'viewer';
    req.session.userEmail = VIEWER_USERNAME;
    req.session.adminLoggedIn = false;
    req.session.tokens = null;
    return res.json({ success: true, role: 'viewer' });
  }

  if (ADMIN_USERNAME && ADMIN_PASSWORD && normalizedUsername === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.userRole = 'admin';
    req.session.userEmail = normalizedUsername;
    req.session.adminLoggedIn = true;
    return res.json({ success: true, role: 'admin' });
  }

  return res.status(401).json({ error: 'Credenciales incorrectas' });
});

app.post('/api/auth/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

// Compatibilidad temporal con llamadas antiguas
app.get('/api/admin/status', async (req, res) => {
  res.json({ needsSetup: false, loggedIn: getSessionRole(req) === 'admin' });
});
app.post('/api/admin/login', async (req, res) => {
  const email = (req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password || '';
  if (!email || !password) {
    return res.status(400).json({ error: 'Credenciales incorrectas' });
  }
  if (ADMIN_USERNAME && ADMIN_PASSWORD && email === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.userRole = 'admin';
    req.session.userEmail = email;
    req.session.adminLoggedIn = true;
    return res.json({ success: true, role: 'admin' });
  }
  return res.status(401).json({ error: 'Credenciales incorrectas' });
});
app.post('/api/admin/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

// --- Rutas protegidas ---

// Scopes: con SA para Drive → solo YouTube; sin SA → Drive + YouTube
const OAUTH_SCOPES_DRIVE_AND_YOUTUBE = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube'
];
const OAUTH_SCOPES_YOUTUBE_ONLY = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube'
];

// Redirige a Google: solo YouTube si usamos SA para Drive; Drive+YouTube si no
app.get('/auth', requireAdmin, requirePublishEnabled, async (req, res) => {
  await ensureServiceAccountCreds();
  const redirectUri = getRedirectUri(req);
  const oauth2Client = getOAuth2Client(redirectUri);
  const scopes = USE_SA_DRIVE ? OAUTH_SCOPES_YOUTUBE_ONLY : OAUTH_SCOPES_DRIVE_AND_YOUTUBE;
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'select_account consent'  // select_account: elegir cuenta personal para YouTube
  });
  res.redirect(authUrl);
});

// Recibe el code de Google, guarda tokens en sesión y en Supabase (para process_publish)
app.get('/api/auth/callback', requireAdmin, requirePublishEnabled, async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.redirect('/?error=no_code');
  }
  try {
    const redirectUri = getRedirectUri(req);
    const oauth2Client = getOAuth2Client(redirectUri);
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens;
    // Guardar en Supabase para que n8n/process_publish pueda usarlos (un solo admin)
    await getSupabase()
      .from('drive_tokens')
      .upsert(
        { email: ADMIN_EMAIL.trim().toLowerCase(), tokens, updated_at: new Date().toISOString() },
        { onConflict: 'email' }
      );
    res.redirect('/');
  } catch (err) {
    console.error('Error en auth/callback:', err);
    res.redirect('/?error=auth_failed');
  }
});

// Cerrar sesión
app.get('/auth/logout', requireAdmin, requirePublishEnabled, (req, res) => {
  req.session = null;
  res.redirect('/');
});

// Config para el frontend (carpeta por defecto)
const DEFAULT_FOLDER = process.env.DEFAULT_DRIVE_FOLDER_ID || '1y6rIQTNtqeRaq-z8Vw8kaWFvy_2moRtD';
const PRIVATE_VIEWER_FOLDER = process.env.PRIVATE_VIEWER_DRIVE_FOLDER_ID || DEFAULT_FOLDER;
app.get('/api/config', requireAdmin, requirePublishEnabled, async (req, res) => {
  await ensureServiceAccountCreds();
  res.json({
    defaultFolderId: DEFAULT_FOLDER,
    useServiceAccountDrive: USE_SA_DRIVE
  });
});

// Estado de conexión OAuth de Google (solo admin)
app.get('/api/google/status', requireAdmin, requirePublishEnabled, (req, res) => {
  res.json({ connected: !!req.session?.tokens });
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
// Con USE_SA_DRIVE: usa Service Account (no requiere sesión OAuth)
// Sin USE_SA_DRIVE: usa OAuth del usuario
app.get('/api/drive/files', requireAdmin, requirePublishEnabled, async (req, res) => {
  await ensureServiceAccountCreds();
  let auth = null;
  if (USE_SA_DRIVE) {
    auth = getDriveServiceAccountClient();
    if (!auth) return res.status(503).json({ error: 'Service Account no configurado. Añade credenciales en Supabase (service_account_creds) o en GOOGLE_SERVICE_ACCOUNT_JSON.' });
  } else {
    auth = await getDriveClient(req);
    if (!auth) return res.status(401).json({ error: 'Conecta Google Drive para continuar' });
  }
  try {
    const defaultFolder = process.env.DEFAULT_DRIVE_FOLDER_ID || DEFAULT_FOLDER;
    const parentId = req.query.folder || defaultFolder;
    const isShared = parentId === 'shared';
    const drive = google.drive({ version: 'v3', auth });

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

// Sala privada: listado de videos en carpeta fija (solo lectura)
app.get('/api/private/videos', requireAuth, async (req, res) => {
  await ensureServiceAccountCreds();
  const auth = getDriveServiceAccountClient();
  if (!auth) {
    return res.status(503).json({ error: 'Service Account no configurado para sala privada' });
  }
  try {
    const drive = google.drive({ version: 'v3', auth });
    const { data } = await drive.files.list({
      q: `'${PRIVATE_VIEWER_FOLDER}' in parents and mimeType contains 'video/' and trashed = false`,
      fields: 'files(id, name, mimeType, size, modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    const videos = (data.files || []).map((f) => ({
      id: f.id,
      title: f.name,
      mimeType: f.mimeType,
      size: f.size,
      modifiedTime: f.modifiedTime
    }));
    res.json({ videos });
  } catch (err) {
    console.error('Error listando videos privados:', err);
    res.status(500).json({ error: 'No se pudieron cargar los videos privados' });
  }
});

// Sala privada: streaming sin exponer enlaces de Drive
app.get('/api/private/videos/:id/stream', requireAuth, async (req, res) => {
  await ensureServiceAccountCreds();
  const auth = getDriveServiceAccountClient();
  if (!auth) {
    return res.status(503).json({ error: 'Service Account no configurado para sala privada' });
  }
  try {
    const drive = google.drive({ version: 'v3', auth });
    const fileId = req.params.id;
    const meta = await drive.files.get({
      fileId,
      fields: 'id,name,mimeType,size',
      supportsAllDrives: true
    });
    const mimeType = meta.data.mimeType || 'video/mp4';
    const totalSize = Number(meta.data.size || 0);
    const range = req.headers.range;

    if (range && totalSize > 0) {
      const [startPart, endPart] = range.replace(/bytes=/, '').split('-');
      const start = Number(startPart || 0);
      const end = endPart ? Number(endPart) : Math.min(start + 1024 * 1024 - 1, totalSize - 1);
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= totalSize) {
        return res.status(416).send('Range no válido');
      }
      const chunkSize = end - start + 1;
      const streamResp = await drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        {
          responseType: 'stream',
          headers: { Range: `bytes=${start}-${end}` }
        }
      );
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
        'Cache-Control': 'private, max-age=60'
      });
      streamResp.data.pipe(res);
      return;
    }

    const fullResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );
    res.setHeader('Content-Type', mimeType);
    if (totalSize > 0) res.setHeader('Content-Length', String(totalSize));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=60');
    fullResp.data.pipe(res);
  } catch (err) {
    console.error('Error streaming video privado:', err);
    res.status(500).json({ error: 'No se pudo reproducir el video' });
  }
});

// Inserta fila en publish_queue de Supabase
// Con USE_SA_DRIVE: solo se necesita YouTube (tokens); sin SA: Drive+YouTube
app.post('/api/queue', requireAdmin, requirePublishEnabled, async (req, res) => {
  await ensureServiceAccountCreds();
  const hasTokens = !!req.session?.tokens;
  const { title, description, drive_file_id, drive_file_name, platforms, scheduled_at, options } = req.body;
  if (!title || !drive_file_id || !drive_file_name) {
    return res.status(400).json({ error: 'Faltan campos obligatorios: title, drive_file_id, drive_file_name' });
  }
  const platformArr = Array.isArray(platforms) ? platforms : platforms ? [platforms] : [];
  const postizMapQ = parsePostizIntegrationMap();
  const unresolvedQ = platformArr.filter((p) => !resolvePublishRoute(p, postizMapQ));
  if (unresolvedQ.length) {
    return res.status(400).json({
      error:
        'Plataforma no soportada o falta ID en POSTIZ_INTEGRATION_MAP: ' +
        unresolvedQ.join(', ')
    });
  }
  const needsYouTubeOAuth =
    platformArr.includes('youtube') && !getPostizIntegrationId('youtube', postizMapQ);
  if (!hasTokens) {
    if (!USE_SA_DRIVE) {
      return res.status(401).json({ error: 'Conecta Google Drive primero.' });
    }
    if (needsYouTubeOAuth) {
      return res.status(401).json({ error: 'Conecta YouTube para continuar.' });
    }
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

// Obtiene OAuth client con tokens de drive_tokens (para process_publish sin sesión)
async function getStoredOAuthClient() {
  const { data } = await getSupabase()
    .from('drive_tokens')
    .select('tokens')
    .eq('email', ADMIN_EMAIL.trim().toLowerCase())
    .maybeSingle();
  if (!data?.tokens) return null;
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(data.tokens);
  oauth2Client.on('tokens', async (tokens) => {
    await getSupabase()
      .from('drive_tokens')
      .update({ tokens: { ...data.tokens, ...tokens }, updated_at: new Date().toISOString() })
      .eq('email', ADMIN_EMAIL.trim().toLowerCase());
  });
  return oauth2Client;
}

// Endpoint que n8n llama para procesar cada fila pendiente de publish_queue
app.post('/api/process_publish', requirePublishEnabled, async (req, res) => {
  const {
    id,
    drive_file_id,
    drive_file_name,
    title,
    description,
    platforms,
    scheduled_at,
    options
  } = req.body;
  if (!id || !drive_file_id) {
    return res.status(400).json({ success: false, error: 'Faltan id o drive_file_id' });
  }
  const rawList = Array.isArray(platforms) ? platforms : platforms ? [platforms] : [];
  const platformList = [...new Set(rawList)];
  if (!platformList.length) {
    return res.status(400).json({ success: false, error: 'No hay plataformas en la petición' });
  }

  const postizMap = parsePostizIntegrationMap();
  const unresolved = platformList.filter((p) => !resolvePublishRoute(p, postizMap));
  if (unresolved.length) {
    return res.json({
      success: false,
      error: 'Plataforma no soportada o falta ID en POSTIZ_INTEGRATION_MAP: ' + unresolved.join(', ')
    });
  }

  const postizPlatforms = platformList.filter((p) => getPostizIntegrationId(p, postizMap));
  const needDirectYouTube =
    platformList.includes('youtube') && !getPostizIntegrationId('youtube', postizMap);
  const usePostiz = postizPlatforms.length > 0;
  if (usePostiz && !process.env.POSTIZ_API_KEY) {
    return res.json({
      success: false,
      error: 'Hay plataformas que usan Postiz pero falta POSTIZ_API_KEY'
    });
  }

  const oauth2Client = await getStoredOAuthClient();
  if (!USE_SA_DRIVE) {
    if (!oauth2Client) {
      return res.json({
        success: false,
        error: 'No hay tokens de Google guardados. Conecta Drive en la web.'
      });
    }
  } else if (needDirectYouTube && !oauth2Client) {
    return res.json({
      success: false,
      error:
        'No hay tokens de YouTube guardados. Conecta YouTube en la web para publicación directa en YouTube.'
    });
  }

  await ensureServiceAccountCreds();
  const driveAuth = USE_SA_DRIVE ? getDriveServiceAccountClient() : oauth2Client;
  if (!driveAuth) {
    return res.json({ success: false, error: 'Service Account no configurado para Drive.' });
  }
  const drive = google.drive({ version: 'v3', auth: driveAuth });

  const published_urls = {};
  let tempPath = null;

  try {
    const { data: fileMeta } = await drive.files.get({
      fileId: drive_file_id,
      fields: 'size, mimeType',
      supportsAllDrives: true
    });
    const mimeType = fileMeta.mimeType || 'video/mp4';
    const sizeNum = fileMeta.size ? parseInt(fileMeta.size, 10) : undefined;

    const onlyDirectYt = needDirectYouTube && !usePostiz;
    if (!onlyDirectYt) {
      tempPath = await streamDriveFileToTemp(drive, drive_file_id, drive_file_name);
    }

    if (usePostiz) {
      const media = await uploadMediaToPostiz(tempPath, mimeType, drive_file_name || 'video.mp4');
      const opts = typeof options === 'object' && options !== null ? options : {};
      const posts = postizPlatforms.map((p) =>
        buildPostizPostItem(
          p,
          getPostizIntegrationId(p, postizMap),
          title || drive_file_name,
          description || '',
          media,
          opts
        )
      );
      const hasSchedule = scheduled_at && String(scheduled_at).trim();
      const scheduleDate = hasSchedule
        ? new Date(scheduled_at).toISOString()
        : new Date().toISOString();
      const postBody = {
        type: hasSchedule ? 'schedule' : 'now',
        date: scheduleDate,
        shortLink: false,
        tags: [],
        posts
      };
      const postizResult = await postizCreatePost(postBody);
      published_urls.postiz = postizResult;
    }

    if (needDirectYouTube) {
      const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
      const fileStream = onlyDirectYt
        ? (
            await drive.files.get(
              { fileId: drive_file_id, alt: 'media', supportsAllDrives: true },
              { responseType: 'stream' }
            )
          ).data
        : fs.createReadStream(tempPath);
      const { data: youtubeVideo } = await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: {
          snippet: {
            title: title || drive_file_name,
            description: description || ''
          },
          status: {
            privacyStatus: process.env.YOUTUBE_PRIVACY || 'private'
          }
        },
        media: {
          body: fileStream,
          mimeType,
          ...(sizeNum && { contentLength: sizeNum })
        }
      });
      published_urls.youtube = `https://www.youtube.com/watch?v=${youtubeVideo.id}`;
    }

    res.json({ success: true, published_urls });
  } catch (err) {
    console.error('Error en process_publish:', err);
    const ax = err.response?.data;
    res.status(500).json({
      success: false,
      error: err.message || 'Error al publicar',
      details:
        typeof ax === 'string'
          ? ax
          : ax?.message || ax?.error || err.response?.data?.error?.message
    });
  } finally {
    if (tempPath) await fsp.unlink(tempPath).catch(() => {});
  }
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/admin', requireAdmin, requirePublishEnabled, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/sala', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sala.html'));
});

app.get('/', (req, res) => {
  const role = getSessionRole(req);
  if (role === 'admin') return res.redirect('/admin');
  if (role === 'viewer') return res.redirect('/sala');
  return res.redirect('/login');
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
