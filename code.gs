/**
 * Golf Dash — Google Sheets backend  ·  v2
 * ----------------------------------------
 * Adds: per-tee ratings, a reusable player roster, and automatic installation
 * of the Rounds-tab formulas (no more hand-pasting ARRAYFORMULAs).
 *
 * UPGRADING FROM v1
 *   1. Replace the whole Code.gs with this file, save.
 *   2. Run migrateToV2() once from the editor.  It is non-destructive: your
 *      existing courses are split into Courses + Tees, and everything else is
 *      left alone.  Safe to re-run.
 *   3. Deploy → Manage deployments → pencil → Version: New version → Deploy.
 *      Editing and saving alone does NOT update the live URL.
 *
 * The client must POST with NO Content-Type header, so the browser sends
 * text/plain and skips the CORS preflight that Apps Script cannot answer.
 */

// ── Tabs ───────────────────────────────────────────────────────────────────

var TAB = {
  courses:  'Courses',
  tees:     'Tees',
  players:  'Players',
  rounds:   'App_Rounds',
  rplayers: 'App_Players',
  settings: 'Settings',
  log:      'Rounds'        // human-readable log feeding Handicap + Stats
};

var HEADER_ROW = {
  'Courses': 4, 'Tees': 4, 'Players': 4, 'Rounds': 4,
  'App_Rounds': 1, 'App_Players': 1, 'Settings': 1
};

function holeCols_(p) {
  var o = [];
  for (var i = 1; i <= 18; i++) o.push(p + i);
  return o;
}

var HEADERS = {
  'Courses': ['course_name', 'holes', 'pars', 'hole_handicaps', 'notes'],
  'Tees':    ['course_name', 'tee', 'course_rating', 'slope_rating', 'par', 'yardage', 'notes'],
  'Players': ['player_id', 'first_name', 'last_name', 'ngap_number',
              'handicap_index', 'default_tee', 'hi_updated', 'last_played', 'notes'],
  'App_Rounds': ['id', 'date', 'course_name', 'holes', 'game_type', 'game_options',
                 'pars', 'hole_handicaps', 'status', 'event_id', 'updated_at'],
  'App_Players': ['id', 'round_id', 'player_id', 'name', 'tee', 'course_rating',
                  'slope_rating', 'par', 'handicap_index', 'course_handicap',
                  'position'].concat(holeCols_('h')).concat(holeCols_('p')),
  'Settings': ['key', 'value']
};

var TEE_ORDER = ['Black', 'Gold', 'Blue', 'White', 'Silver', 'Red'];

// ── Entry point ────────────────────────────────────────────────────────────

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
    if (!secret) return json_({ ok: false, error: 'SHARED_SECRET not configured' });
    if (req.secret !== secret) return json_({ ok: false, error: 'unauthorized' });
    return json_({ ok: true, data: route_(req.action, req.payload || {}) });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function doGet() {
  return json_({ ok: true, data: { service: 'golf-dash', version: 2, status: 'up' } });
}

function route_(action, p) {
  switch (action) {
    case 'bootstrap':    return bootstrap_();
    case 'getRound':     return getRound_(p.roundId);
    case 'saveRound':    return saveRound_(p);
    case 'deleteRound':  return deleteRound_(p.roundId);
    case 'saveCourse':   return saveCourse_(p);
    case 'deleteCourse': return deleteCourse_(p.name);
    case 'saveTee':      return saveTee_(p);
    case 'deleteTee':    return deleteTee_(p.courseName, p.tee);
    case 'savePlayer':   return savePlayer_(p);
    case 'setSetting':   return setSetting_(p.key, p.value);
    default: throw new Error('Unknown action: ' + action);
  }
}

// ── Actions ────────────────────────────────────────────────────────────────

/** Everything the app needs on cold start, in one round trip. */
function bootstrap_() {
  var courses = readTable_(TAB.courses).filter(function (c) { return c.course_name; });
  var tees    = readTable_(TAB.tees).filter(function (t) { return t.course_name && t.tee; });

  // Nest tees under their course so the client never has to join them
  var byCourse = {};
  tees.forEach(function (t) {
    var k = String(t.course_name);
    if (!byCourse[k]) byCourse[k] = [];
    byCourse[k].push({
      tee: String(t.tee),
      course_rating: Number(t.course_rating) || 72,
      slope_rating: Number(t.slope_rating) || 113,
      par: Number(t.par) || 72,
      yardage: t.yardage === '' ? null : Number(t.yardage)
    });
  });
  Object.keys(byCourse).forEach(function (k) {
    byCourse[k].sort(function (a, b) {
      var ia = TEE_ORDER.indexOf(a.tee), ib = TEE_ORDER.indexOf(b.tee);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  });

  courses.forEach(function (c) { c.tees = byCourse[String(c.course_name)] || []; });

  return {
    courses: courses,
    players: readTable_(TAB.players)
      .filter(function (p) { return p.player_id; })
      .map(function (p) { p.default_tee = p.default_tee || ''; return p; })
      .sort(function (a, b) { return String(b.last_played).localeCompare(String(a.last_played)); }),
    rounds: readTable_(TAB.rounds),
    settings: readTable_(TAB.settings).reduce(function (acc, r) {
      if (r.key) acc[r.key] = r.value;
      return acc;
    }, {})
  };
}

function getRound_(roundId) {
  if (!roundId) throw new Error('roundId required');
  var round = findRow_(TAB.rounds, 'id', roundId);
  if (!round) throw new Error('Round not found: ' + roundId);
  var players = readTable_(TAB.rplayers)
    .filter(function (r) { return String(r.round_id) === String(roundId); })
    .map(unpackPlayer_)
    .sort(function (a, b) { return a.position - b.position; });
  return { round: round, players: players };
}

/**
 * Full upsert of a round and its players. Idempotent — the client owns the IDs
 * and can safely replay this after a failed sync.
 */
function saveRound_(p) {
  if (!p.round || !p.round.id) throw new Error('round.id required');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var round = p.round;
    round.updated_at = new Date().toISOString();
    upsertRow_(TAB.rounds, 'id', round.id, round);

    deleteRows_(TAB.rplayers, 'round_id', round.id);
    appendRows_(TAB.rplayers, (p.players || []).map(function (pl) {
      return packPlayer_(pl, round.id);
    }));

    if (p.complete) {
      touchRoster_(p.players || [], round.date);
      appendLogRow_(round, p.players || []);
    }
    return { id: round.id, updated_at: round.updated_at };
  } finally { lock.releaseLock(); }
}

function deleteRound_(roundId) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    deleteRows_(TAB.rplayers, 'round_id', roundId);
    deleteRows_(TAB.rounds, 'id', roundId);
    return { deleted: roundId };
  } finally { lock.releaseLock(); }
}

function saveCourse_(c) {
  if (!c.course_name) throw new Error('course_name required');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    upsertRow_(TAB.courses, 'course_name', c.course_name, {
      course_name: c.course_name, holes: c.holes || 18,
      pars: c.pars || '[]', hole_handicaps: c.hole_handicaps || '[]',
      notes: c.notes || ''
    });
    (c.tees || []).forEach(function (t) {
      saveTee_({ course_name: c.course_name, tee: t.tee, course_rating: t.course_rating,
                 slope_rating: t.slope_rating, par: t.par, yardage: t.yardage });
    });
    return c;
  } finally { lock.releaseLock(); }
}

/** Tees are keyed on course_name + tee, so we match on the pair. */
function saveTee_(t) {
  if (!t.course_name || !t.tee) throw new Error('course_name and tee required');
  var sh = sheet_(TAB.tees);
  var hRow = headerRow_(TAB.tees);
  var rows = readTable_(TAB.tees);
  var row = objToRow_(TAB.tees, {
    course_name: t.course_name, tee: t.tee,
    course_rating: t.course_rating, slope_rating: t.slope_rating,
    par: t.par, yardage: t.yardage == null ? '' : t.yardage, notes: t.notes || ''
  });

  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].course_name) === String(t.course_name) &&
        String(rows[i].tee) === String(t.tee)) {
      sh.getRange(hRow + 1 + i, 1, 1, row.length).setValues([row]);
      return t;
    }
  }
  sh.getRange(nextFreeRow_(sh, TAB.tees), 1, 1, row.length).setValues([row]);
  return t;
}

/** Delete a course and every tee belonging to it. */
function deleteCourse_(courseName) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = sheet_(TAB.tees);
    var hRow = headerRow_(TAB.tees);
    var rows = readTable_(TAB.tees);
    for (var i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i].course_name) === String(courseName)) sh.deleteRow(hRow + 1 + i);
    }
    deleteRows_(TAB.courses, 'course_name', courseName);
    return { deleted: courseName };
  } finally { lock.releaseLock(); }
}

function deleteTee_(courseName, tee) {
  var sh = sheet_(TAB.tees);
  var hRow = headerRow_(TAB.tees);
  var rows = readTable_(TAB.tees);
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].course_name) === String(courseName) &&
        String(rows[i].tee) === String(tee)) sh.deleteRow(hRow + 1 + i);
  }
  return { deleted: courseName + ' / ' + tee };
}

/** player_id is derived from the name, so the same person is one row forever. */
function playerId_(first, last) {
  return (String(first) + '-' + String(last))
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function savePlayer_(p) {
  var first = String(p.first_name || '').trim();
  var last = String(p.last_name || '').trim();
  if (!first) throw new Error('first_name required');

  var id = p.player_id || playerId_(first, last);
  var existing = findRow_(TAB.players, 'player_id', id) || {};

  var row = {
    player_id: id, first_name: first, last_name: last,
    ngap_number: p.ngap_number != null ? p.ngap_number : (existing.ngap_number || ''),
    handicap_index: p.handicap_index != null ? p.handicap_index : (existing.handicap_index || ''),
    default_tee: p.default_tee != null ? p.default_tee : (existing.default_tee || ''),
    hi_updated: p.handicap_index != null ? new Date().toISOString().slice(0, 10)
                                         : (existing.hi_updated || ''),
    last_played: existing.last_played || '',
    notes: p.notes != null ? p.notes : (existing.notes || '')
  };
  upsertRow_(TAB.players, 'player_id', id, row);
  return row;
}

/** After a completed round, record each player's index and last-played date. */
function touchRoster_(players, date) {
  players.forEach(function (pl) {
    if (!pl.name) return;
    var parts = String(pl.name).trim().split(/\s+/);
    var first = parts.shift();
    var last = parts.join(' ');
    var id = pl.player_id || playerId_(first, last);
    var existing = findRow_(TAB.players, 'player_id', id) || {};
    upsertRow_(TAB.players, 'player_id', id, {
      player_id: id, first_name: first, last_name: last,
      ngap_number: existing.ngap_number || '',
      handicap_index: pl.handicap_index != null ? pl.handicap_index : (existing.handicap_index || ''),
      // Remember the tee they actually played, so next round pre-fills it
      default_tee: pl.tee || existing.default_tee || '',
      hi_updated: pl.handicap_index != null ? new Date().toISOString().slice(0, 10)
                                            : (existing.hi_updated || ''),
      last_played: date || new Date().toISOString().slice(0, 10),
      notes: existing.notes || ''
    });
  });
}

function setSetting_(key, value) {
  if (!key) throw new Error('key required');
  upsertRow_(TAB.settings, 'key', key, { key: key, value: value });
  return { key: key, value: value };
}

// ── The human-readable log ─────────────────────────────────────────────────

/**
 * First free row on a tab whose later rows may contain ARRAYFORMULA output.
 * getLastRow() would land us below those blanks, leaving a gap.
 */
function nextLogRow_(sh) {
  var hRow = headerRow_(TAB.log);
  var dates = sh.getRange(hRow + 1, 1, sh.getMaxRows() - hRow, 1).getValues();
  for (var i = dates.length - 1; i >= 0; i--) {
    if (String(dates[i][0]).trim() !== '') return hRow + 2 + i;
  }
  return hRow + 1;
}

function nextFreeRow_(sh, name) {
  var hRow = headerRow_(name);
  var col = sh.getRange(hRow + 1, 1, Math.max(sh.getMaxRows() - hRow, 1), 1).getValues();
  for (var i = col.length - 1; i >= 0; i--) {
    if (String(col[i][0]).trim() !== '') return hRow + 2 + i;
  }
  return hRow + 1;
}

/** WHS Adjusted Gross Score — each hole capped at net double bogey. */
function adjustedGross_(player, pars, holeIdx, n) {
  if (!pars.length || !holeIdx.length) return '';
  var chcp = Number(player.course_handicap) || 0;
  var total = 0;
  for (var i = 0; i < n; i++) {
    var s = Number(player.strokes && player.strokes[i]);
    if (!s) return '';
    var par = Number(pars[i]) || 4;
    total += Math.min(s, par + 2 + strokesOnHole_(chcp, Number(holeIdx[i]) || (i + 1), n));
  }
  return total;
}

function strokesOnHole_(courseHandicap, holeIndex, totalHoles) {
  if (courseHandicap <= 0 || !holeIndex) return 0;
  var scale = totalHoles === 9 ? 9 : 18;
  return Math.floor(courseHandicap / scale) +
         (holeIndex <= (courseHandicap % scale) ? 1 : 0);
}

function prettyGame_(g) {
  var m = {
    best_ball: 'Best Ball', best_ball_pairs: 'Best Ball Pairs',
    high_low: 'High-Low', high_low_pairs: 'High-Low Pairs',
    match_play: 'Match Play', match_play_indiv: 'Match Play',
    niners: 'Niners', twelves: 'Twelves', skins: 'Skins',
    stableford: 'Stableford', nassau: 'Nassau'
  };
  return m[g] || g || '';
}

// ── Player row packing ─────────────────────────────────────────────────────

function packPlayer_(pl, roundId) {
  var o = {
    id: pl.id, round_id: roundId, player_id: pl.player_id || '',
    name: pl.name, tee: pl.tee || '',
    course_rating: pl.course_rating != null ? pl.course_rating : '',
    slope_rating: pl.slope_rating != null ? pl.slope_rating : '',
    par: pl.par != null ? pl.par : '',
    handicap_index: pl.handicap_index != null ? pl.handicap_index : '',
    course_handicap: pl.course_handicap != null ? pl.course_handicap : 0,
    position: pl.position
  };
  for (var i = 0; i < 18; i++) {
    o['h' + (i + 1)] = (pl.strokes && pl.strokes[i] != null) ? pl.strokes[i] : '';
    o['p' + (i + 1)] = (pl.putts && pl.putts[i] != null) ? pl.putts[i] : '';
  }
  return o;
}

function unpackPlayer_(row) {
  var strokes = [], putts = [];
  for (var i = 1; i <= 18; i++) {
    var s = row['h' + i], p = row['p' + i];
    strokes.push(s === '' || s == null ? null : Number(s));
    putts.push(p === '' || p == null ? null : Number(p));
  }
  return {
    id: row.id, round_id: row.round_id, player_id: row.player_id || '',
    name: row.name, tee: row.tee || '',
    course_rating: row.course_rating === '' ? null : Number(row.course_rating),
    slope_rating: row.slope_rating === '' ? null : Number(row.slope_rating),
    par: row.par === '' ? null : Number(row.par),
    handicap_index: row.handicap_index === '' ? null : Number(row.handicap_index),
    course_handicap: Number(row.course_handicap) || 0,
    position: Number(row.position) || 1,
    strokes: strokes, putts: putts
  };
}

// ── Sheet helpers ──────────────────────────────────────────────────────────

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing tab: ' + name + ' — run migrateToV2() once.');
  return sh;
}

function headerRow_(n) { return HEADER_ROW[n] || 1; }

function headers_(name) {
  var sh = sheet_(name), r = headerRow_(name);
  return sh.getRange(r, 1, 1, sh.getLastColumn()).getValues()[0]
           .map(function (h) { return String(h).trim(); });
}

function readTable_(name) {
  var sh = sheet_(name), hRow = headerRow_(name), last = sh.getLastRow();
  if (last <= hRow) return [];
  var hdr = headers_(name);
  return sh.getRange(hRow + 1, 1, last - hRow, hdr.length).getValues()
    .reduce(function (acc, row) {
      if (row.join('') === '') return acc;
      var o = {};
      for (var j = 0; j < hdr.length; j++) if (hdr[j]) o[hdr[j]] = row[j];
      acc.push(o);
      return acc;
    }, []);
}

function findRow_(name, keyCol, keyVal) {
  var rows = readTable_(name);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][keyCol]) === String(keyVal)) return rows[i];
  }
  return null;
}

function rowIndex_(name, keyCol, keyVal) {
  var sh = sheet_(name), hRow = headerRow_(name), last = sh.getLastRow();
  if (last <= hRow) return -1;
  var col = headers_(name).indexOf(keyCol) + 1;
  if (col === 0) throw new Error('No column "' + keyCol + '" in ' + name);
  var vals = sh.getRange(hRow + 1, col, last - hRow, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === String(keyVal)) return hRow + 1 + i;
  }
  return -1;
}

function objToRow_(name, obj) {
  return headers_(name).map(function (h) {
    return (obj[h] === undefined || obj[h] === null) ? '' : obj[h];
  });
}

function upsertRow_(name, keyCol, keyVal, obj) {
  var sh = sheet_(name), row = objToRow_(name, obj);
  var at = rowIndex_(name, keyCol, keyVal);
  if (at > 0) sh.getRange(at, 1, 1, row.length).setValues([row]);
  else sh.getRange(nextFreeRow_(sh, name), 1, 1, row.length).setValues([row]);
}

function appendRows_(name, objs) {
  if (!objs.length) return;
  var sh = sheet_(name);
  var rows = objs.map(function (o) { return objToRow_(name, o); });
  sh.getRange(nextFreeRow_(sh, name), 1, rows.length, rows[0].length).setValues(rows);
}

function deleteRows_(name, keyCol, keyVal) {
  var sh = sheet_(name), hRow = headerRow_(name), last = sh.getLastRow();
  if (last <= hRow) return;
  var col = headers_(name).indexOf(keyCol) + 1;
  if (col === 0) return;
  var vals = sh.getRange(hRow + 1, col, last - hRow, 1).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][0]) === String(keyVal)) sh.deleteRow(hRow + 1 + i);
  }
}

function safeJson_(v, fb) { try { return JSON.parse(v); } catch (e) { return fb; } }

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Migration and setup ────────────────────────────────────────────────────

/**
 * Run once from the editor. Non-destructive and safe to re-run:
 *   · creates any missing tabs
 *   · splits existing "Course - Tee" rows into Courses + Tees
 *   · adds the Tee column to the Rounds log
 *   · installs the Rounds-tab formulas so appended rows compute themselves
 */
function migrateToV2() {
  var ss = ss_();
  var report = [];

  // 1. Snapshot the old Courses tab before we reshape it
  var old = [];
  var oldSheet = ss.getSheetByName('Courses');
  if (oldSheet) {
    var hdr = oldSheet.getRange(4, 1, 1, oldSheet.getLastColumn()).getValues()[0]
      .map(function (h) { return String(h).trim(); });
    if (hdr.indexOf('name') >= 0 && oldSheet.getLastRow() > 4) {
      oldSheet.getRange(5, 1, oldSheet.getLastRow() - 4, hdr.length).getValues()
        .forEach(function (r) {
          if (String(r[0]).trim() === '') return;
          var o = {};
          for (var j = 0; j < hdr.length; j++) if (hdr[j]) o[hdr[j]] = r[j];
          old.push(o);
        });
      oldSheet.setName('Courses_v1_backup');
      report.push('Backed up ' + old.length + ' old course rows to Courses_v1_backup');
    }
  }

  // 2. Create every tab with the v2 headers
  ['Courses', 'Tees', 'Players', 'App_Rounds', 'App_Players', 'Settings']
    .forEach(function (name) {
      var sh = ss.getSheetByName(name) || ss.insertSheet(name);
      var hRow = headerRow_(name);
      if (hRow > 1) {
        sh.getRange(1, 1, 1, 1).setValue(name).setFontSize(14)
          .setFontWeight('bold').setFontColor('#1d5c3a');
      }
      var h = HEADERS[name];
      sh.getRange(hRow, 1, 1, h.length).setValues([h])
        .setFontWeight('bold').setBackground('#1d5c3a').setFontColor('#ffffff');
      sh.setFrozenRows(hRow);
      report.push('Tab ready: ' + name);
    });

  // 3. Split "Wack Wack East - Blue" into a course row and a tee row
  old.forEach(function (c) {
    var full = String(c.name).trim();
    var m = full.match(/^(.*?)\s*[-–]\s*([A-Za-z]+)$/);
    var courseName = m ? m[1].trim() : full;
    var tee = m && TEE_ORDER.indexOf(cap_(m[2])) >= 0 ? cap_(m[2]) : 'Blue';

    upsertRow_('Courses', 'course_name', courseName, {
      course_name: courseName, holes: c.holes || 18,
      pars: c.pars || '[]', hole_handicaps: c.hole_handicaps || '[]',
      notes: 'Migrated from "' + full + '"'
    });
    saveTee_({
      course_name: courseName, tee: tee,
      course_rating: c.course_rating, slope_rating: c.slope_rating,
      par: c.par, yardage: ''
    });
    report.push('Migrated: ' + full + '  →  ' + courseName + ' / ' + tee);
  });

  // 4. Rounds log: add Tee, then install the formulas
  ensureLogTeeColumn_();
  installLogFormulas_();
  report.push('Rounds log formulas installed');

  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SHARED_SECRET')) {
    props.setProperty('SHARED_SECRET', Utilities.getUuid() + Utilities.getUuid());
    report.push('SHARED_SECRET generated: ' + props.getProperty('SHARED_SECRET'));
  }

  Logger.log(report.join('\n'));
  return report;
}

function cap_(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1).toLowerCase();
}

/** Insert a Tee column after Course on the Rounds log, if absent. */
function ensureLogTeeColumn_() {
  var sh = sheet_(TAB.log);
  var hdr = headers_(TAB.log);
  if (hdr.indexOf('Tee') >= 0) return;
  var courseAt = hdr.indexOf('Course');
  if (courseAt < 0) throw new Error('Rounds tab has no Course column');
  sh.insertColumnAfter(courseAt + 1);
  sh.getRange(headerRow_(TAB.log), courseAt + 2).setValue('Tee')
    .setFontWeight('bold').setBackground('#1d5c3a').setFontColor('#ffffff');
  sh.setColumnWidth(courseAt + 2, 70);
}

/**
 * Install ARRAYFORMULAs in the header cells of every computed column, so rows
 * appended by the app compute themselves.
 *
 * Uses VLOOKUP against a virtual {course|tee, value} array rather than
 * INDEX/MATCH: INDEX does not array-expand in Google Sheets, so the earlier
 * version silently returned blank for every row.
 */
function installLogFormulas_() {
  var sh = sheet_(TAB.log);
  var hRow = headerRow_(TAB.log);
  var hdr = headers_(TAB.log);

  function L(name) {
    var i = hdr.indexOf(name);
    if (i < 0) throw new Error('Rounds tab missing column: ' + name);
    return columnLetter_(i + 1);
  }

  var date = L('Date'), course = L('Course'), tee = L('Tee'), holes = L('Holes');
  var cr = L('Course Rating'), slope = L('Slope'), par = L('Par');
  var hi = L('HI at Play'), chcp = L('Course HCP');
  var gross = L('Gross'), adj = L('Adj. Gross');
  var net = L('Net'), toPar = L('+/- Par');
  var diff = L('Score Diff.'), rec = L('Recency'), last20 = L('In Last 20');

  var r0 = hRow + 1;
  function col(c) { return c + r0 + ':' + c; }

  var lookupKey = col(course) + '&"|"&' + col(tee);

  [cr, slope, par, chcp, net, toPar, diff, rec, last20].forEach(function (c) {
    sh.getRange(c + r0 + ':' + c).clearContent();
  });

  function set(c, title, expr) {
    sh.getRange(c + hRow).setFormula('={"' + title + '"; ARRAYFORMULA(' + expr + ')}');
  }

  /** Tees columns: C = course_rating, D = slope_rating, E = par. */
  function teeLookup(valueCol) {
    return 'IFERROR(IF(' + col(course) + '="","",' +
           'IFERROR(VLOOKUP(' + lookupKey + ',' +
           '{Tees!$A$5:$A&"|"&Tees!$B$5:$B,Tees!$' + valueCol + '$5:$' + valueCol +
           '},2,FALSE),"")),"")';
  }

  set(cr, 'Course Rating', teeLookup('C'));
  set(slope, 'Slope', teeLookup('D'));
  set(par, 'Par', teeLookup('E'));

  set(chcp, 'Course HCP',
    'IFERROR(IF((' + col(hi) + '="")+(' + col(slope) + '="")+(' + col(cr) + '="")+(' +
    col(par) + '=""),"",ROUND(' + col(hi) + '*(' + col(slope) + '/113)+(' +
    col(cr) + '-' + col(par) + '),0)),"")');

  set(net, 'Net',
    'IFERROR(IF((' + col(gross) + '="")+(' + col(chcp) + '=""),"",' +
    col(gross) + '-' + col(chcp) + '),"")');

  set(toPar, '+/- Par',
    'IFERROR(IF((' + col(gross) + '="")+(' + col(par) + '=""),"",' +
    col(gross) + '-' + col(par) + '),"")');

  set(diff, 'Score Diff.',
    'IFERROR(IF((' + col(adj) + '="")+(' + col(slope) + '="")+(' + col(cr) + '="")+(' +
    col(holes) + '<>18),"",ROUND((113/' + col(slope) + ')*(' + col(adj) + '-' +
    col(cr) + '-Handicap!$B$4),1)),"")');

  set(rec, 'Recency',
    'IF(' + col(diff) + '="","",COUNTIFS(' + col(date) + ',">="&' + col(date) + ',' +
    col(diff) + ',"<>"))');

  set(last20, 'In Last 20',
    'IF(' + col(rec) + '="","",IF(' + col(rec) + '<=20,' + col(diff) + ',""))');
}

/** Reinstall the Rounds-tab formulas without re-running the full migration. */
function fixLogFormulas() {
  installLogFormulas_();
  Logger.log('Rounds log formulas reinstalled.');
}

function columnLetter_(n) {
  var s = '';
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = (n - m - 1) / 26;
  }
  return s;
}
/**
 * ── NGAP handicap lookup ───────────────────────────────────────────────────
 * Paste this block at the bottom of Code.gs.
 *
 * Uses the passport-id + member-code pair from a public golf-profile link, so
 * no password is stored anywhere. Apps Script calls NGAP server-side, which
 * also sidesteps the CORS wall a browser would hit.
 */

var NGAP_HI_URL = 'https://ngapwhs.com/api/Score/GetMemberHandicapIndex';

/**
 * STEP 1 — run this from the editor first.
 * It prints the raw response so we can see the field names before parsing.
 * Replace the two values with yours from the golf-profile URL:
 *   .../golf-profile?passportid=XXXXX&code=YYYYYYYYYY
 */
function testNgapLookup() {
  var out = ngapFetchRaw_('35257', '1694545436');
  Logger.log('HTTP ' + out.code);
  Logger.log(out.body.slice(0, 1500));
  return out;
}

function ngapFetchRaw_(passportId, memberCode) {
  var res = UrlFetchApp.fetch(NGAP_HI_URL, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: {
      'Accept': '*/*',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://ngapwhs.com/golf-profile?passportid=' +
                 encodeURIComponent(passportId) + '&code=' +
                 encodeURIComponent(memberCode) + '&mode=view'
    },
    payload: JSON.stringify({
      MemberId: '',
      OtherPassportId: String(passportId),
      OtherPassportMemberCode: String(memberCode)
    }),
    muteHttpExceptions: true,
    followRedirects: true
  });
  return { code: res.getResponseCode(), body: res.getContentText() };
}

/**
 * Pull an index and write it to the Players tab (or Settings, for yourself).
 * Field names are guessed from the page's Angular bindings; the fallback scan
 * catches whatever the API actually calls it.
 */
function ngapHandicap_(p) {
  var passportId = p.passportId || p.passport_id;
  var memberCode = p.memberCode || p.member_code;
  if (!passportId || !memberCode) throw new Error('passportId and memberCode required');

  var out = ngapFetchRaw_(passportId, memberCode);
  if (out.code !== 200) throw new Error('NGAP returned HTTP ' + out.code);

  var data;
  try { data = JSON.parse(out.body); }
  catch (e) { throw new Error('NGAP did not return JSON — the endpoint may have changed'); }

  var hi = pickHandicap_(data);
  if (hi == null) throw new Error('No handicap index found in the response');

  if (p.playerId) {
    var existing = findRow_(TAB.players, 'player_id', p.playerId) || {};
    upsertRow_(TAB.players, 'player_id', p.playerId, {
      player_id: p.playerId,
      first_name: existing.first_name || '',
      last_name: existing.last_name || '',
      ngap_number: existing.ngap_number || '',
      handicap_index: hi,
      default_tee: existing.default_tee || '',
      hi_updated: new Date().toISOString().slice(0, 10),
      last_played: existing.last_played || '',
      notes: existing.notes || ''
    });
  } else {
    setSetting_('handicap_index', hi);
    setSetting_('handicap_index_updated', new Date().toISOString().slice(0, 10));
  }

  return { handicapIndex: hi, name: pickName_(data), fetched: new Date().toISOString() };
}

/** Walk the response looking for a plausible handicap field. */
function pickHandicap_(data) {
  var keys = ['HandicapIndex', 'handicapIndex', 'Handicap', 'Index', 'CurrentHandicapIndex'];
  var found = null;

  function walk(node, depth) {
    if (found != null || node == null || depth > 6) return;
    if (Array.isArray(node)) { node.forEach(function (n) { walk(n, depth + 1); }); return; }
    if (typeof node !== 'object') return;
    for (var i = 0; i < keys.length; i++) {
      var v = node[keys[i]];
      if (v != null && v !== '' && !isNaN(parseFloat(v))) { found = parseFloat(v); return; }
    }
    Object.keys(node).forEach(function (k) { walk(node[k], depth + 1); });
  }

  walk(data, 0);
  return found;
}

function pickName_(data) {
  var found = '';
  function walk(node, depth) {
    if (found || node == null || depth > 6) return;
    if (Array.isArray(node)) { node.forEach(function (n) { walk(n, depth + 1); }); return; }
    if (typeof node !== 'object') return;
    if (node.Name && typeof node.Name === 'string') { found = node.Name; return; }
    Object.keys(node).forEach(function (k) { walk(node[k], depth + 1); });
  }
  walk(data, 0);
  return found;
}

/**
 * ── Derived round statistics ───────────────────────────────────────────────
 *
 * Everything here comes from strokes + putts + pars, which you already record.
 * The trick: strokes − putts is how many shots it took to reach the green, so
 * a green in regulation is simply (strokes − putts) <= par − 2. No extra taps
 * on the course.
 *
 * Run ensureStatColumns_() once from the editor to add the new columns, then
 * fixLogFormulas() to reinstall the formulas around them.
 */

/** Columns added to the Rounds log, in order, after Penalties. */
var STAT_COLUMNS = ['GIR', 'Putts/GIR', '3-Putts', '1-Putts', 'Scramble %',
                    'Par 3 avg', 'Par 4 avg', 'Par 5 avg', 'Pars+'];

function ensureStatColumns_() {
  var sh = sheet_(TAB.log);
  var hRow = headerRow_(TAB.log);
  var added = [];

  STAT_COLUMNS.forEach(function (name) {
    var hdr = headers_(TAB.log);
    if (hdr.indexOf(name) >= 0) return;

    // Insert just before Notes so the helper columns stay at the far right
    var anchor = hdr.indexOf('Notes');
    if (anchor < 0) anchor = hdr.length;
    sh.insertColumnBefore(anchor + 1);
    sh.getRange(hRow, anchor + 1).setValue(name)
      .setFontWeight('bold').setBackground('#1d5c3a').setFontColor('#ffffff');
    sh.setColumnWidth(anchor + 1, 72);
    added.push(name);
  });

  Logger.log(added.length ? 'Added: ' + added.join(', ') : 'All stat columns already present');
  return added;
}

/**
 * Compute every derived statistic for one player's round.
 * Returns nulls where there isn't enough data rather than guessing.
 */
function roundStats_(strokes, putts, pars, n) {
  var s = { gross: 0, putts: 0, holes: 0, gir: 0, puttsOnGir: 0,
            threePutts: 0, onePutts: 0, scrambleAtt: 0, scrambleOk: 0,
            parsOrBetter: 0, byPar: {} };
  var havePutts = false;

  for (var i = 0; i < n; i++) {
    var st = Number(strokes[i]);
    var par = Number(pars[i]);
    if (!st || !par) continue;

    var pt = putts[i] == null || putts[i] === '' ? null : Number(putts[i]);
    if (pt != null && pt > 0) havePutts = true;

    s.holes++;
    s.gross += st;
    if (st <= par) s.parsOrBetter++;

    if (!s.byPar[par]) s.byPar[par] = { n: 0, total: 0 };
    s.byPar[par].n++;
    s.byPar[par].total += st;

    if (pt == null) continue;
    s.putts += pt;
    if (pt >= 3) s.threePutts++;
    if (pt === 1) s.onePutts++;

    // Shots to reach the green, and therefore GIR
    var toGreen = st - pt;
    if (toGreen <= par - 2) {
      s.gir++;
      s.puttsOnGir += pt;
    } else {
      s.scrambleAtt++;
      if (st <= par) s.scrambleOk++;
    }
  }

  return {
    gross: s.gross,
    putts: havePutts ? s.putts : null,
    gir: havePutts ? s.gir : null,
    puttsPerGir: havePutts && s.gir ? round1_(s.puttsOnGir / s.gir) : null,
    threePutts: havePutts ? s.threePutts : null,
    onePutts: havePutts ? s.onePutts : null,
    scramblePct: havePutts && s.scrambleAtt
      ? round1_(100 * s.scrambleOk / s.scrambleAtt) : null,
    parsOrBetter: s.parsOrBetter,
    par3avg: avgFor_(s.byPar, 3),
    par4avg: avgFor_(s.byPar, 4),
    par5avg: avgFor_(s.byPar, 5)
  };
}

function avgFor_(byPar, p) {
  return byPar[p] && byPar[p].n ? round1_(byPar[p].total / byPar[p].n) : null;
}

function round1_(v) { return Math.round(v * 10) / 10; }

// ── The human-readable log ─────────────────────────────────────────────────

function appendLogRow_(round, players) {
  var me = players.filter(function (pl) { return pl.position === 1; })[0];
  if (!me) return;

  var pars = safeJson_(round.pars, []);
  var idx  = safeJson_(round.hole_handicaps, []);
  var n    = Number(round.holes) || 18;

  var st = roundStats_(me.strokes || [], me.putts || [], pars, n);
  if (st.holes === 0) return;

  // Only log complete rounds — a partial one would skew the handicap
  var played = 0;
  for (var i = 0; i < n; i++) if (me.strokes && me.strokes[i]) played++;
  if (played < n) return;

  var sh  = sheet_(TAB.log);
  var hdr = headers_(TAB.log);
  var row = new Array(hdr.length).fill('');
  var writeCols = [];

  function put(name, v) {
    var i = hdr.indexOf(name);
    if (i >= 0 && v !== null && v !== undefined) { row[i] = v; writeCols.push(i); }
  }

  put('Date', round.date);
  put('Course', round.course_name);
  put('Tee', me.tee || '');
  put('Holes', n);
  put('HI at Play', me.handicap_index);
  put('Gross', st.gross);
  put('Adj. Gross', adjustedGross_(me, pars, idx, n));
  put('Putts', st.putts);
  put('GIR', st.gir);
  put('GIR /18', st.gir);
  put('Putts/GIR', st.puttsPerGir);
  put('3-Putts', st.threePutts);
  put('1-Putts', st.onePutts);
  put('Scramble %', st.scramblePct == null ? null : st.scramblePct / 100);
  put('Par 3 avg', st.par3avg);
  put('Par 4 avg', st.par4avg);
  put('Par 5 avg', st.par5avg);
  put('Pars+', st.parsOrBetter);
  put('Game', prettyGame_(round.game_type));
  put('Partners', players.filter(function (p) { return p.position !== 1; })
                         .map(function (p) { return p.name; }).join(', '));

  // Write each value individually rather than the whole row: the computed
  // columns hold ARRAYFORMULA output, and writing even a blank into them
  // would block the array from expanding.
  var r = nextLogRow_(sh);
  writeCols.forEach(function (c) {
    sh.getRange(r, c + 1).setValue(row[c]);
  });
}
