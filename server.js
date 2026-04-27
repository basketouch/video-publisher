require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { Readable } = require('stream');
const axios = require('axios');
const FormData = require('form-data');
const bodyParser = require('body-parser');
const cookieSession = require('cookie-session');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { aggregateFromXmlString, mergeAggregatedPayloads } = require('./lib/statsFromScoutingXml');
const { listGames, getGameXmlAndTitle } = require('./lib/salaGamesStore');

const GAMES_DATA_DIR = process.env.GAME_DATA_DIR
  ? path.resolve(process.env.GAME_DATA_DIR)
  : path.join(__dirname, 'data', 'games');

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
      scopes: ['https://www.googleapis.com/auth/drive']
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
/**
 * Única carpeta de vídeos de la Sala (y subcarpetas). No se usa otra ruta de Drive para listar/reproducir.
 * https://drive.google.com/drive/folders/1vARtPfaS6Txu_u9hLwjqLmdjrakLnW_L
 */
const VIDEO_SALA_ROOT_FOLDER_ID = '1vARtPfaS6Txu_u9hLwjqLmdjrakLnW_L';
const PRIVATE_VIEWER_FOLDER = VIDEO_SALA_ROOT_FOLDER_ID;
/** Carpeta donde vive video_notes.json (si no se define, usa la misma que los vídeos). Útil si los vídeos solo pueden ser “lector” pero quieres otra carpeta con permiso de editor para la SA. */
const PRIVATE_NOTES_FOLDER = process.env.VIDEO_NOTES_DRIVE_FOLDER_ID || PRIVATE_VIEWER_FOLDER;
const NOTES_FILE_NAME = process.env.VIDEO_NOTES_FILE_NAME || 'video_notes.json';
let notesFileIdCache = process.env.VIDEO_NOTES_DRIVE_FILE_ID || null;
/**
 * Misma unidad de persistencia que las notas de video (video_notes.json en Drive).
 * Un archivo aparte peta en muchas SAs: sin cuota en "Mi unidad" (hay que shared drive, etc.).
 */
const SALA_GAME_CHART_NOTES_KEY = '__salaGameChartNotes';
/** Partidos (XML) subidos por la sala: viven en Drive, no en el repo. Compartir la carpeta con la service account. */
const DEFAULT_SALA_GAMES_DRIVE_FOLDER = '1F8D_CYXtVqfnTm6bBBEZsuWBh2Ggrqb1';
const SALA_GAMES_DRIVE_FOLDER = (process.env.SALA_GAMES_DRIVE_FOLDER_ID || DEFAULT_SALA_GAMES_DRIVE_FOLDER).trim();

function getSalaGamesStoreContext() {
  return {
    getDrive: async () => {
      await ensureServiceAccountCreds();
      const auth = getDriveServiceAccountClient();
      if (!auth) return null;
      return google.drive({ version: 'v3', auth });
    },
    driveFolderId: SALA_GAMES_DRIVE_FOLDER
  };
}

function driveHttpStatus(err) {
  const s = err?.response?.status;
  if (typeof s === 'number') return s;
  const c = err?.code;
  if (typeof c === 'number') return c;
  if (typeof c === 'string' && /^\d+$/.test(c)) return parseInt(c, 10);
  return null;
}

function driveErrorDetail(err) {
  const errors = err?.response?.data?.error?.errors;
  if (Array.isArray(errors) && errors[0]) {
    const e = errors[0];
    return [e.reason, e.message].filter(Boolean).join(': ');
  }
  return err?.message || '';
}

async function streamToString(readable) {
  const chunks = [];
  await new Promise((resolve, reject) => {
    readable.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    readable.on('end', resolve);
    readable.on('error', reject);
  });
  return Buffer.concat(chunks).toString('utf8');
}

async function getDriveNotesFileId(drive, options = {}) {
  const { createIfMissing = false } = options;
  if (notesFileIdCache) return notesFileIdCache;
  const { data } = await drive.files.list({
    q: `'${PRIVATE_NOTES_FOLDER}' in parents and name = '${NOTES_FILE_NAME}' and trashed = false`,
    fields: 'files(id,name,modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  const found = data.files?.[0];
  if (found?.id) {
    notesFileIdCache = found.id;
    return notesFileIdCache;
  }

  if (!createIfMissing) return null;

  const created = await drive.files.create({
    requestBody: {
      name: NOTES_FILE_NAME,
      parents: [PRIVATE_NOTES_FOLDER],
      mimeType: 'application/json'
    },
    media: {
      mimeType: 'application/json',
      body: Readable.from(['{}'])
    },
    fields: 'id',
    supportsAllDrives: true
  });
  notesFileIdCache = created.data.id;
  return notesFileIdCache;
}

async function loadVideoNotes(drive) {
  const fileId = await getDriveNotesFileId(drive, { createIfMissing: false });
  if (!fileId) return {};
  try {
    const fileRes = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );
    const raw = await streamToString(fileRes.data);
    const parsed = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object') return parsed;
    return {};
  } catch (err) {
    console.error('Error leyendo notas de video:', err.message);
    return {};
  }
}

async function saveVideoNotes(drive, notesMap) {
  const fileId = await getDriveNotesFileId(drive, { createIfMissing: true });
  const payload = JSON.stringify(notesMap, null, 2);
  await drive.files.update({
    fileId,
    media: {
      mimeType: 'application/json',
      body: Readable.from([payload])
    },
    supportsAllDrives: true
  });
}

const CHART_NOTE_KINDS = new Set(['pps', 'efg', 'mix']);

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

/**
 * Comprueba que un archivo o carpeta de Drive cuelga de VIDEO_SALA_ROOT_FOLDER_ID (ancestros hasta la raíz).
 */
async function isUnderVideoSalaRoot(drive, itemId, rootId = VIDEO_SALA_ROOT_FOLDER_ID) {
  if (!itemId || !rootId || !/^[\w-]+$/.test(String(itemId))) return false;
  let cur = itemId;
  const seen = new Set();
  for (let d = 0; d < 60 && cur; d++) {
    if (cur === rootId) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    const got = await drive.files
      .get({
        fileId: cur,
        fields: 'parents',
        supportsAllDrives: true
      })
      .catch(() => null);
    const parents = got?.data?.parents || [];
    if (!parents.length) return false;
    cur = parents[0];
  }
  return false;
}

async function assertSalaVideoFileId(drive, fileId) {
  if (!fileId || !/^[\w-]+$/.test(String(fileId))) return false;
  const got = await drive.files
    .get({
      fileId,
      fields: 'mimeType, trashed',
      supportsAllDrives: true
    })
    .catch(() => null);
  const mime = got?.data?.mimeType;
  if (!mime || !String(mime).startsWith('video/') || got?.data?.trashed === true) return false;
  return isUnderVideoSalaRoot(drive, fileId, VIDEO_SALA_ROOT_FOLDER_ID);
}

/**
 * Ruta de migas desde folderId hasta rootId (inclusive). Máximo ~30 niveles.
 */
async function buildVideoFolderBreadcrumbs(drive, folderId, rootId) {
  const segments = [];
  let cur = folderId;
  const seen = new Set();
  while (cur && segments.length < 30 && !seen.has(cur)) {
    seen.add(cur);
    const got = await drive.files.get({
      fileId: cur,
      fields: 'id, name, parents',
      supportsAllDrives: true
    });
    const data = got.data;
    if (!data) break;
    segments.unshift({ id: data.id, name: data.name || data.id });
    if (data.id === rootId) break;
    const next = data.parents && data.parents[0];
    if (!next) break;
    cur = next;
  }
  if (segments.length === 0 || segments[0].id !== rootId) {
    const rootGot = await drive.files
      .get({
        fileId: rootId,
        fields: 'id, name',
        supportsAllDrives: true
      })
      .catch(() => null);
    const rootName = rootGot?.data?.name || 'Videos';
    segments.unshift({ id: rootId, name: rootName });
  }
  return segments;
}

// Sala privada: listado de carpetas + vídeos (navegable). ?folder=id para subcarpeta.
app.get('/api/private/videos', requireAuth, async (req, res) => {
  await ensureServiceAccountCreds();
  const auth = getDriveServiceAccountClient();
  if (!auth) {
    return res.status(503).json({ error: 'Service Account no configurado para sala privada' });
  }
  const rawFolder = typeof req.query.folder === 'string' ? req.query.folder.trim() : '';
  const parentId = rawFolder || PRIVATE_VIEWER_FOLDER;
  if (!/^[\w-]+$/.test(parentId)) {
    return res.status(400).json({ error: 'Identificador de carpeta no válido' });
  }
  try {
    const drive = google.drive({ version: 'v3', auth });
    const allowedFolder = await isUnderVideoSalaRoot(drive, parentId, VIDEO_SALA_ROOT_FOLDER_ID);
    if (!allowedFolder) {
      return res.status(403).json({ error: 'Solo se permite acceder a la carpeta Videos de la sala y sus subcarpetas.' });
    }
    const { data } = await drive.files.list({
      q: `'${parentId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, size, modifiedTime)',
      pageSize: 200,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    const files = data.files || [];
    const subfolders = files
      .filter((f) => f.mimeType === 'application/vnd.google-apps.folder')
      .map((f) => ({ id: f.id, name: f.name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
    const videos = files
      .filter((f) => f.mimeType && String(f.mimeType).startsWith('video/'))
      .sort((a, b) => new Date(b.modifiedTime || 0) - new Date(a.modifiedTime || 0))
      .map((f) => ({
        id: f.id,
        title: f.name,
        mimeType: f.mimeType,
        size: f.size,
        modifiedTime: f.modifiedTime
      }));

    const folderMeta = await drive.files
      .get({
        fileId: parentId,
        fields: 'id, name, parents, mimeType',
        supportsAllDrives: true
      })
      .catch(() => null);
    if (!folderMeta?.data || folderMeta.data.mimeType !== 'application/vnd.google-apps.folder') {
      return res.status(404).json({ error: 'Carpeta no encontrada' });
    }

    const breadcrumbs = await buildVideoFolderBreadcrumbs(drive, parentId, PRIVATE_VIEWER_FOLDER);
    const parents = folderMeta.data.parents || [];
    const parentFolderId = parents[0] || null;

    res.json({
      rootFolderId: VIDEO_SALA_ROOT_FOLDER_ID,
      folderId: parentId,
      folderName: folderMeta.data.name || 'Videos',
      parentFolderId,
      breadcrumbs,
      subfolders,
      videos
    });
  } catch (err) {
    console.error('Error listando videos privados:', err);
    res.status(500).json({ error: 'No se pudieron cargar los videos privados' });
  }
});

function pickHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return undefined;
}

// Sala privada: streaming sin exponer enlaces de Drive (un solo round-trip a Google cuando hay Range)
app.get('/api/private/videos/:id/stream', requireAuth, async (req, res) => {
  await ensureServiceAccountCreds();
  const auth = getDriveServiceAccountClient();
  if (!auth) {
    return res.status(503).json({ error: 'Service Account no configurado para sala privada' });
  }
  try {
    const drive = google.drive({ version: 'v3', auth });
    const fileId = req.params.id;
    if (!(await assertSalaVideoFileId(drive, fileId))) {
      return res.status(403).json({ error: 'Video no disponible en la carpeta de la sala.' });
    }
    const range = req.headers.range;
    const requestConfig = {
      responseType: 'stream',
      validateStatus: () => true
    };
    if (range) {
      requestConfig.headers = { Range: range };
    }
    const upstream = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      requestConfig
    );
    const status = upstream.status;
    const rh = upstream.headers || {};

    if (status === 416) {
      return res.status(416).send('Range no válido');
    }
    if (status < 200 || status >= 300) {
      let detail = '';
      try {
        detail = await streamToString(upstream.data);
      } catch {
        detail = '';
      }
      console.error('Drive stream error', status, detail?.slice(0, 200));
      return res.status(status >= 400 ? status : 502).json({ error: 'No se pudo reproducir el video' });
    }

    res.status(status);
    const forwardNames = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag'];
    for (const n of forwardNames) {
      const v = pickHeader(rh, n);
      if (v) res.setHeader(n, v);
    }
    res.setHeader('Cache-Control', 'private, max-age=120');

    upstream.data.on('error', (e) => {
      console.error('Error en stream upstream:', e.message);
      if (!res.writableEnded) res.destroy(e);
    });
    upstream.data.pipe(res);
  } catch (err) {
    console.error('Error streaming video privado:', err);
    res.status(500).json({ error: 'No se pudo reproducir el video' });
  }
});

// Sala privada: descripción de análisis por video (admin escribe, viewer lee)
app.get('/api/private/videos/:id/notes', requireAuth, async (req, res) => {
  await ensureServiceAccountCreds();
  const auth = getDriveServiceAccountClient();
  if (!auth) return res.status(503).json({ error: 'Service Account no configurado para notas' });
  try {
    const drive = google.drive({ version: 'v3', auth });
    if (!(await assertSalaVideoFileId(drive, req.params.id))) {
      return res.status(403).json({ error: 'Video no disponible en la carpeta de la sala.' });
    }
    const notes = await loadVideoNotes(drive);
    const note = notes[req.params.id] || {};
    res.json({
      text: typeof note.text === 'string' ? note.text : '',
      updatedAt: note.updatedAt || null,
      updatedBy: note.updatedBy || null
    });
  } catch (err) {
    console.error('Error leyendo notas del video:', err);
    const status = driveHttpStatus(err);
    if (status === 403) {
      return res.status(403).json({
        error: 'La cuenta de servicio no tiene permisos sobre el archivo de notas',
        detail: driveErrorDetail(err)
      });
    }
    res.status(500).json({ error: 'No se pudo cargar el análisis del video', detail: driveErrorDetail(err) });
  }
});

app.put('/api/private/videos/:id/notes', requireAdmin, async (req, res) => {
  await ensureServiceAccountCreds();
  const auth = getDriveServiceAccountClient();
  if (!auth) return res.status(503).json({ error: 'Service Account no configurado para notas' });
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (text.length > 5000) {
    return res.status(400).json({ error: 'El análisis no puede superar 5000 caracteres' });
  }
  try {
    const drive = google.drive({ version: 'v3', auth });
    if (!(await assertSalaVideoFileId(drive, req.params.id))) {
      return res.status(403).json({ error: 'Video no disponible en la carpeta de la sala.' });
    }
    const notes = await loadVideoNotes(drive);
    notes[req.params.id] = {
      text,
      updatedAt: new Date().toISOString(),
      updatedBy: req.session?.userEmail || 'admin'
    };
    await saveVideoNotes(drive, notes);
    res.json(notes[req.params.id]);
  } catch (err) {
    console.error('Error guardando notas del video:', err);
    const status = driveHttpStatus(err);
    if (status === 403) {
      return res.status(403).json({
        error:
          'La cuenta de servicio no puede crear o editar video_notes.json. Dale rol Editor a la carpeta (o crea VIDEO_NOTES_DRIVE_FOLDER_ID con una carpeta donde la SA sea editor).',
        detail: driveErrorDetail(err)
      });
    }
    res.status(500).json({ error: 'No se pudo guardar el análisis del video', detail: driveErrorDetail(err) });
  }
});

// Sala: anotaciones por partido y tipo de gráfico (dentro de video_notes.json, clave __salaGameChartNotes: evita 2.º archivo en Drive)
app.get('/api/private/games/:id/chart-notes/:kind', requireAuth, async (req, res) => {
  if (!CHART_NOTE_KINDS.has(req.params.kind)) {
    return res.status(400).json({ error: 'Tipo de gráfico no válido' });
  }
  await ensureServiceAccountCreds();
  const auth = getDriveServiceAccountClient();
  if (!auth) return res.status(503).json({ error: 'Service Account no configurado para notas' });
  try {
    const drive = google.drive({ version: 'v3', auth });
    const notes = await loadVideoNotes(drive);
    const bucket = notes[SALA_GAME_CHART_NOTES_KEY];
    const g = bucket && typeof bucket === 'object' && !Array.isArray(bucket) ? bucket[req.params.id] : null;
    const note = g && g[req.params.kind] && typeof g[req.params.kind] === 'object' ? g[req.params.kind] : {};
    res.json({
      text: typeof note.text === 'string' ? note.text : '',
      updatedAt: note.updatedAt || null,
      updatedBy: note.updatedBy || null
    });
  } catch (err) {
    console.error('Error leyendo anotaciones de gráfico:', err);
    const status = driveHttpStatus(err);
    if (status === 403) {
      return res.status(403).json({ error: 'Sin permisos sobre el archivo de anotaciones', detail: driveErrorDetail(err) });
    }
    res.status(500).json({ error: 'No se pudieron cargar las anotaciones', detail: driveErrorDetail(err) });
  }
});

app.put('/api/private/games/:id/chart-notes/:kind', requireAdmin, async (req, res) => {
  if (!CHART_NOTE_KINDS.has(req.params.kind)) {
    return res.status(400).json({ error: 'Tipo de gráfico no válido' });
  }
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (text.length > 5000) {
    return res.status(400).json({ error: 'La anotación no puede superar 5000 caracteres' });
  }
  await ensureServiceAccountCreds();
  const auth = getDriveServiceAccountClient();
  if (!auth) return res.status(503).json({ error: 'Service Account no configurado para notas' });
  try {
    const drive = google.drive({ version: 'v3', auth });
    const notes = await loadVideoNotes(drive);
    if (!notes[SALA_GAME_CHART_NOTES_KEY] || typeof notes[SALA_GAME_CHART_NOTES_KEY] !== 'object' || Array.isArray(notes[SALA_GAME_CHART_NOTES_KEY])) {
      notes[SALA_GAME_CHART_NOTES_KEY] = {};
    }
    const bucket = notes[SALA_GAME_CHART_NOTES_KEY];
    if (!bucket[req.params.id] || typeof bucket[req.params.id] !== 'object' || Array.isArray(bucket[req.params.id])) {
      bucket[req.params.id] = {};
    }
    bucket[req.params.id][req.params.kind] = {
      text,
      updatedAt: new Date().toISOString(),
      updatedBy: req.session?.userEmail || 'admin'
    };
    await saveVideoNotes(drive, notes);
    res.json(bucket[req.params.id][req.params.kind]);
  } catch (err) {
    console.error('Error guardando anotaciones de gráfico:', err);
    const status = driveHttpStatus(err);
    if (status === 403) {
      return res.status(403).json({
        error:
          'La cuenta de servicio no puede editar video_notes.json. Dale rol Editor a la carpeta (o crea VIDEO_NOTES_DRIVE_FOLDER_ID en una unidad compartida donde la SA tenga acceso, ver documentación de Drive + service accounts).',
        detail: driveErrorDetail(err)
      });
    }
    res.status(500).json({ error: 'No se pudo guardar la anotación', detail: driveErrorDetail(err) });
  }
});

// XML de partidos: listado/lectura desde Google Drive (carpeta) y/o data/games en local; sin subida vía web
app.get('/api/private/games', requireAuth, async (req, res) => {
  try {
    const list = await listGames(GAMES_DATA_DIR, getSalaGamesStoreContext());
    res.json({ games: list.map((g) => ({ id: g.id, title: g.title })) });
  } catch (err) {
    console.error('Error listando partidos:', err);
    res.status(500).json({ error: 'No se pudo leer el listado de partidos' });
  }
});

/** Acumulado de todos los XML de la carpeta (comparativa entre partidos). Debe ir antes de /games/:id/stats. */
app.get('/api/private/games/aggregate/stats', requireAuth, async (req, res) => {
  try {
    const list = await listGames(GAMES_DATA_DIR, getSalaGamesStoreContext());
    if (!list.length) {
      return res.json({
        id: 'aggregate',
        title: 'Acumulado · todos los partidos',
        players: [],
        meanPps: null,
        hasPlaymaking: false,
        gamesCount: 0,
        gamesWithData: 0,
        aggregated: true
      });
    }
    const payloads = [];
    for (const g of list) {
      try {
        const bundle = await getGameXmlAndTitle(g.id, GAMES_DATA_DIR, getSalaGamesStoreContext());
        if (bundle?.xml) {
          payloads.push(aggregateFromXmlString(bundle.xml));
        }
      } catch (e) {
        console.error(`aggregate stats: omitiendo partido ${g.id}:`, e.message);
      }
    }
    if (!payloads.length) {
      return res.json({
        id: 'aggregate',
        title: 'Acumulado · todos los partidos',
        players: [],
        meanPps: null,
        hasPlaymaking: false,
        gamesCount: list.length,
        gamesWithData: 0,
        aggregated: true
      });
    }
    const merged = mergeAggregatedPayloads(payloads);
    const n = payloads.length;
    res.json({
      id: 'aggregate',
      title: `Acumulado · ${n} partido${n === 1 ? '' : 's'}`,
      players: merged.players,
      meanPps: merged.meanPps,
      hasPlaymaking: !!merged.hasPlaymaking,
      gamesCount: list.length,
      gamesWithData: n,
      aggregated: true
    });
  } catch (err) {
    console.error('Error en estadísticas acumuladas:', err);
    res.status(500).json({ error: 'No se pudo agregar estadísticas de todos los partidos' });
  }
});

app.get('/api/private/games/:id/stats', requireAuth, async (req, res) => {
  let bundle;
  try {
    bundle = await getGameXmlAndTitle(req.params.id, GAMES_DATA_DIR, getSalaGamesStoreContext());
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Error leyendo el partido' });
  }
  if (!bundle) {
    return res.status(404).json({ error: 'Partido no encontrado' });
  }
  try {
    const { players, meanPps, hasPlaymaking } = aggregateFromXmlString(bundle.xml);
    res.json({
      id: req.params.id,
      title: bundle.title,
      players,
      meanPps,
      hasPlaymaking: !!hasPlaymaking
    });
  } catch (e) {
    console.error('Error agregando stats del partido:', e);
    res.status(500).json({ error: 'No se pudo analizar el XML del partido' });
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

app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
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
