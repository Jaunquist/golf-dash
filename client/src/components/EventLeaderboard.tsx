/**
 * EventLeaderboard — the combined board across the flights of one game.
 *
 * VERIFY: event-leaderboard-pooled
 *
 * Two flights of four share one event_id (see NewRound's join flow). Each
 * flight is its own round with its own single writer, which is what stops two
 * phones overwriting each other — but the *game* spans both, so the standings
 * have to be computed over all eight players at once.
 *
 * Pooling, not summing, is the whole point of this file.
 *
 * It would be easier to run the engine per flight and concatenate the results.
 * That is also wrong for every field-wide format. Skins awards the hole to the
 * outright lowest score in the field: run per flight and each hole produces
 * two winners, so eight players would collect roughly twice the skins that are
 * actually on the table. Best Ball compares one side's best ball against the
 * other's; split the field in two and each half is scored against the wrong
 * opponents. So every flight's players go into a single computeGameResults()
 * call against the event's pars and stroke index.
 *
 * Pooling is safe because player ids are client-minted and globally unique, so
 * ids from different flights never collide in the engine's Record<id, …> maps.
 *
 * What this does NOT try to combine: Match Play, High-Low, Niners and Twelves
 * are settled between the people standing on the tee together. There is no
 * meaningful eight-player reading of "most holes won" when only four of you
 * played each other, so those stay per-flight and this panel says so rather
 * than inventing a number.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { eventRounds, setTeams, isAdmin } from "@/lib/queryClient";
import {
  computeGameResults,
  cumulativeTotals,
  quotaTarget,
  type Player as GPlayer,
  type GameType,
  type GameOptions,
} from "@/lib/gameEngine";
import { Link } from "wouter";
import { Trophy, Users, Info, RefreshCw, ExternalLink, Pencil } from "lucide-react";

/**
 * One colour per flight, used on the flight tag beside a player's name and on
 * the progress line, so a row can be traced to a group at a glance.
 *
 * Hue, not just shade: these have to survive being read on a phone in daylight
 * and stay apart for the red-green colour blind, which rules out the obvious
 * red/green pairing. Blue and amber separate under every common form of it.
 * The colour is never the only carrier — the flight number is always written
 * next to it.
 */
const FLIGHT_COLORS = [
  { text: "text-sky-700 dark:text-sky-400",     dot: "bg-sky-600" },
  { text: "text-amber-700 dark:text-amber-500", dot: "bg-amber-600" },
  { text: "text-violet-700 dark:text-violet-400", dot: "bg-violet-600" },
  { text: "text-teal-700 dark:text-teal-400",   dot: "bg-teal-600" },
];
const flightColor = (i: number) => FLIGHT_COLORS[i % FLIGHT_COLORS.length];

/** Formats whose standings are per player and pool across the whole field. */
const POOLED_INDIVIDUAL: GameType[] = ["stableford", "quota", "skins"];
/**
 * Formats whose standings are per team and pool across the whole field.
 *
 * match_play belongs here and was wrongly left out. In this engine match_play
 * IS the team game — it shares a case with best_ball and settles each hole by
 * comparing one side's best ball against the other's. With teams spanning both
 * flights that is a coherent four-against-four match, so there is nothing to
 * keep per-flight about it. The format that genuinely cannot combine is
 * match_play_indiv, where everyone plays for themselves and the people in the
 * other flight never played you.
 */
const POOLED_TEAM: GameType[] = ["best_ball", "match_play"];

/**
 * Formats that settle a hole only once every pooled player has played it
 * (the engine's `anyNull` guard). Worth saying out loud: with two flights on
 * the course the board legitimately sits still until the slower group catches
 * up, and that looks identical to a sync failure if nobody explains it.
 */
const WAITS_FOR_FIELD: GameType[] = ["skins", "best_ball", "match_play"];

type FlightRow = { round: any; players: any[] };

/** A team's name if one was given, else "Team 1". */
function teamLabel(n: number, names?: Record<string, string>): string {
  const given = names?.[String(n)]?.trim();
  return given || (n === 3 ? "Solo" : `Team ${n}`);
}

function firstName(s: string): string {
  return String(s || "").trim().split(/\s+/)[0] || "—";
}

/** "4 min ago", from an ISO timestamp. */
function sinceLabel(iso: string): string | null {
  const t = Date.parse(String(iso || ""));
  if (!Number.isFinite(t)) return null;
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function EventLeaderboard({
  eventId,
  currentRoundId,
  gameType,
  gameOptions,
  pars,
  holeHandicaps,
  holes,
}: {
  eventId: string;
  currentRoundId: string;
  gameType: string;
  gameOptions: GameOptions;
  pars: number[];
  holeHandicaps: number[];
  holes: number;
}) {
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["event-leaderboard", eventId],
    queryFn: () => eventRounds(eventId),
    // The other flight is on another phone, so nothing local tells us when it
    // saves. Polling a minute apart keeps the board close enough to live for a
    // round of golf without hammering Apps Script — a save there takes a
    // document lock, and two flights plus a poll per minute is well inside it.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    enabled: !!eventId,
  });

  const flights: FlightRow[] = data?.rounds ?? [];

  /**
   * Event-level team editing.
   *
   * Teams span flights but are stored per flight, so arranging eight players
   * into two sides means writing two rounds. Doing it from each flight's own
   * game settings works but needs both owners to pick numbering that happens
   * to line up — one of them calling his pair "Team 1" meaning the other side
   * silently produces a merged mess. This edits all of them from one screen
   * and writes each flight, so the numbering cannot disagree.
   */
  const [editing, setEditing] = useState(false);
  const [draftTeams, setDraftTeams] = useState<Record<string, number>>({});
  const [draftNames, setDraftNames] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");

  const board = useMemo(() => {
    if (flights.length < 2) return null;

    const gt = gameType as GameType;
    const isIndividual = POOLED_INDIVIDUAL.includes(gt);
    const isTeam = POOLED_TEAM.includes(gt);
    if (!isIndividual && !isTeam) return { combinable: false as const };

    /**
     * Pool every player, flight by flight, players within a flight in playing
     * order. This order is also the index space for teamAssignment below, so
     * it has to be built once and used for both.
     */
    const pooled: {
      g: GPlayer;
      flightIdx: number;
      flightLabel: string;
      roundId: string;
      team: number;
      /**
       * Index within the flight's FULL player list, scorecard-only players
       * included. teamAssignment is stored against that ordering, so writing
       * it back from a list that skipped anyone would shift every player after
       * the gap onto the wrong side.
       */
      orderIdx: number;
      /** How long the flight's teamAssignment array has to be. */
      flightSize: number;
    }[] = [];

    const grossScores: Record<string, Record<number, number | null>> = {};
    const names: Record<string, string> = {};

    flights.forEach((f, flightIdx) => {
      const inOrder = [...(f.players || [])].sort(
        (a, b) => (Number(a.position) || 0) - (Number(b.position) || 0)
      );

      /**
       * Teams across flights.
       *
       * A flight stores teamAssignment as an array indexed by its own four
       * players, so neither flight's array can describe an eight-player event.
       * Merging them onto the same 1/2 space is the only reading that uses
       * what was actually entered: flight A's team 1 and flight B's team 1
       * become one side. Where a flight never set teams, the engine's own
       * fallback applies within that flight — first two players one side,
       * last two the other.
       *
       * This is a defensible default, not a stated intention, so the panel
       * prints how it read the teams and lets a wrong grouping be seen.
       */
      let fOpts: any = {};
      try {
        fOpts = JSON.parse(String(f.round?.game_options || "{}")) as GameOptions;
      } catch {
        fOpts = {};
      }
      const ta = Array.isArray(fOpts.teamAssignment) ? fOpts.teamAssignment : null;
      if (fOpts.teamNames && typeof fOpts.teamNames === "object") {
        // Later flights win only where earlier ones said nothing, so one
        // flight naming the sides is enough for the whole event.
        Object.keys(fOpts.teamNames).forEach(k => {
          if (!names[k] && String(fOpts.teamNames[k] || "").trim()) {
            names[k] = String(fOpts.teamNames[k]).trim();
          }
        });
      }

      const label = `Flight ${flightIdx + 1}`;

      inOrder.forEach((p, i) => {
        // Scorecard-only players keep their strokes but take nothing off the
        // people playing for something, exactly as within a single flight.
        if (p.in_game === 0) return;

        const id = String(p.id);
        const team = ta && i < ta.length ? Number(ta[i]) || 1 : i < 2 ? 1 : 2;

        pooled.push({
          g: {
            id: id as unknown as number,
            name: String(p.name || ""),
            courseHandicap: Number(p.course_handicap) || 0,
            // Position within the pooled field, so the engine's own
            // position-based fallbacks stay deterministic.
            position: pooled.length + 1,
          },
          flightIdx,
          flightLabel: label,
          roundId: String(f.round?.id ?? ""),
          team,
          orderIdx: i,
          flightSize: inOrder.length,
        });

        grossScores[id] = {};
        const strokes: (number | null)[] = Array.isArray(p.strokes) ? p.strokes : [];
        for (let h = 1; h <= holes; h++) {
          const v = strokes[h - 1];
          grossScores[id][h] = v == null || v === ("" as any) ? null : Number(v);
        }
      });
    });

    if (pooled.length < 2) return { combinable: false as const };

    const gPlayers = pooled.map(p => p.g);
    const teamAssignment = pooled.map(p => p.team);

    const holeResults = computeGameResults(
      gPlayers,
      grossScores as any,
      pars,
      holeHandicaps,
      holes,
      gt,
      { ...gameOptions, teamAssignment }
    );
    const totals = cumulativeTotals(holeResults, gPlayers);

    /**
     * Progress, counted from the strokes rather than the points.
     *
     * Reading it off the points would undercount: a Stableford hole where
     * every player made a double scores zero for everyone, which is a played
     * hole that looks identical to an unplayed one.
     *
     * Two different numbers matter, because the formats differ in what they
     * wait for. `settled` is holes the whole field has posted — the binding
     * constraint for Skins and Best Ball, which cannot award a hole until
     * everyone has played it. `perFlight` is how far each group has got, which
     * is what actually counts for Stableford and Quota, where a player's
     * points never depend on the other flight. Quoting only the field-wide
     * number would understate a Stableford board by however many holes the
     * slower group is behind.
     */
    const settled = (() => {
      let n = 0;
      for (let h = 1; h <= holes; h++) {
        if (gPlayers.every(p => grossScores[String(p.id)]?.[h] != null)) n++;
      }
      return n;
    })();

    const perFlight = flights.map((f, flightIdx) => {
      const ids = pooled.filter(p => p.flightIdx === flightIdx).map(p => String(p.g.id));

      /**
       * Holes complete, and which hole the group is standing on.
       *
       * Both fall out of one pass. A hole is complete when every player in
       * that flight has a stroke on it; it is partial when some do and some
       * do not. The current hole is the first that is not complete, which
       * satisfies both halves of the rule at once — a partially filled hole
       * is itself the current one, and when the last filled hole is complete
       * the first incomplete one is the next hole along.
       *
       * Counting complete holes rather than any-input holes is what keeps
       * "12/18" honest: a flight that has entered one player's score on the
       * 13th has not played 13 holes.
       */
      let complete = 0;
      let current: number | null = null;
      for (let h = 1; h <= holes; h++) {
        const filled = ids.filter(id => grossScores[id]?.[h] != null).length;
        if (ids.length && filled === ids.length) complete++;
        else if (current == null) current = h;
      }

      return {
        label: `Flight ${flightIdx + 1}`,
        idx: flightIdx,
        roundId: String(f.round?.id ?? ""),
        isHere: String(f.round?.id ?? "") === String(currentRoundId),
        holes: complete,
        // null once every hole is complete — the group has finished.
        current,
      };
    });

    if (isTeam) {
      /**
       * Best Ball pays the hole to one representative player so that a team's
       * total is the points won, not points × team size. Individual numbers
       * are therefore meaningless here and only the team sum is shown.
       */
      const byTeam = new Map<
        number,
        { team: number; points: number; members: { name: string; flightIdx: number }[] }
      >();
      pooled.forEach(p => {
        const cur = byTeam.get(p.team) ?? { team: p.team, points: 0, members: [] };
        cur.points += totals[p.g.id as unknown as number] ?? 0;
        // Kept structured rather than pre-joined so each member can carry its
        // own flight colour when rendered.
        cur.members.push({ name: firstName(p.g.name), flightIdx: p.flightIdx });
        byTeam.set(p.team, cur);
      });
      const rows = [...byTeam.values()].sort((a, b) => b.points - a.points);
      return { combinable: true as const, kind: "team" as const, rows, settled, perFlight,
               teamNames: names, roster: pooled, flightCount: flights.length };
    }

    const rows = pooled
      .map(p => {
        const pts = totals[p.g.id as unknown as number] ?? 0;
        const target = gt === "quota" ? quotaTarget(p.g.courseHandicap) : null;
        return {
          id: String(p.g.id),
          name: p.g.name,
          flightLabel: p.flightLabel,
          flightIdx: p.flightIdx,
          isHere: p.roundId === String(currentRoundId),
          points: pts,
          target,
          // Quota is scored against your own target, so the standing is the
          // difference, not the raw points.
          sortKey: target == null ? pts : pts - target,
        };
      })
      .sort((a, b) => b.sortKey - a.sortKey);

    return { combinable: true as const, kind: "individual" as const, rows, settled, perFlight,
             teamNames: names, roster: pooled, flightCount: flights.length };
  }, [flights, gameType, gameOptions, pars, holeHandicaps, holes, currentRoundId]);

  // A solo flight is not an event yet. Every round mints an event id so a
  // second flight can join later, so this is the normal case and renders
  // nothing at all rather than an empty panel.
  if (!eventId || (!isLoading && flights.length < 2)) return null;

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card px-4 py-6 text-center">
        <p className="text-xs text-muted-foreground">Loading the other flight…</p>
      </div>
    );
  }

  if (!board) return null;

  const lastUpdated = flights
    .map(f => Date.parse(String(f.round?.updated_at || "")))
    .filter(t => Number.isFinite(t))
    .sort((a, b) => b - a)[0];

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <Trophy className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Combined · {board.combinable ? `${board.flightCount} flights` : "all flights"}
        </h2>
        {isAdmin() && board.combinable && !editing && (
          <button
            onClick={() => {
              const t: Record<string, number> = {};
              board.roster.forEach(p => { t[String(p.g.id)] = p.team; });
              setDraftTeams(t);
              setDraftNames({ ...(board.teamNames ?? {}) });
              setEditing(true);
            }}
            className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground
                       hover:text-foreground transition-colors"
          >
            <Pencil className="h-3 w-3" /> Teams
          </button>
        )}
        <button
          onClick={() => refetch()}
          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground
                     hover:text-foreground transition-colors disabled:opacity-50"
          disabled={isFetching}
          aria-label="Refresh the combined leaderboard"
        >
          <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
          {isFetching ? "Checking" : "Refresh"}
        </button>
      </div>

      {editing && board.combinable && (
        <div className="px-4 pb-3 space-y-3 border-b border-border/60">
          <div className="grid grid-cols-2 gap-2">
            {[1, 2].map(t => (
              <label key={t} className="min-w-0">
                <span className="block text-[10px] text-muted-foreground mb-1">
                  Team {t} name
                </span>
                <input
                  value={draftNames[String(t)] ?? ""}
                  onChange={e => setDraftNames(p => ({ ...p, [String(t)]: e.target.value.slice(0, 24) }))}
                  placeholder={`Team ${t}`}
                  className="w-full h-8 rounded-lg border border-border bg-background px-2 text-sm"
                />
              </label>
            ))}
          </div>

          {board.perFlight.map(f => (
            <div key={f.idx} className="space-y-1">
              <div className={`text-[10px] font-medium ${flightColor(f.idx).text}`}>{f.label}</div>
              {board.roster.filter(p => p.flightIdx === f.idx).map(p => {
                const cur = draftTeams[String(p.g.id)] ?? p.team;
                return (
                  <div key={String(p.g.id)} className="flex items-center gap-2">
                    <span className="text-xs truncate flex-1 min-w-0">{p.g.name}</span>
                    <div className="flex gap-1 shrink-0">
                      {[1, 2].map(t => (
                        <button
                          key={t}
                          onClick={() => setDraftTeams(d => ({ ...d, [String(p.g.id)]: t }))}
                          className={`px-2 py-1 rounded-lg text-[10px] font-semibold border transition-colors ${
                            cur === t
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border text-muted-foreground"
                          }`}
                        >
                          {draftNames[String(t)]?.trim() || `T${t}`}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {saveErr && <p className="text-[11px] text-destructive leading-snug">{saveErr}</p>}

          <div className="flex gap-2">
            <button
              onClick={() => { setEditing(false); setSaveErr(""); }}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                setSaveErr("");
                try {
                  const names: Record<string, string> = {};
                  [1, 2].forEach(t => {
                    const v = draftNames[String(t)]?.trim();
                    if (v) names[String(t)] = v;
                  });
                  // One write per flight, each carrying only its own players
                  // in that flight's playing order — which is the index space
                  // teamAssignment is read back in.
                  for (const f of board.perFlight) {
                    const mine = board.roster.filter(p => p.flightIdx === f.idx);
                    if (!mine.length) continue;
                    // Full-length array positioned by orderIdx. A flight with
                    // a scorecard-only player has a gap in the in-game list,
                    // and a dense array would put everyone after it on the
                    // wrong team. Gaps default to 1, which is what the engine
                    // falls back to for an unspecified slot.
                    const ta = new Array(mine[0].flightSize).fill(1);
                    mine.forEach(p => {
                      ta[p.orderIdx] = draftTeams[String(p.g.id)] ?? p.team;
                    });
                    await setTeams(f.roundId, ta, names);
                  }
                  setEditing(false);
                  refetch();
                } catch (e: any) {
                  setSaveErr(String(e?.message || e || "Couldn't save teams"));
                } finally {
                  setSaving(false);
                }
              }}
              className="ml-auto px-3 py-1.5 rounded-lg text-[11px] font-semibold
                         bg-primary text-primary-foreground disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save teams"}
            </button>
          </div>
        </div>
      )}

      {!board.combinable ? (
        <div className="px-4 pb-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            This format is settled inside each flight, between the players who
            actually played one another — so there is no combined standing to
            show. Each flight's own result stands on its own scorecard.
          </p>
        </div>
      ) : (
        <>
          <div className="divide-y divide-border/60">
            {board.kind === "team"
              ? board.rows.map((r, i) => (
                  <div key={r.team} className="flex items-baseline gap-3 px-4 py-2.5">
                    <span className="text-[11px] font-semibold text-muted-foreground w-4 shrink-0 tabular-nums">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <Users className="h-3 w-3 text-muted-foreground shrink-0" />
                        <span className="text-sm font-medium truncate">
                          {teamLabel(r.team, board.teamNames)}
                        </span>
                      </div>
                      <div className="text-[10px] truncate mt-0.5">
                        {r.members.map((m, mi) => (
                          <span key={`${m.name}-${mi}`}>
                            {mi > 0 && <span className="text-muted-foreground/50"> · </span>}
                            <span className="text-muted-foreground">{m.name}</span>
                            <span className={`ml-0.5 ${flightColor(m.flightIdx).text}`}>
                              F{m.flightIdx + 1}
                            </span>
                          </span>
                        ))}
                      </div>
                    </div>
                    <span className="text-sm font-semibold tabular-nums shrink-0">{r.points}</span>
                  </div>
                ))
              : board.rows.map((r, i) => (
                  <div
                    key={r.id}
                    className={`flex items-baseline gap-3 px-4 py-2.5 ${
                      r.isHere ? "" : "bg-muted/20"
                    }`}
                  >
                    <span className="text-[11px] font-semibold text-muted-foreground w-4 shrink-0 tabular-nums">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-medium truncate">{r.name}</span>
                      {/* Flight tag carries the colour, but the number is
                          always written out so colour is never load-bearing
                          on its own. The hole count rides along in a smaller
                          size so a leader who is simply further round the
                          course is obvious. */}
                      <span
                        className={`text-[10px] font-medium ml-1.5 ${flightColor(r.flightIdx).text}`}
                      >
                        {r.flightLabel}
                      </span>
                      <span className="text-[9px] text-muted-foreground/70 ml-1 tabular-nums">
                        {board.perFlight[r.flightIdx]?.holes ?? 0}/{holes}
                      </span>
                    </div>
                    {r.target == null ? (
                      <span className="text-sm font-semibold tabular-nums shrink-0">{r.points}</span>
                    ) : (
                      <span className="text-sm font-semibold tabular-nums shrink-0">
                        {r.points - r.target > 0 ? "+" : ""}
                        {r.points - r.target}
                        <span className="text-[10px] font-normal text-muted-foreground ml-1">
                          ({r.points}/{r.target})
                        </span>
                      </span>
                    )}
                  </div>
                ))}
          </div>

          <div className="px-4 py-2.5 border-t border-border/60 space-y-1.5">
            {/*
              One line per flight: how far round it is, which hole it is on,
              and a way into its scorecard. The flight you are scoring links
              nowhere — you are already on it — and the other flight opens
              read-only, which is the same view its share link gives.
            */}
            {board.perFlight.map(f => (
              <div key={f.idx} className="flex items-center gap-1.5 text-[10px] leading-snug">
                <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${flightColor(f.idx).dot}`} />
                <span className={`font-medium ${flightColor(f.idx).text}`}>{f.label}</span>
                <span className="text-muted-foreground/80 tabular-nums">
                  {f.holes}/{holes}
                </span>
                <span className="text-muted-foreground/80">
                  {f.current == null ? "· finished" : `· on hole ${f.current}`}
                </span>
                {f.isHere ? (
                  <span className="text-muted-foreground/50 ml-auto shrink-0">you</span>
                ) : (
                  <Link
                    href={`/shared/${f.roundId}`}
                    className="ml-auto shrink-0 inline-flex items-center gap-0.5
                               text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Scorecard <ExternalLink className="h-2.5 w-2.5" />
                  </Link>
                )}
              </div>
            ))}

            <p className="text-[10px] text-muted-foreground/70 leading-snug pt-0.5">
              {/*
                Field-wide formats are gated by the slowest group, so the
                binding number is the one every player has posted. Per-player
                formats need no such line — the per-flight rows above already
                say how far each group has got.
              */}
              {WAITS_FOR_FIELD.includes(gameType as GameType)
                ? `${board.settled} of ${holes} holes settled across both flights`
                : ""}
              {WAITS_FOR_FIELD.includes(gameType as GameType) && lastUpdated ? " · " : ""}
              {lastUpdated ? `last save ${sinceLabel(new Date(lastUpdated).toISOString())}` : ""}
            </p>
            {WAITS_FOR_FIELD.includes(gameType as GameType) && (
              <p className="text-[10px] text-muted-foreground/70 leading-snug flex gap-1.5">
                <Info className="h-3 w-3 shrink-0 mt-px" />
                <span>
                  A hole is only settled once every player in both flights has
                  posted it, so the board waits for the slower group. It is not
                  stuck.
                </span>
              </p>
            )}
            {board.kind === "team" && (
              <p className="text-[10px] text-muted-foreground/70 leading-snug flex gap-1.5">
                <Info className="h-3 w-3 shrink-0 mt-px" />
                <span>
                  Teams were read from each flight's own pairing and merged — a
                  flight's Team 1 joins the other flight's Team 1. Check the
                  names above match the sides you meant to play.
                </span>
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
