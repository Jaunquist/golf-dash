import PerformancePanel from "@/components/PerformancePanel";
import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, Link } from "wouter";
import { apiRequest, queryClient as qc } from "@/lib/queryClient";
import { saveRoundsList, saveJustinRounds, removeRoundFromCache } from "@/lib/roundsCache";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, Flag, TrendingDown, Target, Activity, Trophy, User, Trash2, Pencil, Check, X, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, ReferenceLine
} from "recharts";
import type { Round, RoundPlayer, HoleScore } from "@shared/schema";
import { handicapStrokesOnHole } from "@/lib/gameEngine";

const GAME_LABELS: Record<string, string> = {
  best_ball: "Best Ball",
  best_ball_pairs: "Best Ball Pairs",
  high_low: "High Low",
  high_low_pairs: "High Low Pairs",
  niners: "Niners",
  twelves: "Twelves",
  match_play: "Match Play",
};

interface RoundDetail {
  round: Round;
  players: RoundPlayer[];
  scores: HoleScore[];
}

// Approximate WHS handicap differential for a round
function calcHandicapDifferential(grossScore: number, totalPar: number, courseHandicap: number): number {
  const adjusted = grossScore - courseHandicap * 0.85;
  return Math.round((adjusted - totalPar) * 10) / 10;
}

/** Returns a short label like "9H · Front" or "9H · Back" or "18H" */
function roundHoleLabel(round: Round): string {
  if (round.holes === 18) return "18H";
  try {
    const opts = JSON.parse(round.gameOptions || "{}");
    const nt = opts?.nineType;
    if (nt === "back") return "9H · Back";
    if (nt === "front") return "9H · Front";
  } catch {}
  return "9H";
}

function getRoundScoreSummary(detail: RoundDetail) {
  const pars: number[] = JSON.parse(detail.round.pars);
  const totalPar = pars.reduce((s, p) => s + p, 0);
  const justinPlayer = detail.players.find(p => p.position === 1);
  if (!justinPlayer) return null;
  const justinScores = detail.scores.filter(s => s.playerId === justinPlayer.id);
  const totalStrokes = justinScores.reduce((s, sc) => s + (sc.strokes ?? 0), 0);
  const totalPutts = justinScores.reduce((s, sc) => s + (sc.putts ?? 0), 0);
  const holesPlayed = justinScores.filter(s => s.strokes != null).length;
  const scoreDiff = totalStrokes - totalPar;
  return { totalStrokes, totalPutts, holesPlayed, scoreDiff, totalPar, justinPlayer };
}

// Compute net score for Justin over all holes
function getJustinNetScore(detail: RoundDetail): number | null {
  const pars: number[] = JSON.parse(detail.round.pars);
  const holeHcps: number[] = JSON.parse(detail.round.holeHandicaps);
  const holes = detail.round.holes;
  const justinPlayer = detail.players.find(p => p.position === 1);
  if (!justinPlayer) return null;
  const justinScores = detail.scores.filter(s => s.playerId === justinPlayer.id && s.strokes != null);
  if (justinScores.length === 0) return null;
  let net = 0;
  for (const sc of justinScores) {
    const gross = sc.strokes!;
    const holeHcpRank = holeHcps[sc.hole - 1] ?? sc.hole;
    const strokes = handicapStrokesOnHole(justinPlayer.courseHandicap, holeHcpRank, holes);
    net += gross - strokes;
  }
  return net;
}


// ── Swipeable Round Card ──────────────────────────────────────────────────────
const SWIPE_THRESHOLD = 60;
const ACTION_WIDTH = 128; // px revealed when fully swiped

interface SwipeableRoundCardProps {
  round: Round;
  summary: ReturnType<typeof getRoundScoreSummary>;
  onDelete: (id: number) => void;
  navigate: (path: string) => void;
}

function SwipeableRoundCard({ round, summary, onDelete, navigate }: SwipeableRoundCardProps) {
  const [offset, setOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const currentOffsetRef = useRef(0);
  const cardRef = useRef<HTMLDivElement>(null);

  const diff = summary ? summary.scoreDiff : null;

  const snapTo = useCallback((target: number) => {
    setOffset(target);
    currentOffsetRef.current = target;
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Don't hijack clicks on buttons
    if ((e.target as HTMLElement).closest("button")) return;
    startXRef.current = e.clientX;
    setIsDragging(true);
    cardRef.current?.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;
    const delta = e.clientX - startXRef.current;
    const raw = currentOffsetRef.current + delta;
    // Only allow swiping left (negative) up to ACTION_WIDTH
    const clamped = Math.max(-ACTION_WIDTH, Math.min(0, raw));
    setOffset(clamped);
  }, [isDragging]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;
    setIsDragging(false);
    const delta = e.clientX - startXRef.current;
    const totalMove = currentOffsetRef.current + delta;

    if (totalMove < -SWIPE_THRESHOLD) {
      // Snap open
      snapTo(-ACTION_WIDTH);
    } else {
      // Snap closed
      snapTo(0);
    }
  }, [isDragging, snapTo]);

  const handleCardClick = useCallback(() => {
    // If actions are revealed, a tap anywhere on card closes them
    if (offset < -10) {
      snapTo(0);
      return;
    }
    navigate(`/round/${round.id}`);
  }, [offset, round.id, navigate, snapTo]);

  return (
    <div className="relative overflow-hidden rounded-xl" data-testid={`swipeable-round-${round.id}`}>
      {/* Action buttons revealed behind the card */}
      <div
        className="absolute inset-y-0 right-0 flex items-stretch"
        style={{ width: ACTION_WIDTH }}
        aria-hidden={offset === 0}
      >
        {/* Edit — navigate to scorecard */}
        <button
          className="flex-1 flex flex-col items-center justify-center gap-1 bg-blue-500 hover:bg-blue-600 text-white text-[11px] font-semibold transition-colors"
          data-testid={`btn-edit-round-${round.id}`}
          onClick={() => { snapTo(0); navigate(`/round/${round.id}`); }}
        >
          <Pencil size={15} />
          Edit
        </button>
        {/* Delete */}
        <button
          className="flex-1 flex flex-col items-center justify-center gap-1 bg-red-500 hover:bg-red-600 text-white text-[11px] font-semibold transition-colors rounded-r-xl"
          data-testid={`btn-delete-round-${round.id}`}
          onClick={() => { snapTo(0); onDelete(round.id); }}
        >
          <Trash2 size={15} />
          Delete
        </button>
      </div>

      {/* Card surface — slides left to reveal actions */}
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
          <div className="text-xs text-muted-foreground">{round.date} · {roundHoleLabel(round)} · {GAME_LABELS[round.gameType]}</div>
        </div>
        <div className="text-right flex-shrink-0">
          {summary && (
            <>
              <div className="font-bold tabular text-sm">{summary.totalStrokes}</div>
              <div className={`text-xs tabular ${diff! > 0 ? "text-orange-500" : diff! < 0 ? "text-green-600" : "text-muted-foreground"}`}>
                {diff! > 0 ? `+${diff}` : diff === 0 ? "E" : diff} vs par
              </div>
            </>
          )}
          {round.status === "active" && <Badge variant="outline" className="text-[10px]">Active</Badge>}
          {round.status === "complete" && !summary && <Badge className="text-[10px] bg-muted text-muted-foreground">Done</Badge>}
        </div>
        {/* Swipe hint chevron — only when closed */}
        {offset === 0 && (
          <div className="ml-1 text-muted-foreground/30 flex-shrink-0">
            <svg width="10" height="16" viewBox="0 0 10 16" fill="none">
              <path d="M7 2L2 8l5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState("overview");
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const { toast } = useToast();
  const queryClientHook = useQueryClient();

  const { data: roundList, isLoading } = useQuery<Round[]>({
    queryKey: ["/api/rounds"],
    staleTime: 0,
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/rounds");
      const data = await r.json();
      saveRoundsList(data); // persist for instant load next time
      return data;
    },
  });

  // Single batched fetch: only Justin (position=1) per round — avoids loading 288-player CSV imports
  const allRounds = roundList ?? [];
  const justinRounds = useQuery<RoundDetail[]>({
    queryKey: ["/api/rounds/justin"],
    staleTime: 0,
    queryFn: async () => {
      const resp = await apiRequest("GET", "/api/rounds/justin");
      const data = await resp.json() as RoundDetail[];
      saveJustinRounds(data); // persist for instant load next time
      return data;
    },
  });

  const details = justinRounds.data ?? [];
  const summaries = details
    .map(d => ({ ...d, summary: getRoundScoreSummary(d) }))
    .filter(d => d.summary !== null)
    .sort((a, b) => a.round.date.localeCompare(b.round.date));

  // ── Real WHS Handicap Index history from NGAP (member index) ──────────
  const NGAP_HI_HISTORY = [
    { date: "2025-04-13", hi: 30.2, course: "Hallow Ridge" },
    { date: "2025-04-17", hi: 31.2, course: "West Course" },
    { date: "2025-04-18", hi: 32.2, course: "Tagaytay Highlands" },
    { date: "2025-04-28", hi: 33.6, course: "West Course" },
    { date: "2025-05-24", hi: 34.6, course: "Navy" },
    { date: "2025-05-04", hi: 34.6, course: "North Course" },
    { date: "2025-06-22", hi: 33.2, course: "Veterans" },
    { date: "2025-07-06", hi: 30.2, course: "Royal Northwoods" },
    { date: "2025-07-13", hi: 30.2, course: "Mt. Malipunyo" },
    { date: "2025-08-10", hi: 30.7, course: "Hallow Ridge" },
    { date: "2025-08-12", hi: 29.4, course: "Alabang" },
    { date: "2025-08-13", hi: 28.1, course: "Tagaytay Midlands" },
    { date: "2025-08-17", hi: 28.9, course: "West Course" },
    { date: "2025-08-25", hi: 28.9, course: "Alabang" },
    { date: "2025-09-06", hi: 29.4, course: "Alabang" },
    { date: "2025-09-07", hi: 29.2, course: "North Course" },
    { date: "2025-09-09", hi: 29.6, course: "Camp Aguinaldo" },
    { date: "2025-10-26", hi: 30.1, course: "Mt. Malipunyo" },
    { date: "2025-11-08", hi: 30.1, course: "Tagaytay Highlands" },
    { date: "2025-11-16", hi: 30.3, course: "Mt. Makulot" },
    { date: "2025-11-23", hi: 30.3, course: "Palmer" },
    { date: "2025-11-29", hi: 30.3, course: "Alabang" },
    { date: "2025-12-07", hi: 29.8, course: "North Course" },
    { date: "2025-12-14", hi: 29.4, course: "Palmer" },
    { date: "2025-12-16", hi: 29.4, course: "Alabang" },
    { date: "2025-12-18", hi: 29.4, course: "North Course" },
    { date: "2025-12-23", hi: 29.6, course: "Alabang" },
    { date: "2025-12-26", hi: 29.6, course: "Hallow Ridge" },
    { date: "2026-01-04", hi: 28.9, course: "Legends" },
    { date: "2026-01-11", hi: 28.9, course: "Hallow Ridge" },
    { date: "2026-01-15", hi: 29.6, course: "Hallow Ridge" },
    { date: "2026-01-18", hi: 29.9, course: "Nicklaus" },
    { date: "2026-01-25", hi: 29.3, course: "Alabang" },
    { date: "2026-02-02", hi: 29.3, course: "Navy" },
    { date: "2026-02-05", hi: 28.9, course: "South Course" },
    { date: "2026-02-06", hi: 25.1, course: "Makiling" },
    { date: "2026-02-12", hi: 25.1, course: "Alabang" },
    { date: "2026-02-13", hi: 25.1, course: "North Course" },
    { date: "2026-02-15", hi: 25.1, course: "North Course" },
    { date: "2026-02-18", hi: 25.1, course: "Banahaw" },
    { date: "2026-02-19", hi: 25.1, course: "Navy" },
    { date: "2026-02-26", hi: 24.6, course: "East Course" },
    { date: "2026-02-28", hi: 24.6, course: "Legends" },
    { date: "2026-03-04", hi: 24.6, course: "Summit Point" },
    { date: "2026-03-16", hi: 24.6, course: "Alabang" },
    { date: "2026-03-19", hi: 24.6, course: "Villamor" },
    { date: "2026-03-21", hi: 24.6, course: "Hallow Ridge" },
    { date: "2026-03-26", hi: 24.4, course: "East Course" },
    { date: "2026-03-27", hi: 25.0, course: "Ayala Greenfield" },
    { date: "2026-04-03", hi: 25.0, course: "Mt. Lobo" },
    { date: "2026-04-07", hi: 25.0, course: "South Course" },
    { date: "2026-04-09", hi: 24.8, course: "Hallow Ridge" },
    { date: "2026-04-11", hi: 25.1, course: "Hallow Ridge" },
    { date: "2026-04-18", hi: 25.1, course: "Hallow Ridge" },
    { date: "2026-04-23", hi: 27.5, course: "NGAP" },
    { date: "2026-05-30", hi: 27.5, course: "NGAP" },
    { date: "2026-06-02", hi: 27.5, course: "NGAP" },
    { date: "2026-06-03", hi: 27.5, course: "NGAP" },
  ].sort((a, b) => a.date.localeCompare(b.date));

  // ── HI Trend: sorted source ───────────────────────────────────────────────
  const hiSorted = [...NGAP_HI_HISTORY].sort((a, b) => a.date.localeCompare(b.date));
  const lastScoreEntry = hiSorted[hiSorted.length - 1];
  const lastScoreDate = lastScoreEntry
    ? new Date(lastScoreEntry.date).toLocaleDateString("en-PH", {
        month: "short", day: "numeric", year: "numeric",
      })
    : null;

  // View toggle state
  const [hiView, setHiView] = useState<"365d" | "monthly" | "yearly" | "lifetime">("365d");

  // ── 365d: last 365 days, one point per score ──────────────────────────────
  const cutoff365 = new Date(); cutoff365.setFullYear(cutoff365.getFullYear() - 1);
  const ngapChartData365 = hiSorted
    .filter(d => new Date(d.date) >= cutoff365)
    .map(d => ({
      date: d.date.slice(5).replace("-", "/"), // MM/DD
      fullDate: d.date,
      hi: d.hi,
      course: d.course,
      label: d.date.slice(5).replace("-", "/"),
    }));

  // ── Monthly: last 24 months, last HI per month ────────────────────────────
  const cutoffMonthly = new Date(); cutoffMonthly.setMonth(cutoffMonthly.getMonth() - 24);
  const monthlyMap: Record<string, typeof hiSorted[0]> = {};
  hiSorted.filter(d => new Date(d.date) >= cutoffMonthly).forEach(d => {
    const key = d.date.slice(0, 7); // YYYY-MM
    monthlyMap[key] = d; // last entry for that month wins (sorted asc)
  });
  const ngapChartDataMonthly = Object.entries(monthlyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, d]) => ({
      date: key.slice(0, 7),
      fullDate: d.date,
      hi: d.hi,
      course: d.course,
      label: new Date(key + "-01").toLocaleDateString("en-PH", { month: "short", year: "2-digit" }),
    }));

  // ── Yearly: lowest HI per calendar year ──────────────────────────────────
  const yearlyMap: Record<string, typeof hiSorted[0]> = {};
  hiSorted.forEach(d => {
    const yr = d.date.slice(0, 4);
    if (!yearlyMap[yr] || d.hi < yearlyMap[yr].hi) yearlyMap[yr] = d;
  });
  const ngapChartDataYearly = Object.entries(yearlyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([yr, d]) => ({
      date: yr,
      fullDate: d.date,
      hi: d.hi,
      course: d.course,
      label: yr,
    }));

  // ── Lifetime: all data, one point per score ───────────────────────────────
  const ngapChartDataLifetime = hiSorted.map(d => ({
    date: d.date.slice(0, 7), // YYYY-MM for label
    fullDate: d.date,
    hi: d.hi,
    course: d.course,
    label: d.date.slice(2, 7).replace("-", "/"), // YY/MM
  }));

  // Active dataset based on view
  const activeNgapData = hiView === "365d" ? ngapChartData365
    : hiView === "monthly" ? ngapChartDataMonthly
    : hiView === "yearly" ? ngapChartDataYearly
    : ngapChartDataLifetime;

  // Dynamic Y domain for active data
  const hiValues = activeNgapData.map(d => d.hi);
  const hiMin = hiValues.length ? Math.floor(Math.min(...hiValues) - 1) : 22;
  const hiMax = hiValues.length ? Math.ceil(Math.max(...hiValues) + 1) : 36;
  const lowHI = hiSorted.length ? Math.min(...hiSorted.map(d => d.hi)) : 24.4;

  // Backward compat alias used elsewhere
  const ngapChartData = ngapChartData365;

  // Local round-derived data for putts/score charts (kept for local stats)
  const handicapData = summaries.map((d, i) => {
    const s = d.summary!;
    const diff = calcHandicapDifferential(s.totalStrokes, s.totalPar, s.justinPlayer.courseHandicap);
    const netScore = getJustinNetScore(d);
    return {
      date: d.round.date.slice(5),
      course: d.round.courseName,
      handicap: Math.max(0, Math.round((s.justinPlayer.courseHandicap) * 10) / 10),
      diff: Math.round(diff * 10) / 10,
      grossScore: s.totalStrokes,
      par: s.totalPar,
      scoreDiff: s.scoreDiff,
      putts: s.totalPutts,
      puttsPerHole: s.holesPlayed > 0 ? Math.round((s.totalPutts / s.holesPlayed) * 100) / 100 : 0,
      netScore,
      // net score relative to course par — comparable across 9H and 18H rounds
      netVsPar: netScore != null ? netScore - s.totalPar : null,
    };
  });

  // ── Live HI from settings ────────────────────────────────────────────────
  const { data: hiSetting, refetch: refetchHI } = useQuery<{ key: string; value: string }>({
    queryKey: ["/api/settings/handicap_index"],
  });
  const latestHcp = hiSetting ? parseFloat(hiSetting.value) : 25.6;

  // ── Last NGAP sync timestamp ─────────────────────────────────────────────
  const { data: lastSyncSetting } = useQuery<{ key: string; value: string }>({
    queryKey: ["/api/settings/ngap_last_sync"],
  });
  const lastSyncLabel = (() => {
    if (!lastSyncSetting?.value) return null;
    const d = new Date(lastSyncSetting.value);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleString("en-PH", {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
      timeZone: "Asia/Manila",
    });
  })();

  const hiMutation = useMutation({
    mutationFn: (value: string) =>
      apiRequest("PATCH", "/api/settings/handicap_index", { value }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/settings/handicap_index"] }); },
  });

  const [editingHI, setEditingHI] = useState(false);
  const [hiDraft, setHiDraft] = useState("");
  const [ngapSyncConfirm, setNgapSyncConfirm] = useState(false);
  const [ngapPolling, setNgapPolling] = useState(false);

  // Poll /api/ngap/sync/status after triggering sync
  const pollNgapStatus = () => {
    let attempts = 0;
    const MAX = 40; // 40 x 3s = 2 min max
    const interval = setInterval(async () => {
      attempts++;
      try {
        const r = await apiRequest("GET", "/api/ngap/sync/status");
        const data = await r.json();
        if (data.status === "done") {
          clearInterval(interval);
          setNgapPolling(false);
          queryClient.invalidateQueries({ queryKey: ["/api/settings/handicap_index"] });
          queryClient.invalidateQueries({ queryKey: ["/api/settings/ngap_last_sync"] });
          toast({ title: "WHS Index synced ✓", description: `Handicap Index updated to ${data.handicapIndex}`, duration: 5000 });
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
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/ngap/sync", {});
      return r.json();
    },
    onSuccess: () => {
      setNgapPolling(true);
      toast({ title: "Syncing from NGAP WHS…", description: "This takes ~30s. Hang tight.", duration: 4000 });
      pollNgapStatus();
    },
    onError: (e: any) => toast({ title: "NGAP sync failed", description: e.message, variant: "destructive" }),
  });
  const avgPuttsPerHole = handicapData.length
    ? Math.round(handicapData.reduce((s, d) => s + d.puttsPerHole, 0) / handicapData.length * 100) / 100
    : 0;
  const avgScoreDiff = handicapData.length
    ? Math.round(handicapData.reduce((s, d) => s + d.scoreDiff, 0) / handicapData.length * 10) / 10
    : 0;

  const activeRounds = roundList?.filter(r => r.status === "active") ?? [];

  // Justin's personal stats rows (for My Stats tab) — all rounds not just completed
  // Reuse the same justinRounds query — no second waterfall fetch needed
  const allRoundDetails = justinRounds;

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      // Hit server FIRST — only update cache/localStorage after confirmed
      const r = await apiRequest("DELETE", `/api/rounds/${id}`);
      return r.json();
    },
    onSuccess: (_data, id) => {
      // Server confirmed deletion — now remove from localStorage and cache
      removeRoundFromCache(id);
      queryClientHook.setQueryData<Round[]>(
        ["/api/rounds"],
        (old) => (old ?? []).filter(r => r.id !== id)
      );
      queryClientHook.setQueryData<RoundDetail[]>(
        ["/api/rounds/justin"],
        (old) => (old ?? []).filter(d => d.round.id !== id)
      );
      toast({ title: "Round deleted" });
    },
    onError: () => {
      // Server failed — don't touch cache or localStorage, refetch to sync
      queryClientHook.invalidateQueries({ queryKey: ["/api/rounds"] });
      queryClientHook.invalidateQueries({ queryKey: ["/api/rounds/justin"] });
      toast({ title: "Failed to delete round", variant: "destructive" });
    },
  });

  const myStatsRows = (allRoundDetails.data ?? [])
    .map(d => {
      const summary = getRoundScoreSummary(d);
      if (!summary) return null;
      const net = getJustinNetScore(d);
      const netVsPar = net != null ? net - summary.totalPar : null;
      return {
        id: d.round.id,
        date: d.round.date,
        location: d.round.courseName,
        gross: summary.totalStrokes,
        courseHcp: summary.justinPlayer.courseHandicap,
        net,
        netVsPar,
        totalPar: summary.totalPar,
        totalPutts: summary.totalPutts,
        status: d.round.status,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b!.date.localeCompare(a!.date)) as {
      id: number; date: string; location: string; gross: number;
      courseHcp: number | null; net: number | null; totalPutts: number; status: string;
    } & { netVsPar: number | null; totalPar: number }[];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b border-border">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center gap-3">
          {/* Logo */}
          <svg viewBox="0 0 32 32" width="28" height="28" fill="none" aria-label="Fairway logo">
            <circle cx="16" cy="16" r="15" stroke="currentColor" strokeWidth="2" className="text-primary" />
            <path d="M16 8v12M16 8l-5 8M16 8l5 8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-primary" />
            <circle cx="16" cy="24" r="2" fill="currentColor" className="text-accent" />
          </svg>
          <h1 className="font-display font-bold text-lg flex-1">Golf Dash</h1>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/courses")}
            className="gap-1.5 text-muted-foreground hover:text-foreground"
            data-testid="btn-nav-courses"
          >
            <Flag size={15} /> Courses
          </Button>
          <Button
            data-testid="btn-new-round"
            size="sm"
            onClick={() => navigate("/new-round")}
            className="gap-1.5"
          >
            <Plus size={15} /> New Round
          </Button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-6 w-full max-w-xs">
            <TabsTrigger value="overview" className="flex-1 gap-1.5 text-xs">
              <Trophy size={13} /> Overview
            </TabsTrigger>
            <TabsTrigger value="my-stats" className="flex-1 gap-1.5 text-xs" data-testid="tab-my-stats">
              <User size={13} /> My Stats
            </TabsTrigger>
          </TabsList>

          {/* ── OVERVIEW TAB ── */}
          <TabsContent value="overview" className="space-y-8">
            {/* Active Rounds Banner */}
            {activeRounds.length > 0 && (
              <div className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">In Progress</h2>
                {activeRounds.map(r => (
                  <Link key={r.id} href={`/round/${r.id}`}>
                    <div className="flex items-center gap-3 p-3.5 rounded-xl border-2 border-accent/50 bg-accent/5 cursor-pointer hover:border-accent transition-colors">
                      <div className="w-9 h-9 rounded-lg bg-accent/20 flex items-center justify-center">
                        <Flag size={16} className="text-accent" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold truncate">{r.courseName}</div>
                        <div className="text-xs text-muted-foreground">{r.date} · {roundHoleLabel(r)} · {GAME_LABELS[r.gameType]}</div>
                      </div>
                      <Badge className="bg-accent text-accent-foreground text-xs">Active →</Badge>
                    </div>
                  </Link>
                ))}
              </div>
            )}

            {/* KPI Cards */}
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Your Stats</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Card>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center gap-2 mb-1">
                      <Target size={14} className="text-primary" />
                      <span className="text-xs text-muted-foreground">WHS Index</span>
                      {!editingHI && (
                        <div className="ml-auto flex items-center gap-1">
                          <button
                            onClick={() => setNgapSyncConfirm(true)}
                            className="text-muted-foreground/50 hover:text-primary transition-colors"
                            data-testid="button-sync-ngap"
                            title="Sync from NGAP WHS"
                            disabled={ngapSyncMutation.isPending || ngapPolling}
                          >
                            <RefreshCw size={11} className={(ngapSyncMutation.isPending || ngapPolling) ? "animate-spin" : ""} />
                          </button>
                          <button
                            onClick={() => { setHiDraft(String(latestHcp)); setEditingHI(true); }}
                            className="text-muted-foreground/50 hover:text-primary transition-colors"
                            data-testid="button-edit-hi"
                          >
                            <Pencil size={11} />
                          </button>
                        </div>
                      )}
                    </div>
                    {editingHI ? (
                      <div className="flex items-center gap-1 mt-1">
                        <Input
                          autoFocus
                          type="number"
                          step="0.1"
                          min="0"
                          max="54"
                          value={hiDraft}
                          onChange={e => setHiDraft(e.target.value)}
                          className="h-7 w-20 text-sm font-bold tabular px-2"
                          data-testid="input-hi-value"
                          onKeyDown={e => {
                            if (e.key === "Enter") {
                              hiMutation.mutate(hiDraft);
                              setEditingHI(false);
                            }
                            if (e.key === "Escape") setEditingHI(false);
                          }}
                        />
                        <button
                          onClick={() => { hiMutation.mutate(hiDraft); setEditingHI(false); }}
                          className="text-green-600 hover:text-green-700"
                          data-testid="button-hi-confirm"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          onClick={() => setEditingHI(false)}
                          className="text-muted-foreground hover:text-foreground"
                          data-testid="button-hi-cancel"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <div className="font-display font-bold text-xl tabular">{latestHcp}</div>
                    )}
                    {lastSyncLabel && (
                      <p className="text-[9px] text-muted-foreground/60 mt-1 leading-tight">
                        Pulled {lastSyncLabel}
                      </p>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center gap-2 mb-1">
                      <Flag size={14} className="text-primary" />
                      <span className="text-xs text-muted-foreground">Rounds Played</span>
                    </div>
                    {isLoading ? <Skeleton className="h-8 w-16" /> : (
                      <div className="font-display font-bold text-xl tabular">{allRounds.length}</div>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center gap-2 mb-1">
                      <Activity size={14} className="text-primary" />
                      <span className="text-xs text-muted-foreground">Avg Putts/Hole</span>
                    </div>
                    {isLoading ? <Skeleton className="h-8 w-16" /> : (
                      <div className="font-display font-bold text-xl tabular">{avgPuttsPerHole || "—"}</div>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center gap-2 mb-1">
                      <TrendingDown size={14} className="text-primary" />
                      <span className="text-xs text-muted-foreground">Avg Score vs Par</span>
                    </div>
                    {isLoading ? <Skeleton className="h-8 w-16" /> : (
                      <div className={`font-display font-bold text-xl tabular ${avgScoreDiff > 0 ? "text-orange-500" : avgScoreDiff < 0 ? "text-green-600" : ""}`}>
                        {avgScoreDiff ? (avgScoreDiff > 0 ? `+${avgScoreDiff}` : avgScoreDiff) : "—"}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
<PerformancePanel />

            {/* Handicap Index Trend — real WHS data from NGAP */}
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-sm font-semibold">Handicap Index Trend</CardTitle>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Source: NGAP WHS · Member index · {hiSorted.length} scores
                      {lastScoreDate && <> · Last score: <span className="font-medium">{lastScoreDate}</span></>}
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-display font-bold tabular text-primary">{latestHcp}</div>
                    <div className="text-[10px] text-muted-foreground">Current HI®</div>
                  </div>
                </div>
                {/* View toggle */}
                <div className="flex gap-1 mt-2">
                  {(["365d", "monthly", "yearly", "lifetime"] as const).map((v) => (
                    <button
                      key={v}
                      onClick={() => setHiView(v)}
                      className={[
                        "px-2 py-0.5 rounded text-[10px] font-medium transition-colors",
                        hiView === v
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:text-foreground",
                      ].join(" ")}
                    >
                      {v === "365d" ? "365 Days" : v === "monthly" ? "Monthly" : v === "yearly" ? "Yearly" : "Lifetime"}
                    </button>
                  ))}
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={activeNgapData} margin={{ top: 8, right: 16, left: -8, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                      interval={Math.max(0, Math.floor(activeNgapData.length / (hiView === "yearly" ? 1 : 8)))}
                    />
                    <YAxis
                      domain={[hiMin, hiMax]}
                      tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                      tickFormatter={(v) => v.toFixed(1)}
                    />
                    <Tooltip
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 11 }}
                      formatter={(v: number) => [v.toFixed(1), "HI®"]}
                      labelFormatter={(_, items) => {
                        const p = items[0]?.payload;
                        if (!p) return "";
                        if (hiView === "yearly") return `${p.date} — Low HI (${p.course} · ${p.fullDate})`;
                        if (hiView === "monthly") return `${p.label} — ${p.course} · ${p.fullDate}`;
                        return `${p.course} · ${p.fullDate}`;
                      }}
                    />
                    {/* Low HI reference line */}
                    <ReferenceLine
                      y={lowHI}
                      stroke="hsl(var(--chart-1))"
                      strokeDasharray="4 2"
                      label={{ value: `Low ${lowHI.toFixed(1)}`, position: "insideTopRight", fontSize: 9, fill: "hsl(var(--chart-1))" }}
                    />
                    {/* Current HI reference line */}
                    <ReferenceLine
                      y={latestHcp}
                      stroke="hsl(var(--primary))"
                      strokeDasharray="4 2"
                      label={{ value: `Now ${latestHcp}`, position: "insideBottomRight", fontSize: 9, fill: "hsl(var(--primary))" }}
                    />
                    <Line
                      type="monotone"
                      dataKey="hi"
                      stroke="hsl(var(--chart-2))"
                      strokeWidth={2}
                      dot={hiView === "yearly" || activeNgapData.length <= 30 ? { r: 3, fill: "hsl(var(--chart-2))" } : false}
                      activeDot={{ r: 5, fill: "hsl(var(--chart-2))" }}
                    />
                  </LineChart>
                </ResponsiveContainer>
                <div className="flex items-center justify-center mt-1 text-[9px] text-muted-foreground gap-4">
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-6 h-0.5 bg-chart-1 opacity-60" />
                    {hiView === "yearly" ? `Career Low ${lowHI.toFixed(1)}` : `Low HI ${lowHI.toFixed(1)}`}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-6 h-0.5 bg-primary opacity-60" />
                    Current {latestHcp}
                  </span>
                </div>
              </CardContent>
            </Card>

            {/* Charts — only show when we have data */}
            {handicapData.length > 1 && (
              <div className="grid md:grid-cols-2 gap-6">
                {/* Net score vs par trend */}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-semibold">Net Score Trend <span className="text-xs font-normal text-muted-foreground">(vs par)</span></CardTitle>
                  </CardHeader>
                  <CardContent>
                    {(() => {
                      const nvpData = handicapData.filter(d => d.netVsPar != null);
                      const avgNvp = nvpData.length ? Math.round(nvpData.reduce((s, d) => s + d.netVsPar!, 0) / nvpData.length) : 0;
                      return (
                      <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={nvpData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                          <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                            tickFormatter={(v: number) => v >= 0 ? `+${v}` : `${v}`} />
                          <Tooltip
                            contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                            formatter={(v: number) => [v >= 0 ? `+${v}` : `${v}`, "Net vs Par"]}
                            labelFormatter={(label, payload) => {
                              const d = payload?.[0]?.payload;
                              return d ? `${label} · ${d.course} (Par ${d.par})` : label;
                            }}
                          />
                          <ReferenceLine y={0} stroke="hsl(var(--chart-3))" strokeWidth={1.5}
                            label={{ value: "E", position: "right", fontSize: 9, fill: "hsl(var(--chart-3))" }} />
                          <ReferenceLine y={avgNvp} stroke="hsl(var(--chart-3))" strokeDasharray="4 2"
                            label={{ value: `Avg ${avgNvp >= 0 ? "+" : ""}${avgNvp}`, position: "right", fontSize: 9, fill: "hsl(var(--chart-3))" }} />
                          <Line
                            type="monotone"
                            dataKey="netVsPar"
                            stroke="hsl(var(--chart-2))"
                            strokeWidth={2.5}
                            dot={({ cx, cy, payload }) => {
                              const color = payload.netVsPar <= avgNvp ? "#16a34a" : "hsl(var(--chart-2))";
                              return <circle key={cx} cx={cx} cy={cy} r={4} fill={color} stroke="none" />;
                            }}
                            activeDot={{ r: 6 }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                      );
                    })()}
                  </CardContent>
                </Card>

                {/* Putts per hole trend */}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-semibold">Putts per Hole Trend</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart data={handicapData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                        <YAxis domain={[1, 2.5]} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                        <Tooltip
                          contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                          formatter={(v: number) => [v, "putts/hole"]}
                        />
                        <ReferenceLine y={2} stroke="hsl(var(--chart-2))" strokeDasharray="4 2" label={{ value: "2.0", position: "right", fontSize: 9, fill: "hsl(var(--chart-2))" }} />
                        <Line
                          type="monotone"
                          dataKey="puttsPerHole"
                          stroke="hsl(var(--chart-1))"
                          strokeWidth={2.5}
                          dot={{ r: 4, fill: "hsl(var(--chart-1))" }}
                          activeDot={{ r: 6 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                {/* Score vs Par per Round */}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-semibold">Score vs Par per Round</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={handicapData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                        <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                        <Tooltip
                          contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                          formatter={(v: number) => [v > 0 ? `+${v}` : v, "vs Par"]}
                          labelFormatter={(l) => `Round: ${l}`}
                        />
                        <ReferenceLine y={0} stroke="hsl(var(--primary))" strokeDasharray="4 2" />
                        <Bar dataKey="scoreDiff" radius={[3,3,0,0]}>
                          {handicapData.map((entry, i) => (
                            <Cell key={i} fill={entry.scoreDiff <= 0 ? "hsl(var(--chart-1))" : "hsl(var(--chart-4))"} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Round History */}
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Round History</h2>
              {isLoading ? (
                <div className="space-y-2">
                  {[1,2,3].map(i => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
                </div>
              ) : allRounds.length === 0 ? (
                <div className="text-center py-16 space-y-3">
                  <div className="w-14 h-14 mx-auto rounded-full bg-muted flex items-center justify-center">
                    <Trophy size={24} className="text-muted-foreground" />
                  </div>
                  <h3 className="font-semibold">No rounds yet</h3>
                  <p className="text-sm text-muted-foreground max-w-xs mx-auto">Start your first round and track your scores, game results, and handicap progression.</p>
                  <Button onClick={() => navigate("/new-round")} className="gap-1.5 mt-2">
                    <Plus size={15} /> Start First Round
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground/60 text-right pr-1">← Swipe left to edit or delete</p>
                  {allRounds.map(r => {
                    const detail = details.find(d => d.round.id === r.id);
                    const summary = detail ? getRoundScoreSummary(detail) : null;
                    return (
                      <SwipeableRoundCard
                        key={r.id}
                        round={r}
                        summary={summary}
                        onDelete={(id) => setDeleteConfirmId(id)}
                        navigate={navigate}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </TabsContent>

          {/* ── MY STATS TAB ── */}
          <TabsContent value="my-stats" className="space-y-6">
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Justin's Round Log</h2>
              <p className="text-xs text-muted-foreground mb-4">Personal scoring history across all rounds.</p>

              {allRoundDetails.isLoading ? (
                <div className="space-y-2">
                  {[1,2,3,4].map(i => <Skeleton key={i} className="h-10 w-full" />)}
                </div>
              ) : myStatsRows.length === 0 ? (
                <div className="text-center py-16 space-y-3">
                  <div className="w-14 h-14 mx-auto rounded-full bg-muted flex items-center justify-center">
                    <User size={24} className="text-muted-foreground" />
                  </div>
                  <h3 className="font-semibold">No rounds recorded yet</h3>
                  <p className="text-sm text-muted-foreground max-w-xs mx-auto">Complete a round to start tracking your personal stats.</p>
                  <Button onClick={() => navigate("/new-round")} className="gap-1.5 mt-2">
                    <Plus size={15} /> Start First Round
                  </Button>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="w-full text-xs border-collapse min-w-[480px]" data-testid="table-my-stats">
                    <thead>
                      <tr className="bg-primary/8 border-b border-border">
                        <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground">Date</th>
                        <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground">Location</th>
                        <th className="text-center px-3 py-2.5 font-semibold text-muted-foreground">Score</th>
                        <th className="text-center px-3 py-2.5 font-semibold text-muted-foreground">Course HCP</th>
                        <th className="text-center px-3 py-2.5 font-semibold text-muted-foreground">Net vs Par</th>
                        <th className="text-center px-3 py-2.5 font-semibold text-muted-foreground">Total Putts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {myStatsRows.map((row, i) => (
                        <tr
                          key={row.id}
                          className={`border-b border-border/50 hover:bg-muted/20 transition-colors cursor-pointer ${i % 2 === 0 ? "" : "bg-muted/10"}`}
                          onClick={() => navigate(`/round/${row.id}`)}
                          data-testid={`row-my-stats-${row.id}`}
                        >
                          <td className="px-3 py-2.5 font-medium tabular text-muted-foreground">{row.date}</td>
                          <td className="px-3 py-2.5 font-semibold truncate max-w-[160px]">{row.location}</td>
                          <td className="px-3 py-2.5 text-center font-bold tabular">
                            <span className="text-emerald-600 dark:text-emerald-400">{row.gross || "—"}</span>
                          </td>
                          <td className="px-3 py-2.5 text-center tabular text-muted-foreground">
                            {row.courseHcp != null ? row.courseHcp : "—"}
                          </td>
                          <td className="px-3 py-2.5 text-center font-semibold tabular">
                            {row.netVsPar != null
                              ? <span className={row.netVsPar <= 0 ? "text-emerald-600 dark:text-emerald-400" : ""}>
                                  {row.netVsPar > 0 ? `+${row.netVsPar}` : row.netVsPar === 0 ? "E" : row.netVsPar}
                                </span>
                              : "—"}
                          </td>
                          <td className="px-3 py-2.5 text-center tabular text-muted-foreground">
                            {row.totalPutts > 0 ? row.totalPutts : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {/* Summary row */}
                    {myStatsRows.length > 1 && (
                      <tfoot>
                        <tr className="bg-primary/8 border-t-2 border-primary/20">
                          <td colSpan={2} className="px-3 py-2 font-semibold text-muted-foreground">
                            Averages ({myStatsRows.length} rounds)
                          </td>
                          <td className="px-3 py-2 text-center font-bold tabular text-emerald-600 dark:text-emerald-400">
                            {Math.round(myStatsRows.reduce((s, r) => s + (r.gross || 0), 0) / myStatsRows.length)}
                          </td>
                          <td className="px-3 py-2 text-center tabular text-muted-foreground">
                            {myStatsRows.some(r => r.courseHcp != null)
                              ? Math.round(myStatsRows.filter(r => r.courseHcp != null).reduce((s, r) => s + r.courseHcp!, 0) / myStatsRows.filter(r => r.courseHcp != null).length)
                              : "—"}
                          </td>
                          <td className="px-3 py-2 text-center font-semibold tabular">
                            {(() => {
                              const rows = myStatsRows.filter(r => r.netVsPar != null);
                              if (!rows.length) return "—";
                              const avg = Math.round(rows.reduce((s, r) => s + r.netVsPar!, 0) / rows.length);
                              return <span className={avg <= 0 ? "text-emerald-600 dark:text-emerald-400" : ""}>
                                {avg > 0 ? `+${avg}` : avg === 0 ? "E" : avg}
                              </span>;
                            })()}
                          </td>
                          <td className="px-3 py-2 text-center tabular text-muted-foreground">
                            {myStatsRows.some(r => r.totalPutts > 0)
                              ? Math.round(myStatsRows.filter(r => r.totalPutts > 0).reduce((s, r) => s + r.totalPutts, 0) / myStatsRows.filter(r => r.totalPutts > 0).length)
                              : "—"}
                          </td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </main>

      {/* NGAP WHS Sync confirmation dialog */}
      <AlertDialog open={ngapSyncConfirm} onOpenChange={setNgapSyncConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sync from NGAP WHS?</AlertDialogTitle>
            <AlertDialogDescription>
              This will fetch your latest Handicap Index from the NGAP WHS portal (Member #index) and update the value here. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setNgapSyncConfirm(false);
                ngapSyncMutation.mutate();
              }}
            >
              Sync Now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteConfirmId !== null} onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this round?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the round and all scores. This cannot be undone.
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
