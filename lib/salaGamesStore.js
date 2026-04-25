const path = require('path');
const fsp = require('fs/promises');
const { listXmlInFolder, getXmlByFileId } = require('./salaGamesDrive');

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
 * Lista partidos: Google Drive (carpeta) + manifest local opcional.
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
 * 1) manifest local, 2) ID de archivo en Drive
 * @param {object} [ctx] { getDrive }
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

module.exports = {
  listGames,
  getGameXmlAndTitle
};
