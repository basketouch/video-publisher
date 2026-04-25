/**
 * Agrega tiros de campo (FGA) y puntos de jugadores a partir de XML de etiquetado
 * (Hudl / Sportscode: <instance> + Team + Action).
 */
const INSTANCE_RE = /<instance>([\s\S]*?)<\/instance>/g;
const CODE_RE = /<code>([^<]*)<\/code>/;
const LABEL_RE = /<label><group>([^<]+)<\/group><text>([^<]*)<\/text><\/label>/g;

function unescape(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function labelMap(block) {
  const m = {};
  for (const match of String(block).matchAll(LABEL_RE)) {
    m[match[1].trim()] = unescape(match[2]);
  }
  return m;
}

/**
 * FGA: 2/3 tiro, 2F/3F, 2+1/3+1 (tiro de campo; no FT).
 * fgPoints: solo puntos de canasta (sin tiros libres). PPS = fgPoints / FGA.
 * pointsTotal: incluye tiros libres (referencia).
 */
function applyActionToStats(a, g) {
  if (!a) return;
  const t = a.trim();
  if (t === 'FT Made') {
    g.pointsTotal = (g.pointsTotal || 0) + 1;
    return;
  }
  if (t === 'FT Missed') return;

  if (t.startsWith('2+1')) {
    g.fga += 1;
    g.fgPoints += 2;
    g.pointsTotal = (g.pointsTotal || 0) + 2;
    return;
  }
  if (t.startsWith('3+1')) {
    g.fga += 1;
    g.fgPoints += 3;
    g.pointsTotal = (g.pointsTotal || 0) + 3;
    return;
  }
  if (t.startsWith('2F -') || t.startsWith('2F ')) {
    g.fga += 1;
    g.fgPoints += 2;
    g.pointsTotal = (g.pointsTotal || 0) + 2;
    return;
  }
  if (t.startsWith('3F -') || t.startsWith('3F ')) {
    g.fga += 1;
    g.fgPoints += 3;
    g.pointsTotal = (g.pointsTotal || 0) + 3;
    return;
  }
  if (/^3 pt Made\b/.test(t)) {
    g.fga += 1;
    g.fgPoints += 3;
    g.pointsTotal = (g.pointsTotal || 0) + 3;
    return;
  }
  if (/^3 pt Missed\b/.test(t)) {
    g.fga += 1;
    return;
  }
  if (/^2 pt Made\b/.test(t)) {
    g.fga += 1;
    g.fgPoints += 2;
    g.pointsTotal = (g.pointsTotal || 0) + 2;
    return;
  }
  if (/^2 pt Missed\b/.test(t)) {
    g.fga += 1;
    return;
  }
}

function parseCode(codeRaw) {
  const code = (codeRaw || '').trim();
  const m = code.match(/^\s*(\d+)\s+(.+?)\s+\(/);
  if (m) {
    return { number: m[1], name: m[2].trim(), shortLabel: `${m[1]} ${m[2].trim()}` };
  }
  return { number: '', name: code, shortLabel: code };
}

/**
 * @param {string} xml
 * @returns {{ fileName: string, players: Array, meanPps: number|null }}
 */
function aggregateFromXmlString(xml) {
  const byKey = new Map();
  for (const match of String(xml).matchAll(INSTANCE_RE)) {
    const block = match[1];
    const c = codeReExec(block);
    if (!c) continue;
    const labels = labelMap(block);
    const team = labels.Team;
    const action = labels.Action;
    if (!team || !action) continue;
    const key = `${team}|||${c}`;
    if (!byKey.has(key)) {
      byKey.set(key, { team, code: c, fga: 0, fgPoints: 0, pointsTotal: 0 });
    }
    applyActionToStats(action, byKey.get(key));
  }

  const players = [];
  for (const g of byKey.values()) {
    if (g.fga < 1) continue;
    const p = parseCode(g.code);
    const pps = g.fga > 0 ? g.fgPoints / g.fga : 0;
    players.push({
      team: g.team,
      code: g.code,
      name: p.name,
      number: p.number,
      label: p.shortLabel,
      fga: g.fga,
      /** Puntos de campo (sin TL) usados en PPS */
      fieldGoalPoints: g.fgPoints,
      /** Todos los puntos (canasta + tiros libres) */
      pointsTotal: g.pointsTotal,
      pps: Math.round(pps * 1000) / 1000
    });
  }
  players.sort((a, b) => a.team.localeCompare(b.team) || a.label.localeCompare(b.label));

  const ppsList = players.map((p) => p.pps);
  const meanPps = ppsList.length
    ? Math.round((ppsList.reduce((s, v) => s + v, 0) / ppsList.length) * 1000) / 1000
    : null;

  return { players, meanPps };
}

function codeReExec(block) {
  const m = String(block).match(CODE_RE);
  return m ? m[1].trim() : null;
}

module.exports = { aggregateFromXmlString };
