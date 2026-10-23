/**
 * The analytical half of the dashboard: how the strokes were actually spent.
 *
 * Three blocks, in the order the question gets asked:
 *   1. Scoring mix — what shape is my scoring?
 *   2. Where the strokes go — which hole type is costing me?
 *   3. Short game — putting, GIR, scrambling, and off the tee.
 *
 * Everything here is derived from strokes and putts already stored, so it works
 * retroactively over the whole history. Penalty and fairway tiles sit dormant
 * until the hole sheet starts capturing them.
 */

import { useMemo, useState } from "react";
import type { RoundStats, Aggregate, ScoreBucket } from "@/lib/roundStats";
import { aggregate, recentVsPrior } from "@/lib/roundStats";
import { Info } from "lucide-react";

/**
 * Ordered scale, not a categorical one: par is the neutral midpoint and the
 * bad side is a single hue stepping darker. Both sets were checked for
 * colour-blind separation and contrast against their own surface.
 */
const MIX: { key: ScoreBucket; label: string; short: string }[] = [
  { key: "birdie", label: "Birdie or better", short: "Bird+" },
  { key: "par",    label: "Par",              short: "Par" },
  { key: "bogey",  label: "Bogey",            short: "Bogey" },
  { key: "double", label: "Double or worse",  short: "Dbl+" },
];

const SWATCH: Record<ScoreBucket, string> = {
  birdie: "var(--mix-birdie)",
  par: "var(--mix-par)",
  bogey: "var(--mix-bogey)",
  double: "var(--mix-double)",
};

/** Scoped tokens, so the two validated palettes ship together. */
function MixTokens() {
  return (
    <style>{`
      .mix-scope {
        --mix-birdie: #15803d;
        --mix-par:    #94a3b8;
        --mix-bogey:  #fb923c;
        --mix-double: #dc2626;
      }
      .dark .mix-scope {
        --mix-birdie: #22c55e;
        --mix-par:    #8f8c88;
        --mix-bogey:  #ea9a0b;
        --mix-double: #ef4444;
      }
    `}</style>
  );
}

function Section({ title, hint, children, aside }: {
  title: string; hint?: string; aside?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        {aside}
      </div>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground/70 leading-snug">{hint}</p>}
    </section>
  );
}

// ── 1 · Scoring mix ────────────────────────────────────────────────────────

/**
 * One 100% stacked bar. Every segment carries its own number, so identity is
 * never colour alone and the sub-3:1 segments still read.
 */
function ScoringMix({ agg, prior }: { agg: Aggregate; prior: Aggregate | null }) {
  if (!agg.holes) {
    return <p className="text-xs text-muted-foreground">No completed holes yet.</p>;
  }

  const visible = MIX.filter(m => agg.mix[m.key] > 0);

  return (
    <div className="space-y-2.5">
      <div className="flex h-9 w-full gap-[2px] overflow-hidden rounded-md">
        {visible.map(m => {
          const pct = agg.mixPct[m.key];
          return (
            <div
              key={m.key}
              className="relative flex items-center justify-center min-w-[2px]"
              style={{ width: `${pct}%`, background: SWATCH[m.key] }}
              title={`${m.label}: ${agg.mix[m.key]} holes (${pct}%)`}
            >
              {pct >= 11 && (
                <span className="text-[10px] font-bold text-white drop-shadow-sm tabular">
                  {Math.round(pct)}%
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Legend doubles as the table view: count and share per bucket */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1.5">
        {MIX.map(m => {
          const delta = prior ? agg.mixPct[m.key] - prior.mixPct[m.key] : null;
          // More birdies and pars is an improvement; more bogeys and doubles is not
          const wantMore = m.key === "birdie" || m.key === "par";
          const improved = delta == null ? null : (delta > 0 ? wantMore : !wantMore);
          return (
            <div key={m.key} className="flex items-center gap-1.5 min-w-0">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0"
                    style={{ background: SWATCH[m.key] }} />
              <span className="text-[10px] text-muted-foreground truncate">{m.short}</span>
              <span className="text-[11px] font-semibold tabular ml-auto">
                {agg.mix[m.key]}
              </span>
              {delta != null && Math.abs(delta) >= 1 && (
                <span className={`text-[9px] tabular ${
                  improved
                    ? "text-green-600 dark:text-green-400"
                    : "text-orange-500 dark:text-orange-400"
                }`}>
                  {delta > 0 ? "▲" : "▼"}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── 2 · Where the strokes go ───────────────────────────────────────────────

/**
 * Diverging bars from a par baseline. The widest bar is the hole type to work
 * on, and the stroke total beside it says how much it is actually costing over
 * the whole history — an average of +1.5 reads as mild until you see it is 90
 * strokes.
 */
function StrokesByPar({ agg }: { agg: Aggregate }) {
  const rows = [3, 4, 5]
    .map(p => ({ par: p, ...(agg.byPar[p] ?? { avgVsPar: 0, holes: 0 }) }))
    .filter(r => r.holes > 0);

  if (!rows.length) {
    return <p className="text-xs text-muted-foreground">No completed holes yet.</p>;
  }

  const max = Math.max(1, ...rows.map(r => Math.abs(r.avgVsPar)));
  const worst = rows.reduce((a, b) => (b.avgVsPar > a.avgVsPar ? b : a));

  return (
    <div className="space-y-2">
      {rows.map(r => {
        const cost = Math.round(r.avgVsPar * r.holes);
        const isWorst = r.par === worst.par && rows.length > 1;
        return (
          <div key={r.par} className="flex items-center gap-2.5">
            <span className="text-[11px] font-medium text-muted-foreground w-11 shrink-0">
              Par {r.par}
            </span>

            <div className="flex-1 h-5 relative">
              {/* Par baseline */}
              <div className="absolute left-0 top-0 bottom-0 w-px bg-border" />
              <div
                className="absolute left-0 top-1/2 -translate-y-1/2 h-3 rounded-r"
                style={{
                  width: `${(Math.abs(r.avgVsPar) / max) * 100}%`,
                  background: r.avgVsPar > 0
                    ? (isWorst ? "var(--mix-double)" : "var(--mix-bogey)")
                    : "var(--mix-birdie)",
                }}
                title={`Par ${r.par}: ${r.avgVsPar > 0 ? "+" : ""}${r.avgVsPar} per hole over ${r.holes} holes`}
              />
            </div>

            <span className="text-xs font-bold tabular w-11 text-right shrink-0">
              {r.avgVsPar > 0 ? `+${r.avgVsPar}` : r.avgVsPar}
            </span>
            <span className="text-[10px] text-muted-foreground tabular w-16 text-right shrink-0">
              {cost > 0 ? `+${cost}` : cost} total
            </span>
          </div>
        );
      })}
      {rows.length > 1 && (
        <p className="text-[10px] text-muted-foreground/70 leading-snug pt-0.5">
          Par {worst.par}s are your most expensive hole, at{" "}
          {worst.avgVsPar > 0 ? "+" : ""}{worst.avgVsPar} a hole across{" "}
          {worst.holes} of them.
        </p>
      )}
    </div>
  );
}

// ── 3 · Short game and tee ─────────────────────────────────────────────────

/**
 * A tile's history as a bare line — no axes, no labels, no tooltip.
 *
 * The number above it says where you are; this says whether you got there
 * going up or down. Anything more (gridlines, values) would compete with the
 * figure it is annotating.
 *
 * Only the handful of metrics worth a shape get one. Nine sparklines in a grid
 * is wallpaper.
 */
function Spark({ values, betterIsLower }: {
  values: (number | null)[]; betterIsLower: boolean;
}) {
  const pts = values.filter((v): v is number => v != null);
  if (pts.length < 3) return null;

  const W = 56, H = 16, PAD = 1.5;
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || 1;
  const step = pts.length > 1 ? (W - PAD * 2) / (pts.length - 1) : 0;

  const d = pts.map((v, i) => {
    const x = PAD + i * step;
    const y = PAD + (H - PAD * 2) * (1 - (v - min) / span);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  // Direction over the last third, which is what "lately" means here
  const tail = pts.slice(-Math.max(2, Math.ceil(pts.length / 3)));
  const rising = tail[tail.length - 1] > tail[0];
  const good = betterIsLower ? !rising : rising;

  const lastX = PAD + (pts.length - 1) * step;
  const lastY = PAD + (H - PAD * 2) * (1 - (pts[pts.length - 1] - min) / span);

  return (
    <svg width={W} height={H} className="mt-1 overflow-visible" aria-hidden>
      <path d={d} fill="none" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"
            className={good ? "stroke-green-600 dark:stroke-green-400"
                            : "stroke-orange-500 dark:stroke-orange-400"} />
      <circle cx={lastX} cy={lastY} r="1.8"
              className={good ? "fill-green-600 dark:fill-green-400"
                              : "fill-orange-500 dark:fill-orange-400"} />
    </svg>
  );
}

function Tile({ label, value, sub, delta, spark, betterIsLower = true }: {
  label: string; value: string; sub?: string;
  delta?: number | null; betterIsLower?: boolean;
  /** Per-round history, oldest first. Omit for tiles that do not earn one. */
  spark?: (number | null)[];
}) {
  const good = delta == null ? null : betterIsLower ? delta < 0 : delta > 0;
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5">
      <div className="text-[10px] text-muted-foreground leading-tight">{label}</div>
      <div className="flex items-baseline gap-1 mt-0.5">
        <span className="font-display font-bold text-lg tabular leading-none">{value}</span>
        {delta != null && Math.abs(delta) > 0.04 && (
          <span className={`text-[10px] tabular ${
            good ? "text-green-600 dark:text-green-400" : "text-orange-500 dark:text-orange-400"
          }`}>
            {delta > 0 ? "+" : ""}{Math.round(delta * 10) / 10}
          </span>
        )}
      </div>
      {sub && <div className="text-[9px] text-muted-foreground/70 mt-0.5 leading-tight">{sub}</div>}
      {spark && <Spark values={spark} betterIsLower={betterIsLower} />}
    </div>
  );
}

function ShortGame({ agg, recent, prior, rounds }: {
  agg: Aggregate;              // what the numbers show, per the scope chip
  recent: Aggregate;           // last 5, for the arrow
  prior: Aggregate | null;     // the 5 before that
  rounds: RoundStats[];
}) {
  /**
   * The arrow always compares the last five rounds against the five before.
   * Comparing an all-time average against a recent window would make the
   * arrow mean something different depending on which chip was selected.
   */
  const d = (pick: (a: Aggregate) => number | null | undefined) => {
    const a = pick(recent), b = prior ? pick(prior) : null;
    return a != null && b != null ? a - b : null;
  };

  // Oldest first, which is the direction a sparkline reads in
  const series = (pick: (r: RoundStats) => number | null) => rounds.map(pick);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      <Tile label="GIR" betterIsLower={false}
            value={agg.girPct != null ? `${agg.girPct}%` : "—"}
            sub={agg.girPct != null ? `${agg.mix.birdie + agg.mix.par + agg.mix.bogey + agg.mix.double} holes` : "needs putts"}
            delta={d(x => x.girPct)}
            spark={series(r => r.girPct)} />
      <Tile label="Putts / round"
            value={agg.avgPutts != null ? String(agg.avgPutts) : "—"}
            sub={agg.avgPuttsPerHole != null ? `${agg.avgPuttsPerHole} per hole` : undefined}
            delta={d(x => x.avgPutts)}
            spark={series(r => r.putts)} />
      <Tile label="Putts / GIR"
            value={agg.puttsPerGir != null ? String(agg.puttsPerGir) : "—"}
            delta={d(x => x.puttsPerGir)} />
      <Tile label="3-putts / round"
            value={agg.threePuttsPerRound != null ? String(agg.threePuttsPerRound) : "—"}
            delta={d(x => x.threePuttsPerRound)}
            spark={series(r => r.threePutts)} />
      <Tile label="Scrambling" betterIsLower={false}
            value={agg.scramblePct != null ? `${agg.scramblePct}%` : "—"}
            sub="par or better after missing the green"
            delta={d(x => x.scramblePct)}
            spark={series(r => r.scramblePct)} />
      <Tile label="Penalties / round"
            value={agg.avgPenalties != null ? String(agg.avgPenalties) : "—"}
            sub={agg.avgPenalties == null ? "not yet tracked" : undefined}
            delta={d(x => x.avgPenalties)} />
      <Tile label="Fairways" betterIsLower={false}
            value={agg.fairwayPct != null ? `${agg.fairwayPct}%` : "—"}
            sub={agg.fairwayPct == null ? "not yet tracked" : "par 4s and 5s"}
            delta={d(x => x.fairwayPct)} />
      <Tile label="Mishit off tee"
            value={agg.mishitPct != null ? `${agg.mishitPct}%` : "—"}
            sub={agg.mishitPct == null ? "not yet tracked" : "did not advance"}
            delta={d(x => x.mishitPct)} />
      <Tile label="Avg vs par / hole"
            value={agg.avgVsParPerHole != null
              ? (agg.avgVsParPerHole > 0 ? `+${agg.avgVsParPerHole}` : String(agg.avgVsParPerHole))
              : "—"}
            delta={d(x => x.avgVsParPerHole)} />
    </div>
  );
}

// ── Panel ──────────────────────────────────────────────────────────────────

type Scope = "recent" | "all";

export default function InsightPanel({ rounds }: { rounds: RoundStats[] }) {
  const [scope, setScope] = useState<Scope>("all");

  const complete = useMemo(() => rounds.filter(r => r.mix.par + r.mix.bogey + r.mix.double + r.mix.birdie > 0), [rounds]);
  const all = useMemo(() => aggregate(complete), [complete]);
  const split = useMemo(() => recentVsPrior(complete, 5), [complete]);

  const agg = scope === "all" ? all : split.recent;
  const prior = scope === "all" ? null : split.prior;

  if (!complete.length) {
    return (
      <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          Finish a round and your scoring breakdown appears here.
        </p>
      </div>
    );
  }

  const thin = agg.rounds < 5;

  return (
    <div className="mix-scope space-y-7">
      <MixTokens />

      {/* Scope switch sits above every block it governs */}
      <div className="flex items-center gap-1.5">
        {([["all", `All ${all.rounds}`], ["recent", "Last 5"]] as [Scope, string][]).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setScope(k)}
            className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
              scope === k
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
        <span className="text-[10px] text-muted-foreground/60 ml-auto tabular">
          {agg.holes} holes
        </span>
      </div>

      {thin && (
        <div className="flex gap-2 rounded-lg bg-muted/40 px-3 py-2">
          <Info size={13} className="text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-[10px] text-muted-foreground leading-snug">
            {agg.rounds} round{agg.rounds === 1 ? "" : "s"} behind these numbers. Rates like
            scrambling and putts per GIR rest on a handful of holes and will move a lot
            as you add rounds — read them as a direction, not a measurement.
          </p>
        </div>
      )}

      <Section
        title="Scoring mix"
        hint="Share of holes by result. For most handicaps the fastest gain is converting doubles into bogeys, not bogeys into pars."
        aside={prior && <span className="text-[10px] text-muted-foreground/60">vs previous 5</span>}
      >
        <ScoringMix agg={agg} prior={prior} />
      </Section>

      <Section
        title="Where the strokes go"
        hint="Average strokes over par by hole type, and the total those holes have cost."
      >
        <StrokesByPar agg={agg} />
      </Section>

      <Section
        title="Short game & tee"
        hint={[
          agg.roundsWithPutts < agg.rounds
            ? `Putting figures come from the ${agg.roundsWithPutts} of ${agg.rounds} rounds where putts were entered.`
            : "",
          split.prior
            ? "Arrows and lines compare your last 5 rounds with the 5 before."
            : "Trends appear once you have 8 rounds or so to compare across.",
        ].filter(Boolean).join(" ")}
        aside={split.prior && (
          <span className="text-[10px] text-muted-foreground/60">last 5 vs previous 5</span>
        )}
      >
        <ShortGame agg={agg} recent={split.recent} prior={split.prior} rounds={complete} />
      </Section>
    </div>
  );
}
