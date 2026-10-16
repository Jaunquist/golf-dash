/**
 * Every derived number the dashboard shows, computed in one place.
 *
 * This exists because the maths was previously inlined in Dashboard.tsx and was
 * wrong: it took gross, subtracted 85% of the course handicap, and compared the
 * result to par. That is not a WHS score differential — it ignores course
 * rating and slope entirely, which are the only reason differentials are
 * comparable between courses in the first place.
 *
 * Mirrors roundStats_() in Code.gs. Keep the two in step.
 */

import { handicapStrokesOnHole } from "@/lib/gameEngine";
import type { Round, RoundPlayer, HoleScore } from "@shared/schema";

export interface RoundDetail {
  round: Round;
  players: RoundPlayer[];
  scores: HoleScore[];
}

/** Bucket a hole lands in, relative to par. */
export type ScoreBucket = "birdie" | "par" | "bogey" | "double";

export interface RoundStats {
  id: string;
  date: string;
  course: string;
  tee: string | null;
  holes: number;
  complete: boolean;

  /** Raw strokes over the holes actually played. */
  gross: number;
  /** Par of the holes actually played. */
  par: number;
  /** gross − par. Not comparable between 9h and 18h rounds. */
  vsPar: number;
  /** Strokes over par per hole. Comparable across round lengths. */
  vsParPerHole: number;

  /** WHS score differential, on an 18-hole scale. null when the tee lacks a rating. */
  differential: number | null;
  /** True when the differential was doubled from nine holes. */
  differentialEstimated: boolean;

  courseHandicap: number;
  handicapIndex: number | null;
  net: number | null;

  // Short game. null rather than 0 when putts were never entered, so an
  // unrecorded round does not drag an average down to look like good putting.
  putts: number | null;
  puttsPerHole: number | null;
  gir: number | null;
  girPct: number | null;
  puttsPerGir: number | null;
  threePutts: number | null;
  onePutts: number | null;
  scramblePct: number | null;

  /** Hole counts by bucket, over the holes played. */
  mix: Record<ScoreBucket, number>;
  /** Average strokes over par on par 3s / 4s / 5s, and how many of each. */
  byPar: Record<number, { avgVsPar: number; holes: number; total: number } | undefined>;

  // Capture added later — null on every round recorded before the hole sheet
  // gained these fields.
  penalties: number | null;
  fairwaysHit: number | null;
  fairwayAttempts: number | null;
  fairwayPct: number | null;
  mishits: number | null;
}

function round1(v: number): number { return Math.round(v * 10) / 10; }
function round2(v: number): number { return Math.round(v * 100) / 100; }

function safeJson<T>(raw: unknown, fallback: T): T {
  try { return typeof raw === "string" ? JSON.parse(raw) as T : fallback; }
  catch { return fallback; }
}

/**
 * Net double bogey: par + 2 + the handicap strokes the player gets on the hole.
 * WHS caps every hole at this before a differential is computed, so one blow-up
 * hole cannot distort a handicap.
 */
function netDoubleBogey(par: number, courseHandicap: number, holeHcpRank: number, holes: number): number {
  return par + 2 + handicapStrokesOnHole(courseHandicap, holeHcpRank, holes);
}

/**
 * Derive everything for the owner's play in one round.
 * Returns null when the round has no position-1 player or no scores at all.
 */
export function statsForRound(detail: RoundDetail): RoundStats | null {
  const { round, players, scores } = detail;

  const me = players.find(p => p.position === 1);
  if (!me) return null;

  const pars = safeJson<number[]>(round.pars, []);
  const hcps = safeJson<number[]>(round.holeHandicaps, []);
  const holes = round.holes || 18;

  const mine = scores.filter(s => s.playerId === me.id);
  if (mine.length === 0) return null;

  const byHole = new Map<number, HoleScore>();
  mine.forEach(s => byHole.set(s.hole, s));

  let gross = 0, par = 0, played = 0, adjusted = 0, net = 0;
  let putts = 0, havePutts = false;
  let gir = 0, puttsOnGir = 0, threePutts = 0, onePutts = 0;
  let scrambleAtt = 0, scrambleOk = 0;
  let penalties = 0, havePenalties = false;
  let fairwaysHit = 0, fairwayAttempts = 0, mishits = 0, haveFairways = false;

  const mix: Record<ScoreBucket, number> = { birdie: 0, par: 0, bogey: 0, double: 0 };
  const byPar: RoundStats["byPar"] = {};

  for (let h = 1; h <= holes; h++) {
    const s = byHole.get(h);
    const st = s?.strokes;
    const holePar = Number(pars[h - 1]);
    if (st == null || !holePar) continue;

    played++;
    gross += st;
    par += holePar;

    const rank = hcps[h - 1] ?? h;
    adjusted += Math.min(st, netDoubleBogey(holePar, me.courseHandicap, rank, holes));
    net += st - handicapStrokesOnHole(me.courseHandicap, rank, holes);

    // Scoring mix
    const d = st - holePar;
    if (d <= -1) mix.birdie++;
    else if (d === 0) mix.par++;
    else if (d === 1) mix.bogey++;
    else mix.double++;

    // Strokes by hole type
    const slot = byPar[holePar] ?? { avgVsPar: 0, holes: 0, total: 0 };
    slot.holes++;
    slot.total += d;
    byPar[holePar] = slot;

    // Penalties and fairways — fields that may not exist on older rounds
    const pen = (s as any).penalties;
    if (pen != null && pen !== "") { penalties += Number(pen) || 0; havePenalties = true; }

    const fw = (s as any).fairway as string | null | undefined;
    const mis = (s as any).mishit;
    if (holePar >= 4 && (fw || mis != null)) {
      haveFairways = true;
      fairwayAttempts++;
      if (fw === "hit") fairwaysHit++;
      if (mis) mishits++;
    }

    // Putting and GIR
    const pt = s?.putts;
    if (pt == null) continue;
    havePutts = true;
    putts += pt;
    if (pt >= 3) threePutts++;
    if (pt === 1) onePutts++;

    if (st - pt <= holePar - 2) { gir++; puttsOnGir += pt; }
    else { scrambleAtt++; if (st <= holePar) scrambleOk++; }
  }

  if (played === 0) return null;

  Object.keys(byPar).forEach(k => {
    const slot = byPar[Number(k)]!;
    slot.avgVsPar = round2(slot.total / slot.holes);
  });

  // WHS differential, always expressed on an 18-hole scale so one axis serves
  // both round lengths. A nine is doubled, which assumes the unplayed nine
  // would have gone the same way — an estimate, and flagged as one.
  // Prefer the tee the player actually played. Rounds created before per-player
  // tees existed carry no rating on the player, so fall back to the round's —
  // otherwise every one of those rounds silently plots as "no differential".
  const slope = (me as any).slopeRating ?? (round as any).slopeRating ?? null;
  const cr = (me as any).courseRating ?? (round as any).courseRating ?? null;
  const nine = holes !== 18;
  let differential: number | null = null;
  if (slope && cr) {
    const ags18 = nine ? adjusted * 2 : adjusted;
    differential = round1((113 / slope) * (ags18 - cr));
  }

  return {
    id: String(round.id),
    date: round.date,
    course: round.courseName,
    tee: (me as any).tee || null,
    holes,
    complete: round.status === "complete" && played === holes,

    gross,
    par,
    vsPar: gross - par,
    vsParPerHole: round2((gross - par) / played),

    differential,
    differentialEstimated: nine && differential != null,

    courseHandicap: me.courseHandicap,
    handicapIndex: me.handicapIndex ?? null,
    net,

    putts: havePutts ? putts : null,
    puttsPerHole: havePutts ? round2(putts / played) : null,
    gir: havePutts ? gir : null,
    girPct: havePutts ? Math.round((gir / played) * 100) : null,
    puttsPerGir: havePutts && gir ? round2(puttsOnGir / gir) : null,
    threePutts: havePutts ? threePutts : null,
    onePutts: havePutts ? onePutts : null,
    scramblePct: havePutts && scrambleAtt ? Math.round((100 * scrambleOk) / scrambleAtt) : null,

    mix,
    byPar,

    penalties: havePenalties ? penalties : null,
    fairwaysHit: haveFairways ? fairwaysHit : null,
    fairwayAttempts: haveFairways ? fairwayAttempts : null,
    fairwayPct: haveFairways && fairwayAttempts
      ? Math.round((fairwaysHit / fairwayAttempts) * 100) : null,
    mishits: haveFairways ? mishits : null,
  };
}

/** Oldest first, which is the order every chart wants. */
export function statsForRounds(details: RoundDetail[]): RoundStats[] {
  return details
    .map(statsForRound)
    .filter((s): s is RoundStats => s !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── Aggregates ─────────────────────────────────────────────────────────────

export interface Aggregate {
  rounds: number;
  /** Holes behind the aggregate — the honest denominator for a rate. */
  holes: number;
  mix: Record<ScoreBucket, number>;
  mixPct: Record<ScoreBucket, number>;
  byPar: Record<number, { avgVsPar: number; holes: number } | undefined>;
  avgVsParPerHole: number | null;
  avgPutts: number | null;
  avgPuttsPerHole: number | null;
  girPct: number | null;
  puttsPerGir: number | null;
  threePuttsPerRound: number | null;
  scramblePct: number | null;
  avgPenalties: number | null;
  fairwayPct: number | null;
  mishitPct: number | null;
  /** Rounds that actually carried putt data, for the caveat line. */
  roundsWithPutts: number;
  roundsWithFairways: number;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/**
 * Pool the rounds. Rates are computed over pooled holes rather than as a mean
 * of per-round rates, so a nine does not carry the same weight as an eighteen.
 */
export function aggregate(rs: RoundStats[]): Aggregate {
  const mix: Record<ScoreBucket, number> = { birdie: 0, par: 0, bogey: 0, double: 0 };
  const byPar: Aggregate["byPar"] = {};
  let holes = 0;

  const parTotals: Record<number, { total: number; holes: number }> = {};

  rs.forEach(r => {
    (Object.keys(mix) as ScoreBucket[]).forEach(k => { mix[k] += r.mix[k]; });
    holes += r.mix.birdie + r.mix.par + r.mix.bogey + r.mix.double;
    Object.keys(r.byPar).forEach(k => {
      const p = Number(k);
      const slot = r.byPar[p]!;
      const acc = parTotals[p] ?? { total: 0, holes: 0 };
      acc.total += slot.total;
      acc.holes += slot.holes;
      parTotals[p] = acc;
    });
  });

  Object.keys(parTotals).forEach(k => {
    const p = Number(k);
    const acc = parTotals[p];
    byPar[p] = { avgVsPar: round2(acc.total / acc.holes), holes: acc.holes };
  });

  const mixPct = { birdie: 0, par: 0, bogey: 0, double: 0 } as Record<ScoreBucket, number>;
  if (holes > 0) {
    (Object.keys(mix) as ScoreBucket[]).forEach(k => {
      mixPct[k] = Math.round((mix[k] / holes) * 1000) / 10;
    });
  }

  const withPutts = rs.filter(r => r.putts != null);
  const withFw = rs.filter(r => r.fairwayAttempts != null);
  const withPen = rs.filter(r => r.penalties != null);

  // Pooled rates
  const pooledGir = withPutts.reduce((s, r) => s + (r.gir ?? 0), 0);
  const pooledPuttHoles = withPutts.reduce(
    (s, r) => s + r.mix.birdie + r.mix.par + r.mix.bogey + r.mix.double, 0);
  const pooledPutts = withPutts.reduce((s, r) => s + (r.putts ?? 0), 0);
  const pooledFwHit = withFw.reduce((s, r) => s + (r.fairwaysHit ?? 0), 0);
  const pooledFwAtt = withFw.reduce((s, r) => s + (r.fairwayAttempts ?? 0), 0);
  const pooledMishit = withFw.reduce((s, r) => s + (r.mishits ?? 0), 0);

  return {
    rounds: rs.length,
    holes,
    mix,
    mixPct,
    byPar,
    avgVsParPerHole: holes ? round2(rs.reduce((s, r) => s + r.vsPar, 0) / holes) : null,
    avgPutts: withPutts.length ? round1(mean(withPutts.map(r => r.putts!))!) : null,
    avgPuttsPerHole: pooledPuttHoles ? round2(pooledPutts / pooledPuttHoles) : null,
    girPct: pooledPuttHoles ? Math.round((pooledGir / pooledPuttHoles) * 100) : null,
    puttsPerGir: (() => {
      const xs = withPutts.filter(r => r.puttsPerGir != null).map(r => r.puttsPerGir!);
      return xs.length ? round2(mean(xs)!) : null;
    })(),
    threePuttsPerRound: withPutts.length
      ? round1(mean(withPutts.map(r => r.threePutts!))!) : null,
    scramblePct: (() => {
      const xs = withPutts.filter(r => r.scramblePct != null).map(r => r.scramblePct!);
      return xs.length ? Math.round(mean(xs)!) : null;
    })(),
    avgPenalties: withPen.length ? round1(mean(withPen.map(r => r.penalties!))!) : null,
    fairwayPct: pooledFwAtt ? Math.round((pooledFwHit / pooledFwAtt) * 100) : null,
    mishitPct: pooledFwAtt ? Math.round((pooledMishit / pooledFwAtt) * 100) : null,
    roundsWithPutts: withPutts.length,
    roundsWithFairways: withFw.length,
  };
}

/**
 * Split the history into the most recent n and the n before that, for an
 * honest "is this improving" read. Returns null for `prior` when there is not
 * enough history to compare against — better than implying a trend from two
 * rounds.
 */
export function recentVsPrior(rs: RoundStats[], n = 5): {
  recent: Aggregate; prior: Aggregate | null;
} {
  const ordered = [...rs].sort((a, b) => a.date.localeCompare(b.date));
  const recent = ordered.slice(-n);
  const prior = ordered.slice(Math.max(0, ordered.length - n * 2), ordered.length - n);
  return {
    recent: aggregate(recent),
    prior: prior.length >= Math.min(3, n) ? aggregate(prior) : null,
  };
}
