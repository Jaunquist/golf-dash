import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Scatter, ComposedChart,
} from "recharts";

/**
 * Performance panel.
 *
 * Two tabs over two genuinely different datasets:
 *   My Rounds — everything you record, including putts and GIR
 *   NGAP      — the official record, which holds gross scores only
 *
 * The performance stats live only on the My Rounds tab because NGAP does not
 * receive putting or approach data. Showing empty cards there would imply the
 * numbers exist and are zero.
 */

interface NgapPoint {
  date: string; hi: number; diff: number | null;
  course: string; counted: boolean;
}
interface AppPoint {
  date: string; gross: number; adjusted: number | null; diff: number | null;
  hi: number | null; course: string; tee: string;
  putts: number | null; gir: number | null;
}
interface Trends {
  ngap: NgapPoint[]; app: AppPoint[];
  currentIndex: number | null; lowIndex: number | null;
  ngapSynced: string | null;
}

type Range = "365d" | "monthly" | "yearly" | "lifetime";

export default function PerformancePanel() {
  const [tab, setTab] = useState<"mine" | "ngap">("mine");
  const [range, setRange] = useState<Range>("365d");
  const [showNgap, setShowNgap] = useState(true);
  const [showMine, setShowMine] = useState(true);

  const { data, isLoading } = useQuery<Trends>({
    queryKey: ["/api/trends"],
    queryFn: async () => (await apiRequest("GET", "/api/trends")).json(),
  });

  const ngap = data?.ngap ?? [];
  const app = data?.app ?? [];

  // ── Chart data: NGAP index as a line, your differentials as points ────────
  const chart = useMemo(() => {
    const cutoff = new Date();
    if (range === "365d") cutoff.setFullYear(cutoff.getFullYear() - 1);
    else if (range === "monthly") cutoff.setMonth(cutoff.getMonth() - 24);
    else if (range === "yearly") cutoff.setFullYear(cutoff.getFullYear() - 10);
    else cutoff.setFullYear(1970);

    const within = (d: string) => new Date(d) >= cutoff;
    const byDate: Record<string, any> = {};

    ngap.filter(p => within(p.date)).forEach(p => {
      byDate[p.date] = { ...(byDate[p.date] || {}), date: p.date, hi: p.hi, ngapCourse: p.course };
    });
    app.filter(p => within(p.date) && p.diff != null).forEach(p => {
      byDate[p.date] = { ...(byDate[p.date] || {}), date: p.date, myDiff: p.diff, myCourse: p.course };
    });

    return Object.values(byDate)
      .sort((a: any, b: any) => a.date.localeCompare(b.date))
      .map((d: any) => ({ ...d, label: d.date.slice(5).replace("-", "/") }));
  }, [ngap, app, range]);

  // ── Stats from your own rounds ───────────────────────────────────────────
  const stats = useMemo(() => {
    if (!app.length) return null;
    const n = app.length;
    const sum = (f: (p: AppPoint) => number | null | undefined) =>
      app.reduce((a, p) => a + (Number(f(p)) || 0), 0);
    const withPutts = app.filter(p => p.putts != null);
    const withGir = app.filter(p => p.gir != null);
    const diffs = app.map(p => p.diff).filter((d): d is number => d != null);

    return {
      rounds: n,
      avgGross: (sum(p => p.gross) / n).toFixed(1),
      bestGross: Math.min(...app.map(p => p.gross)),
      avgPutts: withPutts.length ? (sum(p => p.putts) / withPutts.length).toFixed(1) : null,
      puttsPerHole: withPutts.length ? (sum(p => p.putts) / withPutts.length / 18).toFixed(2) : null,
      avgGir: withGir.length ? (sum(p => p.gir) / withGir.length).toFixed(1) : null,
      girPct: withGir.length ? ((sum(p => p.gir) / withGir.length / 18) * 100).toFixed(0) : null,
      bestDiff: diffs.length ? Math.min(...diffs).toFixed(1) : null,
      avgDiff: diffs.length ? (diffs.reduce((a, b) => a + b, 0) / diffs.length).toFixed(1) : null,
    };
  }, [app]);

  // ── Reconciliation: where the two records agree ──────────────────────────
  const recon = useMemo(() => {
    const mine = new Set(app.map(p => p.date));
    const theirs = new Set(ngap.map(p => p.date));
    let agree = 0, differ = 0;
    app.forEach(p => {
      const match = ngap.find(n => n.date === p.date);
      if (!match) return;
      const myAdj = p.adjusted ?? p.gross;
      if (match.diff != null && p.diff != null &&
          Math.abs(match.diff - p.diff) < 0.15) agree++;
      else differ++;
    });
    return {
      total: ngap.length,
      agree,
      differ,
      onlyNgap: ngap.filter(p => !mine.has(p.date)).length,
      onlyMine: app.filter(p => !theirs.has(p.date)).length,
    };
  }, [app, ngap]);

  if (isLoading) return <Skeleton className="h-72 w-full rounded-xl" />;

  const lowLine = data?.lowIndex ?? null;

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4 space-y-4">
        <Tabs value={tab} onValueChange={v => setTab(v as any)}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="mine">My Rounds</TabsTrigger>
            <TabsTrigger value="ngap">NGAP Official</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* ── Header line ── */}
        <div className="flex items-baseline justify-between">
          <div>
            <h3 className="font-semibold text-primary">
              {tab === "mine" ? "My Performance" : "Official Handicap Record"}
            </h3>
            <p className="text-[11px] text-muted-foreground">
              {tab === "mine"
                ? `${app.length} round${app.length === 1 ? "" : "s"} logged in this app`
                : `${ngap.length} scores on NGAP${data?.ngapSynced ? ` · synced ${data.ngapSynced}` : ""}`}
            </p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold tabular">
              {data?.currentIndex ?? "—"}
            </div>
            <div className="text-[10px] text-muted-foreground">
              Index{lowLine != null ? ` · low ${lowLine}` : ""}
            </div>
          </div>
        </div>

        {/* ── Range + series toggles ── */}
        <div className="flex flex-wrap items-center gap-1.5">
          {(["365d", "monthly", "yearly", "lifetime"] as Range[]).map(r => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition ${
                range === r ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
            >
              {r === "365d" ? "365 Days" : r === "monthly" ? "Monthly"
                : r === "yearly" ? "Yearly" : "Lifetime"}
            </button>
          ))}

          <span className="flex-1" />

          <button
            onClick={() => setShowNgap(v => !v)}
            className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition ${
              showNgap ? "text-foreground" : "text-muted-foreground/50"}`}
          >
            <span className="w-3 h-0.5 rounded" style={{ background: "#c9a227" }} />
            NGAP index
          </button>
          <button
            onClick={() => setShowMine(v => !v)}
            className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition ${
              showMine ? "text-foreground" : "text-muted-foreground/50"}`}
          >
            <span className="w-2 h-2 rounded-full" style={{ background: "#1d5c3a" }} />
            My differentials
          </button>
        </div>

        {/* ── The chart ── */}
        {chart.length === 0 ? (
          <div className="h-52 flex items-center justify-center text-sm text-muted-foreground">
            No data in this range yet.
          </div>
        ) : (
          <div className="h-52 -ml-2">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="#00000012" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 9 }} interval="preserveStartEnd"
                       axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9 }} width={30} domain={["auto", "auto"]}
                       axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #0001" }}
                  formatter={(v: any, name: string) => [
                    v, name === "hi" ? "NGAP index" : "My differential",
                  ]}
                  labelFormatter={(l: string, p: any) => {
                    const d = p?.[0]?.payload;
                    return d ? `${d.date} · ${d.myCourse || d.ngapCourse || ""}` : l;
                  }}
                />
                {lowLine != null && (
                  <ReferenceLine y={lowLine} stroke="#00000030" strokeDasharray="3 3"
                                 label={{ value: `Low ${lowLine}`, fontSize: 9, position: "right" }} />
                )}
                {showNgap && (
                  <Line type="monotone" dataKey="hi" stroke="#c9a227" strokeWidth={2}
                        dot={false} connectNulls name="hi" />
                )}
                {showMine && (
                  <Scatter dataKey="myDiff" fill="#1d5c3a" name="myDiff" />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ── Tab-specific content below the chart ── */}
        {tab === "mine" ? (
          stats ? (
            <div className="grid grid-cols-3 gap-2 pt-1">
              <Stat label="Rounds" value={stats.rounds} />
              <Stat label="Avg gross" value={stats.avgGross} />
              <Stat label="Best" value={stats.bestGross} />
              <Stat label="Avg putts" value={stats.avgPutts ?? "—"} />
              <Stat label="Putts/hole" value={stats.puttsPerHole ?? "—"} />
              <Stat label="GIR" value={stats.girPct ? `${stats.girPct}%` : "—"}
                    sub={stats.avgGir ? `${stats.avgGir}/18` : undefined} />
              <Stat label="Avg diff." value={stats.avgDiff ?? "—"} />
              <Stat label="Best diff." value={stats.bestDiff ?? "—"} />
              <Stat label="Index" value={data?.currentIndex ?? "—"} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground py-3">
              Log a round to start building your stats.
            </p>
          )
        ) : (
          <div className="space-y-3 pt-1">
            <div className="grid grid-cols-3 gap-2">
              <Stat label="NGAP scores" value={recon.total} />
              <Stat label="Counting" value={ngap.filter(p => p.counted).length} />
              <Stat label="Low index" value={data?.lowIndex ?? "—"} />
            </div>

            <div className="rounded-lg bg-muted/50 p-3 space-y-1.5">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                Against my own record
              </p>
              <ReconLine label="Matching both records" value={recon.agree} tone="good" />
              {recon.differ > 0 &&
                <ReconLine label="Differ" value={recon.differ} tone="warn" />}
              {recon.onlyNgap > 0 &&
                <ReconLine label="On NGAP only" value={recon.onlyNgap} tone="muted" />}
              {recon.onlyMine > 0 &&
                <ReconLine label="In my app only" value={recon.onlyMine} tone="muted" />}
              <p className="text-[10px] text-muted-foreground pt-1">
                NGAP records gross scores only — putting and GIR are tracked here, not there.
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: any; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card px-2.5 py-2">
      <div className="text-[10px] text-muted-foreground truncate">{label}</div>
      <div className="text-base font-semibold tabular leading-tight">{value}</div>
      {sub && <div className="text-[9px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function ReconLine({ label, value, tone }:
  { label: string; value: number; tone: "good" | "warn" | "muted" }) {
  const colour = tone === "good" ? "text-emerald-700"
               : tone === "warn" ? "text-amber-600" : "text-muted-foreground";
  return (
    <div className="flex justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-semibold tabular ${colour}`}>{value}</span>
    </div>
  );
}