/**
 * client/src/lib/queryClient.ts
 *
 * Drop-in replacement. Same exports as before (apiRequest, getQueryFn,
 * queryClient), so every existing page keeps working untouched.
 *
 * Underneath, /api/* no longer hits an Express server. Requests are answered
 * from IndexedDB and synced to a Google Sheet via Apps Script in the
 * background. Score entry is a local write and works with no signal.
 *
 * Requires two env vars in client/.env.local:
 *   VITE_APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec
 *   VITE_APPS_SCRIPT_SECRET=<the secret from Script Properties>
 */

import { QueryClient, QueryFunction } from "@tanstack/react-query";

// ── Backend configuration ──────────────────────────────────────────────────
// Deliberately NOT baked into the build. A GitHub Pages site is public, so a
// secret compiled into the bundle is readable by anyone who finds the URL.
// Instead each device is configured once and the values live in localStorage.
// The env vars remain as a convenience for local development.

const CFG_KEY = "golf-dash-backend";

function readConfig(): { url: string; secret: string } {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      if (c.url && c.secret) return c;
    }
  } catch { /* fall through to env */ }
  return {
    url: (import.meta.env.VITE_APPS_SCRIPT_URL as string) || "",
    secret: (import.meta.env.VITE_APPS_SCRIPT_SECRET as string) || "",
  };
}

/** Store this device's backend details. Call from the console or a settings UI. */
export function configureBackend(url: string, secret: string): void {
  localStorage.setItem(CFG_KEY, JSON.stringify({ url: url.trim(), secret: secret.trim() }));
  location.reload();
}

export function isConfigured(): boolean {
  const c = readConfig();
  return !!(c.url && c.secret);
}

export function clearBackendConfig(): void {
  localStorage.removeItem(CFG_KEY);
  location.reload();
}

if (typeof window !== "undefined") {
  // Reachable from DevTools on any device: configureBackend("<url>", "<secret>")
  (window as any).configureBackend = configureBackend;
  (window as any).clearBackendConfig = clearBackendConfig;
}

let promptShown = false;

/** Ask once, on first real use, rather than blocking module load. */
function ensureConfig(): { url: string; secret: string } {
  const c = readConfig();
  if (c.url && c.secret) return c;
  if (!promptShown && typeof window !== "undefined") {
    promptShown = true;
    const url = window.prompt("Golf Dash setup — paste your Apps Script Web App URL (ends in /exec):");
    if (url) {
      const secret = window.prompt("Now paste your shared secret:");
      if (secret) configureBackend(url, secret);
    }
  }
  throw new Error("Backend not configured on this device");
}

// ── Types (camelCase — what the pages already expect) ───────────────────────

export interface Tee {
  tee: string; courseRating: number; slopeRating: number; par: number;
  yardage: number | null;
}
export interface Course {
  id: string; name: string; holes: number; courseRating: number;
  slopeRating: number; par: number; pars: string; holeHandicaps: string;
  tees: Tee[];
}
export interface RosterPlayer {
  playerId: string; firstName: string; lastName: string; fullName: string;
  ngapNumber: string; handicapIndex: number | null; defaultTee: string;
  hiUpdated: string; lastPlayed: string;
}
export interface Round {
  id: string; courseId: string | null; courseName: string;
  courseRating: number | null; slopeRating: number | null; date: string;
  holes: number; par: number | null; gameType: string; gameOptions: string;
  status: string; pars?: string; holeHandicaps?: string;
}
export interface RoundPlayer {
  id: string; roundId: string; name: string;
  handicapIndex: number | null; courseHandicap: number; position: number;
  playerId?: string; tee?: string;
  courseRating?: number | null; slopeRating?: number | null; par?: number | null;
}
export interface HoleScore {
  id: string; roundId: string; playerId: string;
  hole: number; strokes: number | null; putts: number | null;
}
interface Bundle { round: Round; players: RoundPlayer[]; scores: HoleScore[]; }
interface Stored extends Bundle { dirty: boolean; touched: string; }

// ── IndexedDB ──────────────────────────────────────────────────────────────

const DB = "golf-dash", ROUNDS = "rounds", META = "meta";
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(ROUNDS)) d.createObjectStore(ROUNDS, { keyPath: "round.id" });
      if (!d.objectStoreNames.contains(META)) d.createObjectStore(META);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function op<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return db().then(d => new Promise<T>((res, rej) => {
    const rq = fn(d.transaction(store, mode).objectStore(store));
    rq.onsuccess = () => res(rq.result as T);
    rq.onerror = () => rej(rq.error);
  }));
}

const allRounds = () => op<Stored[]>(ROUNDS, "readonly", s => s.getAll());
const getStored = (id: string) => op<Stored | undefined>(ROUNDS, "readonly", s => s.get(id));
const putStored = (v: Stored) => op<void>(ROUNDS, "readwrite", s => s.put(v));
const delStored = (id: string) => op<void>(ROUNDS, "readwrite", s => s.delete(id));
const metaGet = <T>(k: string) => op<T | undefined>(META, "readonly", s => s.get(k));
const metaPut = (k: string, v: unknown) => op<void>(META, "readwrite", s => s.put(v, k));

// ── Transport ──────────────────────────────────────────────────────────────
// No Content-Type header, deliberately: that keeps this a CORS "simple
// request" and avoids a preflight, which Apps Script cannot answer.

async function call<T>(action: string, payload: unknown = {}): Promise<T> {
  const cfg = ensureConfig();
  const r = await fetch(cfg.url, {
    method: "POST",
    body: JSON.stringify({ secret: cfg.secret, action, payload }),
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`${action}: HTTP ${r.status}`);
  const b = await r.json();
  if (!b.ok) throw new Error(`${action}: ${b.error}`);
  return b.data as T;
}

/**
 * WHS Course Handicap = HI x (Slope / 113) + (Course Rating - Par).
 * The (CR - Par) term is what makes mixed tees work: a player off an easier tee
 * gets fewer strokes automatically, with no separate adjustment.
 */
export function courseHandicapFor(
  hi: number | null, slope: number | null,
  courseRating: number | null, par: number | null,
): number {
  if (hi == null || slope == null || courseRating == null || par == null) return 0;
  return Math.round(hi * (slope / 113) + (courseRating - par));
}

export const newId = () =>
  crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// ── Sync queue ─────────────────────────────────────────────────────────────

let syncing = false;
const watchers = new Set<(n: number) => void>();

export function onSyncChange(fn: (n: number) => void) {
  watchers.add(fn);
  void pending().then(fn);
  return () => { watchers.delete(fn); };
}

const pending = async () => (await allRounds()).filter(r => r.dirty).length;
const announce = async () => { const n = await pending(); watchers.forEach(f => f(n)); };

export async function flush(): Promise<void> {
  if (syncing || !navigator.onLine || !isConfigured()) return;
  syncing = true;
  try {
    for (const local of (await allRounds()).filter(r => r.dirty)) {
      try {
        await call("saveRound", {
          round: toSheetRound(local.round),
          players: local.players.map(p => toSheetPlayer(p, local.scores)),
          complete: local.round.status === "complete",
        });
        const now = await getStored(local.round.id);
        // Only clear the flag if nothing changed while the request was in flight
        if (now && now.touched === local.touched) await putStored({ ...now, dirty: false });
      } catch (e) {
        console.warn("[sync] deferred", local.round.id, e);
        break;
      }
    }
  } finally { syncing = false; await announce(); }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => { void flush(); });
  setInterval(() => { void flush(); }, 60_000);
}

// ── Shape conversion ───────────────────────────────────────────────────────

function toSheetRound(r: Round) {
  return {
    id: r.id, date: r.date, course_name: r.courseName,
    holes: r.holes, game_type: r.gameType,
    game_options: r.gameOptions, pars: r.pars ?? "[]",
    hole_handicaps: r.holeHandicaps ?? "[]", status: r.status,
  };
}

function toSheetPlayer(p: RoundPlayer, scores: HoleScore[]) {
  const strokes: (number | null)[] = Array(18).fill(null);
  const putts: (number | null)[] = Array(18).fill(null);
  scores.filter(s => s.playerId === p.id).forEach(s => {
    if (s.hole >= 1 && s.hole <= 18) {
      strokes[s.hole - 1] = s.strokes;
      putts[s.hole - 1] = s.putts;
    }
  });
  return {
    id: p.id, player_id: p.playerId ?? "", name: p.name,
    tee: p.tee ?? "",
    course_rating: p.courseRating ?? "", slope_rating: p.slopeRating ?? "",
    par: p.par ?? "",
    handicap_index: p.handicapIndex,
    course_handicap: p.courseHandicap, position: p.position, strokes, putts,
  };
}

function fromSheetCourse(c: any): Course {
  const tees: Tee[] = (c.tees || []).map((t: any) => ({
    tee: String(t.tee),
    courseRating: Number(t.course_rating) || 72,
    slopeRating: Number(t.slope_rating) || 113,
    par: Number(t.par) || 72,
    yardage: t.yardage == null ? null : Number(t.yardage),
  }));
  // The first tee doubles as the course default, so older code paths that read
  // a single rating off the course keep working.
  const d = tees[0];
  return {
    id: String(c.course_name), name: String(c.course_name),
    holes: Number(c.holes) || 18,
    courseRating: d ? d.courseRating : 72,
    slopeRating: d ? d.slopeRating : 113,
    par: d ? d.par : 72,
    pars: String(c.pars || "[]"),
    holeHandicaps: String(c.hole_handicaps || "[]"),
    tees,
  };
}

function toSheetCourse(c: Partial<Course>) {
  const tees = (c.tees && c.tees.length ? c.tees : [{
    tee: "Blue",
    courseRating: c.courseRating ?? 72,
    slopeRating: c.slopeRating ?? 113,
    par: c.par ?? 72,
    yardage: null,
  }]).map(t => ({
    tee: t.tee, course_rating: t.courseRating,
    slope_rating: t.slopeRating, par: t.par, yardage: t.yardage,
  }));
  return {
    course_name: c.name, holes: c.holes ?? 18,
    pars: c.pars ?? "[]", hole_handicaps: c.holeHandicaps ?? "[]",
    tees,
  };
}

function fromSheetRoster(p: any): RosterPlayer {
  const first = String(p.first_name || "").trim();
  const last = String(p.last_name || "").trim();
  return {
    playerId: String(p.player_id),
    firstName: first, lastName: last,
    fullName: [first, last].filter(Boolean).join(" "),
    ngapNumber: String(p.ngap_number || ""),
    handicapIndex: p.handicap_index === "" || p.handicap_index == null
      ? null : Number(p.handicap_index),
    defaultTee: String(p.default_tee || ""),
    hiUpdated: String(p.hi_updated || ""),
    lastPlayed: String(p.last_played || ""),
  };
}

// ── Cached reference data ──────────────────────────────────────────────────

interface Cache {
  courses: Course[]; players: RosterPlayer[]; settings: Record<string, string>;
}

async function cache(force = false): Promise<Cache> {
  const held = await metaGet<Cache>("cache");
  if (held && !force) { void refreshCache(); return held; }
  return (await refreshCache()) ?? held ?? { courses: [], players: [], settings: {} };
}

async function refreshCache(): Promise<Cache | null> {
  try {
    const d = await call<{ courses: any[]; players: any[]; settings: Record<string, string> }>("bootstrap");
    const next: Cache = {
      courses: (d.courses || []).map(fromSheetCourse),
      players: (d.players || []).map(fromSheetRoster),
      settings: d.settings || {},
    };
    await metaPut("cache", next);
    return next;
  } catch (e) {
    console.warn("[cache] offline, using stored copy", e);
    return null;
  }
}

// ── Fake Response, so callers can keep doing .json() ────────────────────────

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

// ── Router ─────────────────────────────────────────────────────────────────

export async function apiRequest(method: string, url: string, data?: unknown): Promise<Response> {
  const path = url.split("?")[0].replace(/\/+$/, "");
  const seg = path.split("/").filter(Boolean);   // ["api","rounds","<id>",...]
  const body: any = data ?? {};

  if (seg[0] !== "api") throw new Error(`Unrouted request: ${method} ${url}`);

  // ── courses ──
  if (seg[1] === "courses") {
    const c = await cache();

    if (method === "GET" && seg.length === 2) return reply(c.courses);

    if (method === "GET" && seg[3] === "ghost") return reply(await ghost(seg[2]));

    if (method === "POST" && seg.length === 2) {
      const course = fromSheetCourse(toSheetCourse(body));
      await call("saveCourse", toSheetCourse(course));
      await refreshCache();
      return reply(course);
    }
    if (method === "PATCH" && seg.length === 3) {
      const existing = c.courses.find(x => x.id === seg[2]);
      if (!existing) return reply({ error: "Course not found" }, 404);
      const merged = { ...existing, ...body };
      await call("saveCourse", toSheetCourse(merged));
      await refreshCache();
      return reply(merged);
    }
    if (method === "DELETE" && seg.length === 3) {
      await call("deleteCourse", { name: seg[2] });
      await refreshCache();
      return reply({ ok: true });
    }
  }

  // ── trends and ghost rounds (backend-computed) ──
  if (seg[1] === "trends" && method === "GET") {
    const held = await metaGet<any>("trends");
    try {
      const fresh = await call<any>("trends");
      await metaPut("trends", fresh);
      return reply(fresh);
    } catch (e) {
      // Offline: serve the last copy rather than an empty chart
      if (held) return reply(held);
      return reply({ ngap: [], app: [], currentIndex: null, lowIndex: null, ngapSynced: null });
    }
  }

  if (seg[1] === "ghost" && method === "GET") {
    const courseName = decodeURIComponent(seg[2] || "");
    const mode = url.includes("mode=recent") ? "recent" : "best";
    try {
      const r = await call<any>("ghost", { courseName, mode });
      // The backend sends bare numbers; the UI needs {strokes, roundDate}
      const scores: Record<number, { strokes: number; roundDate: string }> = {};
      Object.entries(r.scores || {}).forEach(([h, v]) => {
        scores[Number(h)] = typeof v === "number"
          ? { strokes: v, roundDate: r.label ?? "" }
          : (v as any);
      });
      return reply({ ...r, scores });
    } catch {
      return reply({ scores: {}, roundCount: 0, label: null });
    }
  }

  // ── players roster ──
  if (seg[1] === "players") {
    if (method === "GET") return reply((await cache()).players);
    if (method === "POST") {
      const saved = await call<any>("savePlayer", {
        first_name: body.firstName ?? body.first_name,
        last_name: body.lastName ?? body.last_name,
        ngap_number: body.ngapNumber ?? body.ngap_number ?? "",
        handicap_index: body.handicapIndex ?? body.handicap_index ?? null,
      });
      await refreshCache();
      return reply(fromSheetRoster(saved));
    }
  }

  // ── settings ──
  if (seg[1] === "settings" && seg[2]) {
    const c = await cache();
    if (method === "GET") return reply({ key: seg[2], value: c.settings[seg[2]] ?? null });
    if (method === "PATCH" || method === "PUT") {
      const value = String(body.value ?? "");
      await call("setSetting", { key: seg[2], value });
      await metaPut("cache", { ...c, settings: { ...c.settings, [seg[2]]: value } });
      return reply({ key: seg[2], value });
    }
  }

  // ── rounds ──
  if (seg[1] === "rounds") {
    if (method === "GET" && seg.length === 2) return reply(await listRounds());

    if (method === "GET" && seg[2] === "justin") {
      // Pull down any completed rounds this device hasn't seen, so stats and
      // the round list match across phone and laptop.
      try {
        const remote = await call<{ rounds: any[] }>("bootstrap");
        for (const r of (remote.rounds || [])) {
          if (String(r.status) !== "complete") continue;
          if (await getStored(String(r.id))) continue;
          await load(String(r.id));      // fetches players and scores, caches locally
        }
      } catch { /* offline — use what we have */ }

      const bundles = await allRounds();
      return reply(bundles.map(s2 => {
        const me = s2.players.find(p => p.position === 1);
        if (!me) return null;
        return {
          round: s2.round,
          players: [me],
          scores: s2.scores.filter(x => x.playerId === me.id),
        };
      }).filter(Boolean));
    }

    if (method === "POST" && seg.length === 2) return reply(await createRound(body));

    const id = seg[2];

    if (method === "GET" && seg.length === 3) {
      const s = await load(id);
      return s ? reply({ round: s.round, players: s.players, scores: s.scores })
               : reply({ error: "Round not found" }, 404);
    }

    if (method === "DELETE" && seg.length === 3) {
      await delStored(id);
      await announce();
      try { await call("deleteRound", { roundId: id }); } catch { /* replayed later */ }
      return reply({ ok: true });
    }

    if (method === "PUT" && seg[3] === "scores") return reply(await setScore(id, body));

    if (method === "PATCH" && seg.length === 4) {
      const patch: Partial<Round> =
        seg[3] === "status" ? { status: body.status } :
        seg[3] === "game"   ? { gameType: body.gameType, gameOptions: body.gameOptions } :
        seg[3] === "date"   ? { date: body.date } :
        seg[3] === "holeHandicaps" ? { holeHandicaps: body.holeHandicaps } : {};
      return reply(await patchRound(id, patch));
    }

    if (seg[3] === "players") {
      if (method === "POST") return reply(await addPlayer(id, body));
      if (method === "DELETE" && seg[4]) return reply(await removePlayer(id, seg[4]));
      if (method === "PATCH" && seg[4]) return reply(await patchPlayer(id, seg[4], body));
    }
  }

  // ── NGAP — no scraper any more; the index lives in Settings ──
  if (seg[1] === "ngap") {
    if (path.endsWith("/sync/status")) return reply({ status: "idle", message: "Manual entry" });
    if (method === "POST") {
      const c = await cache();
      const hi = c.settings["handicap_index"];
      return reply({ ok: !!hi, handicapIndex: hi ? Number(hi) : null,
                     message: hi ? `Handicap Index ${hi}` : "Set your index in Settings" });
    }
  }

  // ── import — now handled in the Sheet itself ──
  if (seg[1] === "import")
    return reply({ imported: [], errors: ["Add rows to the Courses tab in your Sheet instead."], total: 0 });

  throw new Error(`Unrouted request: ${method} ${url}`);
}

// ── Round operations ───────────────────────────────────────────────────────

/**
 * Rounds from this device, merged with anything the Sheet knows about.
 *
 * IndexedDB is per-device, so a round entered on the phone is invisible on the
 * laptop until we pull it down. Local copies always win, because they may hold
 * unsynced edits; remote-only rounds are added as headers and hydrate fully
 * when opened.
 */
async function listRounds(): Promise<Round[]> {
  const local = await allRounds();
  const byId = new Map<string, Round>();

  local.forEach(s => byId.set(String(s.round.id), s.round));

  try {
    const remote = await call<{ rounds: any[] }>("bootstrap");
    (remote.rounds || []).forEach(r => {
      const id = String(r.id);
      if (byId.has(id)) return;          // local wins — it may be dirty
      byId.set(id, {
        id, courseId: r.course_name, courseName: String(r.course_name || ""),
        courseRating: null, slopeRating: null, par: null,
        date: String(r.date || ""), holes: Number(r.holes) || 18,
        gameType: String(r.game_type || ""),
        gameOptions: String(r.game_options || "{}"),
        status: String(r.status || "complete"),
        pars: String(r.pars || "[]"),
        holeHandicaps: String(r.hole_handicaps || "[]"),
      });
    });
  } catch {
    // Offline: local rounds are still the important ones
  }

  return [...byId.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

async function load(id: string): Promise<Stored | null> {
  const local = await getStored(id);
  if (local) return local;
  try {
    const r = await call<{ round: any; players: any[] }>("getRound", { roundId: id });
    const p1 = (r.players || []).find((x: any) => Number(x.position) === 1) || r.players?.[0];
    const round: Round = {
      id: r.round.id, courseId: r.round.course_name, courseName: r.round.course_name,
      // The round keeps player 1's ratings so existing scorecard code has values
      courseRating: p1 ? Number(p1.course_rating) : null,
      slopeRating: p1 ? Number(p1.slope_rating) : null,
      par: p1 ? Number(p1.par) : null,
      date: String(r.round.date), holes: Number(r.round.holes),
      gameType: String(r.round.game_type), gameOptions: String(r.round.game_options || "{}"),
      status: String(r.round.status || "active"),
      pars: String(r.round.pars || "[]"), holeHandicaps: String(r.round.hole_handicaps || "[]"),
    };
    const players: RoundPlayer[] = [];
    const scores: HoleScore[] = [];
    r.players.forEach(p => {
      players.push({
        id: String(p.id), roundId: id, name: String(p.name),
        playerId: String(p.player_id || ""), tee: String(p.tee || ""),
        courseRating: p.course_rating === "" || p.course_rating == null ? null : Number(p.course_rating),
        slopeRating: p.slope_rating === "" || p.slope_rating == null ? null : Number(p.slope_rating),
        par: p.par === "" || p.par == null ? null : Number(p.par),
        handicapIndex: p.handicap_index ?? null,
        courseHandicap: Number(p.course_handicap) || 0, position: Number(p.position) || 1,
      });
      (p.strokes || []).forEach((st: number | null, i: number) => {
        if (st != null || (p.putts && p.putts[i] != null))
          scores.push({ id: `${p.id}-${i + 1}`, roundId: id, playerId: String(p.id),
                        hole: i + 1, strokes: st, putts: p.putts?.[i] ?? null });
      });
    });
    const stored: Stored = { round, players, scores, dirty: false, touched: new Date().toISOString() };
    await putStored(stored);
    return stored;
  } catch { return null; }
}

async function save(s: Stored): Promise<void> {
  await putStored({ ...s, dirty: true, touched: new Date().toISOString() });
  await announce();
  void flush();
}

async function createRound(payload: any): Promise<{ round: Round; players: RoundPlayer[] }> {
  const c = await cache();
  const src = payload.round ?? {};
  const course = c.courses.find(x => x.name === src.courseName);

  const round: Round = {
    id: newId(),
    courseId: course?.id ?? null,
    courseName: String(src.courseName ?? ""),
    courseRating: src.courseRating ?? course?.courseRating ?? null,
    slopeRating: src.slopeRating ?? course?.slopeRating ?? null,
    date: String(src.date ?? new Date().toISOString().slice(0, 10)),
    holes: Number(src.holes) || 18,
    par: src.par ?? course?.par ?? null,
    gameType: String(src.gameType ?? "best_ball"),
    gameOptions: typeof src.gameOptions === "string" ? src.gameOptions : JSON.stringify(src.gameOptions ?? {}),
    status: "active",
    pars: src.pars ?? course?.pars ?? "[]",
    holeHandicaps: src.holeHandicaps ?? course?.holeHandicaps ?? "[]",
  };

  const players: RoundPlayer[] = (payload.players ?? []).map((p: any, i: number) => {
    // Each player's tee determines their own rating, slope and par
    const t = course?.tees.find(x => x.tee === p.tee) ?? course?.tees[0];
    const cr = p.courseRating ?? t?.courseRating ?? null;
    const sl = p.slopeRating ?? t?.slopeRating ?? null;
    const pr = p.par ?? t?.par ?? null;
    const hi = p.handicapIndex == null ? null : Number(p.handicapIndex);
    const chcp = p.courseHandicap != null && p.courseHandicap !== ""
      ? Number(p.courseHandicap)
      : courseHandicapFor(hi, sl, cr, pr);
    return {
      id: newId(), roundId: round.id, name: String(p.name ?? `Player ${i + 1}`),
      playerId: p.playerId ?? "", tee: p.tee ?? t?.tee ?? "",
      courseRating: cr, slopeRating: sl, par: pr,
      handicapIndex: hi, courseHandicap: chcp,
      position: Number(p.position) || i + 1,
    };
  });

  await save({ round, players, scores: [], dirty: true, touched: "" });
  return { round, players };
}

async function patchRound(id: string, patch: Partial<Round>): Promise<Round> {
  const s = await load(id);
  if (!s) throw new Error("Round not found");
  const round = { ...s.round, ...patch };
  await save({ ...s, round });
  return round;
}

async function setScore(roundId: string, b: any): Promise<HoleScore> {
  const s = await load(roundId);
  if (!s) throw new Error("Round not found");
  const playerId = String(b.playerId), hole = Number(b.hole);
  const strokes = b.strokes == null ? null : Number(b.strokes);
  const putts = b.putts == null ? null : Number(b.putts);

  const scores = s.scores.filter(x => !(x.playerId === playerId && x.hole === hole));
  const entry: HoleScore = { id: `${playerId}-${hole}`, roundId, playerId, hole, strokes, putts };
  scores.push(entry);

  await save({ ...s, scores });
  return entry;
}

async function addPlayer(roundId: string, b: any): Promise<RoundPlayer> {
  const s = await load(roundId);
  if (!s) throw new Error("Round not found");
  const p: RoundPlayer = {
    id: newId(), roundId, name: String(b.name ?? "Player"),
    handicapIndex: b.handicapIndex ?? null,
    courseHandicap: Number(b.courseHandicap) || 0,
    position: Number(b.position) || s.players.length + 1,
  };
  await save({ ...s, players: [...s.players, p] });
  return p;
}

async function removePlayer(roundId: string, playerId: string) {
  const s = await load(roundId);
  if (!s) throw new Error("Round not found");
  await save({
    ...s,
    players: s.players.filter(p => p.id !== playerId),
    scores: s.scores.filter(x => x.playerId !== playerId),
  });
  return { ok: true };
}

async function patchPlayer(roundId: string, playerId: string, b: any): Promise<RoundPlayer> {
  const s = await load(roundId);
  if (!s) throw new Error("Round not found");
  const players = s.players.map(p => p.id === playerId ? { ...p, ...b } : p);
  await save({ ...s, players });
  return players.find(p => p.id === playerId)!;
}

/** Best score per hole across completed rounds on this course. */
/**
 * Best score on each hole across completed rounds at this course.
 *
 * Each entry is an object, not a bare number: the Scorecard shows which round
 * the ghost score came from, so the date has to travel with it.
 */
async function ghost(courseName: string) {
  const rounds = (await allRounds()).filter(
    s => s.round.courseName === courseName && s.round.status === "complete");
  if (!rounds.length) return { scores: {}, roundCount: 0 };

  const best: Record<number, { strokes: number; roundDate: string }> = {};
  rounds.forEach(s => {
    const me = s.players.find(p => p.position === 1);
    if (!me) return;
    const date = String(s.round.date || "");
    s.scores
      .filter(x => x.playerId === me.id && x.strokes != null)
      .forEach(x => {
        const cur = best[x.hole];
        if (!cur || x.strokes! < cur.strokes) {
          best[x.hole] = { strokes: x.strokes!, roundDate: date };
        }
      });
  });
  return { scores: best, roundCount: rounds.length };
}

// ── Unchanged public surface ───────────────────────────────────────────────

async function throwIfResNotOk(res: Response) {
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()) || res.statusText}`);
}

export const getQueryFn: <T>(o: { on401: "returnNull" | "throw" }) => QueryFunction<T> =
  () => async ({ queryKey }) => {
    const res = await apiRequest("GET", (queryKey as unknown[]).join("/"));
    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
      throwOnError: false,
    },
    mutations: { retry: false },
  },
});