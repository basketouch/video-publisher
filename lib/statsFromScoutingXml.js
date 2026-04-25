/**
 * Agrega tiros de campo (FGA) y puntos de jugadores a partir de XML de etiquetado
 * (Hudl / Sportscode: <instance> + Team + Action).
 * Deriva eFG%, TS% y ratios de asistencia/pérdida.
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

function isAssist(t) {
  if (!t) return false;
  const s = t.trim();
  if (/^ft\s|^2 pt|^3 pt|^2F|^3F|^2\+1|^3\+1/i.test(s)) return false;
  if (/missed assist|no assist|sin asist|sin anotación/i.test(s)) return false;
  return /^(assist|asist|ast)\b|asistencia|pass for (score|fg)|pase (de )?anot/i.test(s) || (/\bassist\b|asistencia/i.test(s) && /pass|pase/i.test(s));
}

function isTurnover(t) {
  if (!t) return false;
  const s = t.trim();
  if (/^ft\s|^2 pt|^3 pt|^2F|^3F|^2\+1|^3\+1/i.test(s)) return false;
  return /turnover|p[ée]rdida|pérdida|tov\b|lost ball|bad pass|travel|steps|doble|double dribb|5 sec|8 sec|backcourt|3 sec|violation|shot clock/i.test(
    s
  );
}

function createStatsRow(team, codeStr) {
  return {
    team,
    code: codeStr,
    fga: 0,
    fgPoints: 0,
    pointsTotal: 0,
    fgm2: 0,
    fga2: 0,
    fgm3: 0,
    fga3: 0,
    fta: 0,
    ftm: 0,
    ast: 0,
    tov: 0
  };
}

/**
 * FGA, desglose 2/3, tiros libres, asistencias y pérdidas.
 */
function applyActionToStats(a, g) {
  if (!a) return;
  const t = a.trim();
  if (t === 'FT Made') {
    g.pointsTotal = (g.pointsTotal || 0) + 1;
    g.fta = (g.fta || 0) + 1;
    g.ftm = (g.ftm || 0) + 1;
    return;
  }
  if (t === 'FT Missed') {
    g.fta = (g.fta || 0) + 1;
    return;
  }
  if (isAssist(t)) {
    g.ast = (g.ast || 0) + 1;
    return;
  }
  if (isTurnover(t)) {
    g.tov = (g.tov || 0) + 1;
    return;
  }

  if (t.startsWith('2+1')) {
    g.fga += 1;
    g.fga2 += 1;
    g.fgm2 += 1;
    g.fgPoints += 2;
    g.pointsTotal = (g.pointsTotal || 0) + 2;
    return;
  }
  if (t.startsWith('3+1')) {
    g.fga += 1;
    g.fga3 += 1;
    g.fgm3 += 1;
    g.fgPoints += 3;
    g.pointsTotal = (g.pointsTotal || 0) + 3;
    return;
  }
  if (t.startsWith('2F -') || t.startsWith('2F ')) {
    g.fga += 1;
    g.fga2 += 1;
    g.fgm2 += 1;
    g.fgPoints += 2;
    g.pointsTotal = (g.pointsTotal || 0) + 2;
    return;
  }
  if (t.startsWith('3F -') || t.startsWith('3F ')) {
    g.fga += 1;
    g.fga3 += 1;
    g.fgm3 += 1;
    g.fgPoints += 3;
    g.pointsTotal = (g.pointsTotal || 0) + 3;
    return;
  }
  if (/^3 pt Made\b/.test(t)) {
    g.fga += 1;
    g.fga3 += 1;
    g.fgm3 += 1;
    g.fgPoints += 3;
    g.pointsTotal = (g.pointsTotal || 0) + 3;
    return;
  }
  if (/^3 pt Missed\b/.test(t)) {
    g.fga += 1;
    g.fga3 += 1;
    return;
  }
  if (/^2 pt Made\b/.test(t)) {
    g.fga += 1;
    g.fga2 += 1;
    g.fgm2 += 1;
    g.fgPoints += 2;
    g.pointsTotal = (g.pointsTotal || 0) + 2;
    return;
  }
  if (/^2 pt Missed\b/.test(t)) {
    g.fga += 1;
    g.fga2 += 1;
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
 * eFG% = (FGM + 0,5*3PM) / FGA. FGM = fgm2+fgm3, 3PM = fgm3.
 */
function efgFromRows(g) {
  const fga = g.fga;
  if (fga < 1) return null;
  const fgm = g.fgm2 + g.fgm3;
  const efg = (fgm + 0.5 * g.fgm3) / fga;
  return Math.round(efg * 1000) / 1000;
}

/**
 * TS% = PTS / (2 * (FGA + 0,44*FTA))
 */
function tsFromRows(g) {
  const fga = g.fga;
  const fta = g.fta || 0;
  const pts = g.pointsTotal == null ? g.fgPoints : g.pointsTotal;
  const denom = 2 * (fga + 0.44 * fta);
  if (denom <= 0) return null;
  const ts = pts / denom;
  return Math.round(ts * 1000) / 1000;
}

/**
 * Denominador común para compartir “eventos ofensivos” aproximados.
 */
function playDenom(g) {
  const fga = g.fga || 0;
  const fta = g.fta || 0;
  const a = g.ast || 0;
  const v = g.tov || 0;
  return fga + 0.44 * fta + a + v;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/**
 * @param {string} xml
 * @returns {{ players: Array, meanPps: number|null, hasPlaymaking: boolean }}
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
      byKey.set(key, createStatsRow(team, c));
    }
    applyActionToStats(action, byKey.get(key));
  }

  const players = [];
  for (const g of byKey.values()) {
    const activity = (g.fga || 0) + (g.fta || 0) + (g.ast || 0) + (g.tov || 0);
    if (activity < 1) continue;

    const p = parseCode(g.code);
    const pps = g.fga > 0 ? g.fgPoints / g.fga : 0;
    const dPlay = playDenom(g);
    const efgPct = efgFromRows(g);
    const tsPct = tsFromRows(g);
    const astPct = dPlay > 0 ? round3(100 * (g.ast || 0) / dPlay) : null;
    const tovPct = dPlay > 0 ? round3(100 * (g.tov || 0) / dPlay) : null;

    players.push({
      team: g.team,
      code: g.code,
      name: p.name,
      number: p.number,
      label: p.shortLabel,
      fga: g.fga,
      /** Desglose de intentos de campo (2P vs 3P), coherente con FGA */
      fga2: g.fga2 || 0,
      fga3: g.fga3 || 0,
      fieldGoalPoints: g.fgPoints,
      pointsTotal: g.pointsTotal,
      fta: g.fta || 0,
      ftm: g.ftm || 0,
      ast: g.ast || 0,
      tov: g.tov || 0,
      pps: g.fga >= 1 ? round3(pps) : null,
      efgPct: g.fga >= 1 ? efgPct : null,
      tsPct: g.fga + 0.44 * (g.fta || 0) > 0 ? tsFromRows(g) : null,
      astPct,
      tovPct
    });
  }
  players.sort((a, b) => a.team.localeCompare(b.team) || a.label.localeCompare(b.label));

  const ppsList = players.map((p) => p.pps).filter((v) => v != null);
  const meanPps = ppsList.length
    ? round3(ppsList.reduce((s, v) => s + v, 0) / ppsList.length)
    : null;

  const hasPlaymaking = players.some((p) => (p.ast > 0 || p.tov > 0) && playDenom(
    { fga: p.fga, fta: p.fta, ast: p.ast, tov: p.tov }
  ) > 0);

  return { players, meanPps, hasPlaymaking };
}

function codeReExec(block) {
  const m = String(block).match(CODE_RE);
  return m ? m[1].trim() : null;
}

module.exports = { aggregateFromXmlString };
