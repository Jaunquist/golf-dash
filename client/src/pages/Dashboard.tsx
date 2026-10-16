import { useState, useRef, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, Link } from "wouter";
import { apiRequest, queryClient as qc } from "@/lib/queryClient";
import { saveRoundsList, saveJustinRounds, removeRoundFromCache } from "@/lib/roundsCache";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Flag, Trophy, Trash2, Pencil, Check, X, RefreshCw, ChevronDown,
} from "lucide-react";
import type { Round } from "@shared/schema";
import { statsForRounds, type RoundDetail, type RoundStats } from "@/lib/roundStats";
import TrendChart from "@/components/TrendChart";
import InsightPanel from "@/components/InsightPanel";
import PerformancePanel from "@/components/PerformancePanel";
import AuthGate, { SignInButton } from "@/components/AuthGate";

/**
 * One scrolling page, ordered by how often you need each thing.
 *
 * This replaces an Overview / My Stats tab split that put the same rounds in
 * two places and duplicated the stat tiles in both. The ordering below is the
 * sequence the questions actually arrive in: where is my index, how did the
 * last round go, which way am I trending, where are the strokes going, and
 * only then the full history.
 */

const GAME_LABELS: Record<string, string> = {
  best_ball: "Best Ball",
  best_ball_pairs: "Best Ball Pairs",
  high_low: "High Low",
  high_low_pairs: "High Low Pairs",
  niners: "Niners",
  twelves: "Twelves",
  match_play: "Match Play",
};

/** "9H · Front" / "9H · Back" / "18H" */
function roundHoleLabel(round: Round): string {
  if (round.holes === 18) return "18H";
  try {
    const nt = JSON.parse(round.gameOptions || "{}")?.nineType;
    if (nt === "back") return "9H · Back";
    if (nt === "front") return "9H · Front";
  } catch { /* malformed options — fall through to the plain label */ }
  return "9H";
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : n === 0 ? "E" : String(n);
}

function monthLabel(date: string): string {
  const d = new Date(date + "T00:00:00");
  if (isNaN(d.getTime())) return date.slice(0, 7);
  return d.toLocaleDateString("en-PH", { month: "long", year: "numeric" });
}

// ── Swipeable round card ───────────────────────────────────────────────────

const SWIPE_THRESHOLD = 60;
const ACTION_WIDTH = 128;

function SwipeableRoundCard({ round, stats, onDelete, navigate }: {
  round: Round;
  stats: RoundStats | null;
  onDelete: (id: string) => void;
  navigate: (path: string) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const currentOffsetRef = useRef(0);
  const cardRef = useRef<HTMLDivElement>(null);

  const snapTo = useCallback((target: number) => {
    setOffset(target);
    currentOffsetRef.current = target;
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    startXRef.current = e.clientX;
    setIsDragging(true);
    cardRef.current?.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;
    const raw = currentOffsetRef.current + (e.clientX - startXRef.current);
    setOffset(Math.max(-ACTION_WIDTH, Math.min(0, raw)));
  }, [isDragging]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;
    setIsDragging(false);
    const totalMove = currentOffsetRef.current + (e.clientX - startXRef.current);
    snapTo(totalMove < -SWIPE_THRESHOLD ? -ACTION_WIDTH : 0);
  }, [isDragging, snapTo]);

  const handleCardClick = useCallback(() => {
    if (offset < -10) { snapTo(0); return; }
    navigate(`/round/${round.id}`);
  }, [offset, round.id, navigate, snapTo]);

  return (
    <div className="relative overflow-hidden rounded-xl" data-testid={`swipeable-round-${round.id}`}>
      <div className="absolute inset-y-0 right-0 flex items-stretch"
           style={{ width: ACTION_WIDTH }} aria-hidden={offset === 0}>
        <button
          className="flex-1 flex flex-col items-center justify-center gap-1 bg-blue-500 hover:bg-blue-600 text-white text-[11px] font-semibold transition-colors"
          data-testid={`btn-edit-round-${round.id}`}
          onClick={() => { snapTo(0); navigate(`/round/${round.id}`); }}
        >
          <Pencil size={15} /> Edit
        </button>
        <button
          className="flex-1 flex flex-col items-center justify-center gap-1 bg-red-500 hover:bg-red-600 text-white text-[11px] font-semibold transition-colors rounded-r-xl"
          data-testid={`btn-delete-round-${round.id}`}
          onClick={() => { snapTo(0); onDelete(String(round.id)); }}
        >
          <Trash2 size={15} /> Delete
        </button>
      </div>

      <div
        ref={cardRef}
        className={`relative z-10 flex items-center gap-3 p-3.5 border border-border bg-card cursor-pointer rounded-xl select-none
          ${isDragging ? "" : "transition-transform duration-200 ease-out"}`}
        style={{ transform: `translateX(${offset}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={handleCardClick}
        role="button"
        tabIndex={0}
        onKeyDown={e => e.key === "Enter" && handleCardClick()}
      >
        <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
          <Flag size={15} className="text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm truncate">{round.courseName}</div>
          <div className="text-xs text-muted-foreground truncate">
            {round.date} · {roundHoleLabel(round)} · {GAME_LABELS[round.gameType] ?? round.gameType}
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          {stats && (
            <>
              <div className="font-bold tabular text-sm">{stats.gross}</div>
              <div className={`text-xs tabular ${
                stats.vsPar > 0 ? "text-orange-500 dark:text-orange-400"
                : stats.vsPar < 0 ? "text-green-600 dark:text-green-400"
                : "text-muted-foreground"}`}>
                {signed(stats.vsPar)} vs par
              </div>
            </>
          )}
          {round.status === "active" && <Badge variant="outline" className="text-[10px]">Active</Badge>}
          {round.status === "complete" && !stats && (
            <Badge className="text-[10px] bg-muted text-muted-foreground">Done</Badge>
          )}
        </div>
        {offset === 0 && (
          <div className="ml-1 text-muted-foreground/30 flex-shrink-0">
            <svg width="10" height="16" viewBox="0 0 10 16" fill="none">
              <path d="M7 2L2 8l5 6" stroke="currentColor" strokeWidth="1.5"
                    strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Last round ─────────────────────────────────────────────────────────────

/** The round you just played, which was previously buried under the chart. */
function LastRoundCard({ stats, navigate }: {
  stats: RoundStats; navigate: (p: string) => void;
}) {
  const cells: [string, string][] = [
    ["Gross", String(stats.gross)],
    ["vs par", signed(stats.vsPar)],
    ["Putts", stats.putts != null ? String(stats.putts) : "—"],
    ["GIR", stats.girPct != null ? `${stats.girPct}%` : "—"],
    ["Diff", stats.differential != null ? stats.differential.toFixed(1) : "—"],
  ];

  return (
    <button
      onClick={() => navigate(`/round/${stats.id}`)}
      className="w-full text-left rounded-xl border border-border bg-card px-4 py-3.5 hover:border-primary/40 transition-colors"
    >
      <div className="flex items-baseline gap-2 mb-2.5">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          Last round
        </span>
        <span className="text-[10px] text-muted-foreground/70 ml-auto tabular">
          {stats.date} · {stats.holes}H{stats.tee ? ` · ${stats.tee}` : ""}
        </span>
      </div>
      <div className="font-semibold text-sm truncate mb-2.5">{stats.course}</div>
      <div className="grid grid-cols-5 gap-1">
        {cells.map(([label, value]) => (
          <div key={label}>
            <div className="text-[9px] text-muted-foreground leading-tight">{label}</div>
            <div className="font-display font-bold text-base tabular leading-tight">{value}</div>
          </div>
        ))}
      </div>
    </button>
  );
}

// ── Dashboard ──────────────────────────────────────────────────────────────

function DashboardInner() {
  const [, navigate] = useLocation();
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const { toast } = useToast();
  const queryClientHook = useQueryClient();

  const { data: roundList, isLoading } = useQuery<Round[]>({
    queryKey: ["/api/rounds"],
    staleTime: 0,
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/rounds");
      const data = await r.json();
      saveRoundsList(data);
      return data;
    },
  });

  // One batched fetch: position-1 player only, so a large imported round does
  // not drag the dashboard down.
  const justinRounds = useQuery<RoundDetail[]>({
    queryKey: ["/api/rounds/justin"],
    staleTime: 0,
    queryFn: async () => {
      const resp = await apiRequest("GET", "/api/rounds/justin");
      const data = await resp.json() as RoundDetail[];
      saveJustinRounds(data);
      return data;
    },
  });

  const allRounds = roundList ?? [];
  const details = justinRounds.data ?? [];

  // Every derived figure on this page comes from here
  const stats = useMemo(() => statsForRounds(details), [details]);
  const statsById = useMemo(() => {
    const m = new Map<string, RoundStats>();
    stats.forEach(s => m.set(s.id, s));
    return m;
  }, [stats]);

  const lastRound = stats.length ? stats[stats.length - 1] : null;
  const activeRounds = allRounds.filter(r => r.status === "active");

  // Round history, newest first, grouped by month
  const historyGroups = useMemo(() => {
    const groups: { label: string; rounds: Round[] }[] = [];
    [...allRounds]
      .sort((a, b) => b.date.localeCompare(a.date))
      .forEach(r => {
        const label = monthLabel(r.date);
        const last = groups[groups.length - 1];
        if (last && last.label === label) last.rounds.push(r);
        else groups.push({ label, rounds: [r] });
      });
    return groups;
  }, [allRounds]);

  // ── Handicap index ───────────────────────────────────────────────────────
  const { data: hiSetting } = useQuery<{ key: string; value: string }>({
    queryKey: ["/api/settings/handicap_index"],
  });
  const latestHcp = hiSetting?.value ? parseFloat(hiSetting.value) : null;

  const { data: lastSyncSetting } = useQuery<{ key: string; value: string }>({
    queryKey: ["/api/settings/ngap_last_sync"],
  });
  const lastSyncLabel = (() => {
    if (!lastSyncSetting?.value) return null;
    const d = new Date(lastSyncSetting.value);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleString("en-PH", {
      month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
      timeZone: "Asia/Manila",
    });
  })();

  const hiMutation = useMutation({
    mutationFn: (value: string) =>
      apiRequest("PATCH", "/api/settings/handicap_index", { value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/settings/handicap_index"] }),
  });

  const [editingHI, setEditingHI] = useState(false);
  const [hiDraft, setHiDraft] = useState("");
  const [ngapSyncConfirm, setNgapSyncConfirm] = useState(false);
  const [ngapPolling, setNgapPolling] = useState(false);
  const [showNgap, setShowNgap] = useState(false);

  const pollNgapStatus = () => {
    let attempts = 0;
    const MAX = 40;                                   // 40 × 3s = 2 min
    const interval = setInterval(async () => {
      attempts++;
      try {
        const r = await apiRequest("GET", "/api/ngap/sync/status");
        const data = await r.json();
        if (data.status === "done") {
          clearInterval(interval);
          setNgapPolling(false);
          qc.invalidateQueries({ queryKey: ["/api/settings/handicap_index"] });
          qc.invalidateQueries({ queryKey: ["/api/settings/ngap_last_sync"] });
          qc.invalidateQueries({ queryKey: ["/api/trends"] });
          toast({ title: "WHS index synced", description: `Now ${data.handicapIndex}`, duration: 5000 });
        } else if (data.status === "error") {
          clearInterval(interval);
          setNgapPolling(false);
          toast({ title: "NGAP sync failed", description: data.error, variant: "destructive" });
        } else if (attempts >= MAX) {
          clearInterval(interval);
          setNgapPolling(false);
          toast({ title: "NGAP sync timed out", description: "No response after 2 minutes", variant: "destructive" });
        }
      } catch {
        if (attempts >= MAX) { clearInterval(interval); setNgapPolling(false); }
      }
    }, 3000);
  };

  const ngapSyncMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/ngap/sync", {})).json(),
    onSuccess: () => {
      setNgapPolling(true);
      toast({ title: "Syncing from NGAP WHS…", description: "Takes about 30 seconds.", duration: 4000 });
      pollNgapStatus();
    },
    onError: (e: any) =>
      toast({ title: "NGAP sync failed", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => (await apiRequest("DELETE", `/api/rounds/${id}`)).json(),
    onSuccess: (_data, id) => {
      // Cache is only touched once the server has confirmed
      removeRoundFromCache(id as any);
      queryClientHook.setQueryData<Round[]>(["/api/rounds"],
        old => (old ?? []).filter(r => String(r.id) !== id));
      queryClientHook.setQueryData<RoundDetail[]>(["/api/rounds/justin"],
        old => (old ?? []).filter(d => String(d.round.id) !== id));
      toast({ title: "Round deleted" });
    },
    onError: () => {
      queryClientHook.invalidateQueries({ queryKey: ["/api/rounds"] });
      queryClientHook.invalidateQueries({ queryKey: ["/api/rounds/justin"] });
      toast({ title: "Failed to delete round", variant: "destructive" });
    },
  });

  const loadingHistory = isLoading || justinRounds.isLoading;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b border-border">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center gap-2">
          <svg viewBox="0 0 32 32" width="28" height="28" fill="none" aria-label="Golf Dash">
            <circle cx="16" cy="16" r="15" stroke="currentColor" strokeWidth="2" className="text-primary" />
            <path d="M16 8v12M16 8l-5 8M16 8l5 8" stroke="currentColor" strokeWidth="2.2"
                  strokeLinecap="round" strokeLinejoin="round" className="text-primary" />
            <circle cx="16" cy="24" r="2" fill="currentColor" className="text-accent" />
          </svg>
          <h1 className="font-display font-bold text-lg flex-1 truncate">Golf Dash</h1>
          <Button variant="ghost" size="sm" onClick={() => navigate("/courses")}
                  className="gap-1.5 text-muted-foreground hover:text-foreground"
                  data-testid="btn-nav-courses">
            <Flag size={15} /> Courses
          </Button>
          <Button data-testid="btn-new-round" size="sm" onClick={() => navigate("/new-round")}
                  className="gap-1.5">
            <Plus size={15} /> New Round
          </Button>
        </div>
        <div className="max-w-5xl mx-auto px-4 pb-2 flex justify-end">
          <SignInButton />
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-5 space-y-7">
        {/* In progress */}
        {activeRounds.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              In progress
            </h2>
            {activeRounds.map(r => (
              <Link key={r.id} href={`/round/${r.id}`}>
                <div className="flex items-center gap-3 p-3.5 rounded-xl border-2 border-accent/50 bg-accent/5 cursor-pointer hover:border-accent transition-colors">
                  <div className="w-9 h-9 rounded-lg bg-accent/20 flex items-center justify-center">
                    <Flag size={16} className="text-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate">{r.courseName}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {r.date} · {roundHoleLabel(r)} · {GAME_LABELS[r.gameType] ?? r.gameType}
                    </div>
                  </div>
                  <Badge className="bg-accent text-accent-foreground text-xs">Resume →</Badge>
                </div>
              </Link>
            ))}
          </div>
        )}

        {/* 1 · Index hero */}
        <section className="rounded-xl border border-border bg-card px-4 py-3.5">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                WHS handicap index
              </div>
              {editingHI ? (
                <div className="flex items-center gap-1 mt-1">
                  <Input
                    autoFocus type="number" step="0.1" min="0" max="54"
                    value={hiDraft}
                    onChange={e => setHiDraft(e.target.value)}
                    className="h-8 w-24 text-base font-bold tabular px-2"
                    data-testid="input-hi-value"
                    onKeyDown={e => {
                      if (e.key === "Enter") { hiMutation.mutate(hiDraft); setEditingHI(false); }
                      if (e.key === "Escape") setEditingHI(false);
                    }}
                  />
                  <button onClick={() => { hiMutation.mutate(hiDraft); setEditingHI(false); }}
                          className="text-green-600 hover:text-green-700" data-testid="button-hi-confirm">
                    <Check size={16} />
                  </button>
                  <button onClick={() => setEditingHI(false)}
                          className="text-muted-foreground hover:text-foreground" data-testid="button-hi-cancel">
                    <X size={16} />
                  </button>
                </div>
              ) : (
                <div className="font-display font-bold text-3xl tabular leading-none mt-1">
                  {latestHcp != null ? latestHcp.toFixed(1) : "—"}
                </div>
              )}
              {lastSyncLabel && !editingHI && (
                <p className="text-[9px] text-muted-foreground/60 mt-1.5">Pulled {lastSyncLabel}</p>
              )}
            </div>

            {!editingHI && (
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => setNgapSyncConfirm(true)}
                  className="text-muted-foreground/60 hover:text-primary transition-colors"
                  data-testid="button-sync-ngap" title="Sync from NGAP WHS"
                  disabled={ngapSyncMutation.isPending || ngapPolling}
                >
                  <RefreshCw size={14}
                    className={(ngapSyncMutation.isPending || ngapPolling) ? "animate-spin" : ""} />
                </button>
                <button
                  onClick={() => { setHiDraft(latestHcp != null ? String(latestHcp) : ""); setEditingHI(true); }}
                  className="text-muted-foreground/60 hover:text-primary transition-colors"
                  data-testid="button-edit-hi"
                >
                  <Pencil size={13} />
                </button>
              </div>
            )}
          </div>

          {/* Context row, so the index is not a number without a scale */}
          <div className="flex gap-5 mt-3 pt-3 border-t border-border">
            <div>
              <div className="text-[9px] text-muted-foreground leading-tight">Rounds</div>
              <div className="text-sm font-bold tabular">{allRounds.length}</div>
            </div>
            <div>
              <div className="text-[9px] text-muted-foreground leading-tight">Best diff</div>
              <div className="text-sm font-bold tabular">
                {(() => {
                  const ds = stats.map(s => s.differential).filter((d): d is number => d != null);
                  return ds.length ? Math.min(...ds).toFixed(1) : "—";
                })()}
              </div>
            </div>
            <div>
              <div className="text-[9px] text-muted-foreground leading-tight">Best gross</div>
              <div className="text-sm font-bold tabular">
                {(() => {
                  const g = stats.filter(s => s.holes === 18).map(s => s.gross);
                  return g.length ? Math.min(...g) : "—";
                })()}
              </div>
            </div>
          </div>
        </section>

        {/* 2 · Last round */}
        {lastRound && <LastRoundCard stats={lastRound} navigate={navigate} />}

        {/* 3 · Trend */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Scoring trend
          </h2>
          {loadingHistory
            ? <Skeleton className="h-56 w-full rounded-xl" />
            : <TrendChart rounds={stats} />}
        </section>

        {/* 4–6 · Scoring mix, strokes by par, short game */}
        {loadingHistory
          ? <div className="space-y-3">
              <Skeleton className="h-9 w-full rounded-md" />
              <Skeleton className="h-24 w-full rounded-xl" />
            </div>
          : <InsightPanel rounds={stats} />}

        {/* 7 · The official record, folded away — it is a reconciliation tool,
            not something to read every visit */}
        <section>
          <button
            onClick={() => setShowNgap(v => !v)}
            className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronDown size={14} className={`transition-transform ${showNgap ? "" : "-rotate-90"}`} />
            Compare with NGAP record
          </button>
          {showNgap && <div className="mt-4"><PerformancePanel /></div>}
        </section>

        {/* 8 · History */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Round history
          </h2>

          {loadingHistory ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
            </div>
          ) : allRounds.length === 0 ? (
            <div className="text-center py-14 space-y-3">
              <div className="w-14 h-14 mx-auto rounded-full bg-muted flex items-center justify-center">
                <Trophy size={24} className="text-muted-foreground" />
              </div>
              <h3 className="font-semibold">No rounds yet</h3>
              <p className="text-sm text-muted-foreground max-w-xs mx-auto">
                Start your first round and your scoring, handicap and stats build from there.
              </p>
              <Button onClick={() => navigate("/new-round")} className="gap-1.5 mt-2">
                <Plus size={15} /> Start first round
              </Button>
            </div>
          ) : (
            <div className="space-y-5">
              <p className="text-[10px] text-muted-foreground/60 text-right">
                ← Swipe a round to edit or delete
              </p>
              {historyGroups.map(group => (
                <div key={group.label} className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-[11px] font-semibold text-muted-foreground">{group.label}</h3>
                    <span className="text-[10px] text-muted-foreground/50 tabular">
                      {group.rounds.length}
                    </span>
                  </div>
                  {group.rounds.map(r => (
                    <SwipeableRoundCard
                      key={r.id}
                      round={r}
                      stats={statsById.get(String(r.id)) ?? null}
                      onDelete={id => setDeleteConfirmId(id)}
                      navigate={navigate}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {/* NGAP sync confirmation */}
      <AlertDialog open={ngapSyncConfirm} onOpenChange={setNgapSyncConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sync from NGAP WHS?</AlertDialogTitle>
            <AlertDialogDescription>
              Fetches your latest handicap index from the NGAP WHS portal and updates it here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setNgapSyncConfirm(false); ngapSyncMutation.mutate(); }}
            >
              Sync now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation */}
      <AlertDialog open={deleteConfirmId !== null}
                   onOpenChange={open => { if (!open) setDeleteConfirmId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this round?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the round and all its scores. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-500 hover:bg-red-600 text-white"
              onClick={() => {
                if (deleteConfirmId !== null) {
                  deleteMutation.mutate(deleteConfirmId);
                  setDeleteConfirmId(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The dashboard is the one place that requires sign-in. */
export default function Dashboard() {
  return (
    <AuthGate>
      <DashboardInner />
    </AuthGate>
  );
}
