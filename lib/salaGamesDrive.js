async function streamToString(readable) {
  const chunks = [];
  await new Promise((resolve, reject) => {
    readable.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    readable.on('end', resolve);
    readable.on('error', reject);
  });
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Lista .xml en una carpeta de Drive.
 * @returns {Promise<Array<{ id: string, title: string, createdAt: string }>>}
 */
async function listXmlInFolder(drive, folderId) {
  if (!folderId) return [];
  const q = `'${folderId}' in parents and trashed = false`;
  const { data } = await drive.files.list({
    q,
    fields: 'files(id,name,modifiedTime,mimeType)',
    orderBy: 'modifiedTime desc',
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  const files = (data.files || []).filter(
    (f) => f && f.id && f.name && /\.xml$/i.test(f.name) && f.mimeType !== 'application/vnd.google-apps.folder'
  );
  return files
    .map((f) => ({
      id: f.id,
      title: f.name.replace(/\.xml$/i, '').replace(/_+/g, ' '),
      createdAt: f.modifiedTime || new Date(0).toISOString()
    }));
}

/**
 * @returns {Promise<{ xml: string, title: string }|null>}
 */
async function getXmlByFileId(drive, fileId) {
  const { data: meta } = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType',
    supportsAllDrives: true
  });
  if (!meta) return null;
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );
  const xml = await streamToString(res.data);
  return {
    xml,
    title: (meta.name || 'partido').replace(/\.xml$/i, '')
  };
}

module.exports = {
  listXmlInFolder,
  getXmlByFileId
};
