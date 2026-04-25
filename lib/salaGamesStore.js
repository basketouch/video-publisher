const path = require('path');
const fsp = require('fs/promises');
const { randomUUID } = require('crypto');
const { listXmlInFolder, getXmlByFileId, uploadXml } = require('./salaGamesDrive');

function looksLikeScoutingXml(str) {
  if (!str || str.length < 50) return false;
  if (!/<\?xml/i.test(str.slice(0, 200)) && !/<\s*file/i.test(str.slice(0, 2000)) && !/<\s*instance/i.test(str)) {
    return false;
  }
  return (str.includes('ALL_INSTANCES') || str.includes('<instance>')) && str.length < 6 * 1024 * 1024;
}

async function readLocalManifestList(gamesDir) {
  const manifestPath = path.join(gamesDir, 'manifest.json');
  let raw;
  try {
    raw = await fsp.readFile(manifestPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const { games: list } = JSON.parse(raw);
  const out = [];
  for (const g of list || []) {
    if (!g.id || !g.file) continue;
    if (String(g.file).includes('..') || path.isAbsolute(g.file)) continue;
    const fp = path.join(gamesDir, path.basename(g.file));
    try {
      const st = await fsp.stat(fp);
      out.push({
        id: g.id,
        title: g.title || g.id,
        createdAt: g.createdAt || st.mtime.toISOString(),
        source: 'local'
      });
    } catch {
      // omitir
    }
  }
  return out;
}

/**
 * Lista partidos: Google Drive (carpeta dedicada) + manifest local.
 * @param {object} [ctx] { getDrive, driveFolderId }
 */
async function listGames(gamesDir, ctx = {}) {
  const { getDrive, driveFolderId } = ctx || {};
  const out = [];
  if (getDrive && driveFolderId) {
    try {
      const drive = await getDrive();
      if (drive) {
        const fromDrive = await listXmlInFolder(drive, driveFolderId);
        for (const g of fromDrive) {
          out.push({ ...g, source: 'drive' });
        }
      }
    } catch (e) {
      console.error('sala listDrive games:', e.message);
    }
  }
  const local = await readLocalManifestList(gamesDir);
  const seen = new Set(out.map((g) => g.id));
  for (const g of local) {
    if (!seen.has(g.id)) {
      out.push(g);
      seen.add(g.id);
    }
  }
  out.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return out;
}

/**
 * 1) manifest local, 2) ID de Drive (archivo)
 * @param {object} [ctx] { getDrive, driveFolderId }
 */
async function getGameXmlAndTitle(id, gamesDir, ctx = {}) {
  const { getDrive } = ctx || {};
  const manifestPath = path.join(gamesDir, 'manifest.json');
  let list = [];
  try {
    const raw = await fsp.readFile(manifestPath, 'utf8');
    list = JSON.parse(raw).games || [];
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const entry = list.find((g) => g.id === id);
  if (entry && entry.file) {
    if (String(entry.file).includes('..') || path.isAbsolute(entry.file)) return null;
    const fp = path.join(gamesDir, path.basename(entry.file));
    try {
      const xml = await fsp.readFile(fp, 'utf8');
      return { xml, title: entry.title || id };
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  if (getDrive) {
    try {
      const drive = await getDrive();
      if (drive) {
        const r = await getXmlByFileId(drive, id);
        if (r && r.xml) return r;
      }
    } catch (e) {
      const code = e?.code || e?.status;
      if (code === 404 || e?.message?.includes('404')) return null;
      console.error('sala getDrive xml:', e.message);
    }
  }
  return null;
}

/**
 * Guarda XML: primero Google Drive (si hay carpeta y SA), si no solo disco (desarrollo local).
 */
async function saveGame({ title, xml, gamesDir, ctx = {} }) {
  if (!looksLikeScoutingXml(xml)) {
    return { error: 'El archivo no parece un XML de partido válido (faltan instancias).' };
  }
  const cleanTitle = (title && String(title).trim()) || 'Partido sin título';
  const { getDrive, driveFolderId, requireDriveInProd } = ctx;

  if (requireDriveInProd && !driveFolderId) {
    return {
      error:
        'En Vercel hace falta SALA_GAMES_DRIVE_FOLDER_ID: ID de una carpeta de Google Drive compartida con la misma service account (Editor) que usas para la sala. El XML no se sube al repositorio.'
    };
  }

  if (getDrive && driveFolderId) {
    const drive = await getDrive();
    if (drive) {
      const r = await uploadXml(drive, driveFolderId, cleanTitle, xml);
      if (r.error) {
        return { error: r.error };
      }
      if (r.ok) {
        return { ok: true, id: r.id, title: r.title, source: 'drive' };
      }
    } else if (requireDriveInProd) {
      return {
        error:
          'Google Drive (service account) no está disponible. En Vercel configura GOOGLE_SERVICE_ACCOUNT_JSON con acceso a la carpeta de XML.'
      };
    }
  }

  if (requireDriveInProd) {
    return {
      error: 'No se pudo subir el XML a Drive. Comprueba permisos de la carpeta (Editor para la service account).'
    };
  }

  const id = randomUUID();
  const fileName = `${id}.xml`;
  const fp = path.join(gamesDir, fileName);
  await fsp.mkdir(gamesDir, { recursive: true });
  await fsp.writeFile(fp, xml, 'utf8');
  const mpath = path.join(gamesDir, 'manifest.json');
  let games = [];
  try {
    const raw = await fsp.readFile(mpath, 'utf8');
    games = JSON.parse(raw).games || [];
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  games.push({
    id,
    title: cleanTitle,
    file: fileName,
    createdAt: new Date().toISOString()
  });
  await fsp.writeFile(mpath, JSON.stringify({ games }, null, 2), 'utf8');
  return { ok: true, id, title: cleanTitle, source: 'local' };
}

module.exports = {
  looksLikeScoutingXml,
  listGames,
  getGameXmlAndTitle,
  saveGame
};
