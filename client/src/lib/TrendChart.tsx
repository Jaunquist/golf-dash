/**
 * The scoring trend, on one axis, with every round visible.
 *
 * The previous chart defaulted to gross score and filtered nine-hole rounds out
 * of the view, which created the two problems this replaces: a gross score is
 * not comparable between a nine and an eighteen, nor between an easy course and
 * a hard one, and hiding the nines meant a third of the history was invisible
 * unless you went looking for it.
 *
 * Score differential is the default because it removes both distortions — it
 * divides out slope and subtracts course rating, which is the whole reason WHS
 * uses it. Nine-hole rounds plot on the same axis, drawn as a hollow dot, so
 * you can see them in sequence and still know to weigh them less.
 */

import { useMemo, useState } from "react";
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import type { RoundStats } from "@/lib/roundStats";

type Metric = "diff" | "vspar" | "gross";

const METRICS: { key: Metric; label: string; axis: string; note: string }[] = [
  { key: "diff",  label: "Differential", axis: "Differential",
    note: "Removes course rating and slope, so rounds at different courses compare directly. Nines are doubled to an 18-hole scale." },
  { key: "vspar", label: "vs Par / hole", axis: "Strokes over par per hole",
    note: "Strokes over par divided by holes played. Comparable across round lengths, but not across course difficulty." },
  { key: "gross", label: "Gross", axis: "Strokes",
    note: "Raw strokes. Nines are doubled so they sit on the same axis — a rough visual approximation, not how your index is computed." },
];

/** Least-squares fit over just the plotted points. */
function trendPoints(vals: (number | null)[]): (number | null)[] {
  const pts = vals
    .map((v, i) => ({ i, v }))
    .filter(p => p.v != null) as { i: number; v: number }[];
  if (pts.length < 3) return vals.map(() => null);
  const n = pts.length;
  const sx = pts.reduce((a, p) => a + p.i, 0);
  const sy = pts.reduce((a, p) => a + p.v, 0);
  const sxy = pts.reduce((a, p) => a + p.i * p.v, 0);
  const sxx = pts.reduce((a, p) => a + p.i * p.i, 0);
  const denom = n * sxx - sx * sx;
  if (!denom) return vals.map(() => null);
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const lo = pts[0].i, hi = pts[pts.length - 1].i;
  return vals.map((_, i) =>
    i >= lo && i <= hi ? Math.round((slope * i + intercept) * 100) / 100 : null);
}

interface Row {
  label: string;
  value: number | null;
  trend: number | null;
  holes: number;
  course: string;
  gross: number;
  vsPar: number;
  diff: number | null;
  estimated: boolean;
  date: string;
}

/** Filled dot = 18 holes, hollow = 9. Shape carries the caveat, not a footnote. */
function RoundDot(props: any) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || payload?.value == null) return null;
  const nine = payload.holes !== 18;
  return (
    <circle
      cx={cx} cy={cy} r={nine ? 4.5 : 4}
      // The app stores tokens as bare HSL triplets, so they need wrapping
      fill={nine ? "hsl(var(--background))" : "hsl(var(--primary))"}
      stroke="hsl(var(--primary))"
      strokeWidth={2}
    />
  );
}

function TrendTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const r: Row = payload[0].payload;
  return (
    <div className="rounded-lg border border-border bg-popover px-2.5 py-2 shadow-md">
      <div className="text-[11px] font-semibold">{r.course}</div>
      <div className="text-[10px] text-muted-foreground mb-1">
        {r.date} · {r.holes} holes
      </div>
      <div className="space-y-0.5 text-[10px]">
        <div className="flex gap-3 justify-between">
          <span className="text-muted-foreground">Gross</span>
          <span className="font-semibold tabular">{r.gross}</span>
        </div>
        <div className="flex gap-3 justify-between">
          <span className="text-muted-foreground">vs par</span>
          <span className="font-semibold tabular">
            {r.vsPar > 0 ? `+${r.vsPar}` : r.vsPar}
          </span>
        </div>
        <div className="flex gap-3 justify-between">
          <span className="text-muted-foreground">Differential</span>
          <span className="font-semibold tabular">
            {r.diff != null ? r.diff.toFixed(1) : "—"}
            {r.estimated && <span className="text-muted-foreground/60"> est</span>}
          </span>
        </div>
      </div>
      {r.holes !== 18 && (
        <div className="text-[9px] text-muted-foreground/70 mt-1 pt-1 border-t border-border">
          Nine-hole round, scaled to 18
        </div>
      )}
    </div>
  );
}

export default function TrendChart({ rounds }: { rounds: RoundStats[] }) {
  const [metric, setMetric] = useState<Metric>("diff");
  const [showTrend, setShowTrend] = useState(true);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = rounds.map(r => {
      const value =
        metric === "diff"  ? r.differential
      : metric === "vspar" ? r.vsParPerHole
      : /* gross */          (r.holes === 18 ? r.gross : r.gross * 2);
      return {
        label: r.date.slice(5).replace("-", "/"),
        value: value ?? null,
        trend: null,
        holes: r.holes,
        course: r.course,
        gross: r.gross,
        vsPar: r.vsPar,
        diff: r.differential,
        estimated: r.differentialEstimated,
        date: r.date,
      };
    });
    trendPoints(out.map(r => r.value)).forEach((v, i) => { out[i].trend = v; });
    return out;
  }, [rounds, metric]);

  const plotted = rows.filter(r => r.value != null);
  const meta = METRICS.find(m => m.key === metric)!;
  const nines = rows.filter(r => r.holes !== 18).length;

  // A differential needs a course rating and slope on the tee played
  const missingRatings = metric === "diff" && rounds.length > 0 && plotted.length === 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {METRICS.map(m => (
          <button
            key={m.key}
            onClick={() => setMetric(m.key)}
            className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
              metric === m.key
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {m.label}
          </button>
        ))}
        <button
          onClick={() => setShowTrend(v => !v)}
          className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ml-auto ${
            showTrend
              ? "border-accent text-accent"
              : "border-border text-muted-foreground hover:text-foreground"
          }`}
        >
          Trend
        </button>
      </div>

      {missingRatings ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center space-y-1">
          <p className="text-sm text-muted-foreground">
            No differentials to plot yet.
          </p>
          <p className="text-[11px] text-muted-foreground/70 max-w-xs mx-auto">
            A differential needs the course rating and slope of the tee you played.
            Add those to the tee in Courses and this fills in retroactively.
          </p>
        </div>
      ) : plotted.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
          <p className="text-sm text-muted-foreground">Finish a round to see your trend.</p>
        </div>
      ) : (
        <>
          <div className="h-56 -ml-2">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="hsl(var(--border))" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false} tickLine={false} interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false} tickLine={false} width={34}
                  domain={["auto", "auto"]}
                />
                {metric === "vspar" && (
                  <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1} />
                )}
                <Tooltip content={<TrendTooltip />} />
                {showTrend && (
                  <Line
                    type="linear" dataKey="trend" dot={false} connectNulls
                    stroke="hsl(var(--accent))" strokeWidth={2} strokeDasharray="5 4"
                    isAnimationActive={false}
                  />
                )}
                <Line
                  type="monotone" dataKey="value" connectNulls
                  stroke="hsl(var(--primary))" strokeWidth={2}
                  dot={<RoundDot />} activeDot={{ r: 6 }}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Legend: identity is never colour alone, and the dot shape needs saying once */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <svg width="11" height="11"><circle cx="5.5" cy="5.5" r="3.5"
                fill="hsl(var(--primary))" stroke="hsl(var(--primary))" strokeWidth="2" /></svg>
              18 holes
            </span>
            {nines > 0 && (
              <span className="flex items-center gap-1.5">
                <svg width="11" height="11"><circle cx="5.5" cy="5.5" r="3.5"
                  fill="none" stroke="hsl(var(--primary))" strokeWidth="2" /></svg>
                9 holes ({nines})
              </span>
            )}
            {showTrend && (
              <span className="flex items-center gap-1.5">
                <svg width="16" height="3"><line x1="0" y1="1.5" x2="16" y2="1.5"
                  stroke="hsl(var(--accent))" strokeWidth="2" strokeDasharray="5 4" /></svg>
                Trend
              </span>
            )}
            <span className="ml-auto tabular">{plotted.length} rounds</span>
          </div>

          <p className="text-[10px] text-muted-foreground/70 leading-snug">
            {meta.note}
          </p>
        </>
      )}
    </div>
  );
}
