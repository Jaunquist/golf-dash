import { useState, useCallback, useRef, useEffect } from "react";
import HoleInputSheet from "@/components/HoleInputSheet";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, CheckCircle2, Users, Trash2, UserPlus, Download, Ghost, Pencil, Link2, Share2, StickyNote } from "lucide-react";
import {
  computeGameResults, cumulativeTotals, scoreCssClass, handicapStrokesOnHole,
  type Player as GPlayer
} from "@/lib/gameEngine";
import type { Round, RoundPlayer, HoleScore } from "@shared/schema";

const GAME_LABELS: Record<string, string> = {
  best_ball: "Best Ball",
  best_ball_pairs: "Best Ball Pairs",
  high_low: "High Low",
  high_low_pairs: "High Low Pairs",
  niners: "Niners",
  twelves: "Twelves",
  match_play: "Match Play",
  match_play_indiv: "Match Play",
};

const PLAYER_COLORS = [
  "text-emerald-600 dark:text-emerald-400",
  "text-blue-600 dark:text-blue-400",
  "text-orange-500 dark:text-orange-400",
  "text-purple-500 dark:text-purple-400",
];

const TEAM_GAME_TYPES = ["best_ball_pairs", "high_low_pairs", "match_play"];
// For edit game mode: match_play is the team variant of match_play_indiv
const GAME_TYPE_TO_BASE: Record<string, string> = {
  best_ball: "best_ball", best_ball_pairs: "best_ball",
  high_low: "high_low", high_low_pairs: "high_low",
  match_play: "match_play_indiv", match_play_indiv: "match_play_indiv",
};

interface GameDef {
  value: string;
  label: string;
  desc: string;
  minPlayers: number;
  maxPlayers: number;
  isTeam: boolean;
  canToggleTeam: boolean;
  teamVariant?: string;
  indivVariant?: string;
}

const GAME_DEFS: GameDef[] = [
  { value: "best_ball", label: "Best Ball", desc: "Best score per team wins each hole.", minPlayers: 2, maxPlayers: 4, isTeam: false, canToggleTeam: true, teamVariant: "best_ball_pairs", indivVariant: "best_ball" },
  { value: "high_low", label: "High Low", desc: "Low score wins the hole.", minPlayers: 2, maxPlayers: 4, isTeam: false, canToggleTeam: true, teamVariant: "high_low_pairs", indivVariant: "high_low" },
  { value: "match_play_indiv", label: "Match Play", desc: "Hole-by-hole: lowest score wins. Teams supported.", minPlayers: 2, maxPlayers: 4, isTeam: false, canToggleTeam: true, teamVariant: "match_play", indivVariant: "match_play_indiv" },
  { value: "niners", label: "Niners", desc: "3 players, 9 pts/hole: 5-3-1.", minPlayers: 3, maxPlayers: 3, isTeam: false, canToggleTeam: false },
  { value: "twelves", label: "Twelves", desc: "4 players, 12 pts/hole: 5-3-2-1.", minPlayers: 4, maxPlayers: 4, isTeam: false, canToggleTeam: false },
];

const SCORING_MODE_LABELS: Record<string, string> = {
  net_auto:   "Net — by hole HCP",
  net_manual: "Net — manual HCP",
  gross:      "Gross (no handicap)",
};

// Returns color class based on team membership in team games, or per-player color otherwise
function getPlayerColor(playerIndex: number, player: RoundPlayer, isTeamGame: boolean): string {
  if (!isTeamGame) return PLAYER_COLORS[playerIndex];
  // position 1 & 2 = Team 1 (emerald), position 3 & 4 = Team 2 (blue)
  return player.position <= 2
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-blue-600 dark:text-blue-400";
}

export default function Scorecard() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  // Round IDs are client-generated UUIDs, not numbers — parseInt would give NaN
  const roundId = id!;

  // Bottom sheet stepper state
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetPlayerId, setSheetPlayerId] = useState<number | null>(null);
  const [sheetHole, setSheetHole] = useState<number>(1);

  // Manage Players sheet state
  const [managePanelOpen, setManagePanelOpen] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState("");
  const [newPlayerHcp, setNewPlayerHcp] = useState("");

  // Edit Game sheet state
  const [editGameOpen, setEditGameOpen] = useState(false);
  const [editGameType, setEditGameType] = useState<string>("high_low");
  const [editTeamMode, setEditTeamMode] = useState<"individual" | "team">("individual");
  const [editScoringMode, setEditScoringMode] = useState<string>("net_auto");
  const [editPtsPerHole, setEditPtsPerHole] = useState(1);
  const [editPairsTiebreaker, setEditPairsTiebreaker] = useState(false);
  const [editSecondScoreTiebreaker, setEditSecondScoreTiebreaker] = useState(false);
  // Hole HCP inline edits (in Edit Game Mode)
  const [editHoleHcps, setEditHoleHcps] = useState<number[]>([]);
  const [saveHcpToCourse, setSaveHcpToCourse] = useState(false);

  // Round notes live in gameOptions so they need no schema change and travel
  // with the round through the existing sync path.
  const [notes, setNotes] = useState("");
  const [notesSaved, setNotesSaved] = useState(true);
  const [notesLoaded, setNotesLoaded] = useState(false);
  // Player HCP inline edits (in Players panel)
  const [editingPlayerHcp, setEditingPlayerHcp] = useState<number | null>(null); // playerId
  const [editPlayerHcpVal, setEditPlayerHcpVal] = useState("");
  const [editingDate, setEditingDate] = useState(false);
  const [localDate, setLocalDate] = useState("");
  const [editTeam1Indices, setEditTeam1Indices] = useState<number[]>([0, 1]);
  // teamAssignment[i] = team number (1, 2, 3) for player at sorted index i; null = use position-based
  const [editTeamAssignment, setEditTeamAssignment] = useState<number[]>([]);

  // Ref wrapping the entire scorecard content (for screenshot)
  const scorecardRef = useRef<HTMLDivElement>(null);
  const [isSharing, setIsSharing] = useState(false);

  const { data, isLoading, error } = useQuery<{ round: Round; players: RoundPlayer[]; scores: HoleScore[] }>({
    queryKey: ["/api/rounds", roundId],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/rounds/${roundId}`);
      const body = await r.json();
      // A 404 body is still valid JSON, so without this check the component
      // renders with round === undefined and crashes on round.pars.
      if (!r.ok || !body?.round) {
        throw new Error(body?.error || `Round not found (${r.status})`);
      }
      return body;
    },
    retry: 1,
  });

  // Ghost data — fetched when round has ghost mode enabled
  const gameOptsRaw = data?.round ? JSON.parse(data.round.gameOptions) : {};

  // Hydrate notes once the round arrives, without clobbering local edits
  useEffect(() => {
    if (!data?.round || notesLoaded) return;
    setNotes(gameOptsRaw.notes ?? "");
    setNotesLoaded(true);
  }, [data?.round, notesLoaded, gameOptsRaw.notes]);

  const saveNotes = useCallback(() => {
    if (!data?.round) return;
    const current = JSON.parse(data.round.gameOptions || "{}");
    if ((current.notes ?? "") === notes) { setNotesSaved(true); return; }
    apiRequest("PATCH", `/api/rounds/${roundId}/game`, {
      gameType: data.round.gameType,
      gameOptions: JSON.stringify({ ...current, notes }),
    })
      .then(() => {
        setNotesSaved(true);
        qc.invalidateQueries({ queryKey: [`/api/rounds/${roundId}`] });
      })
      .catch(() => toast({ title: "Couldn't save notes", variant: "destructive" }));
  }, [data?.round, notes, roundId]);
  const isSoloGhost = gameOptsRaw?.solo === true && gameOptsRaw?.ghost === true;
  const { data: ghostData } = useQuery<{ scores: Record<number, { strokes: number; roundDate: string }>; roundCount: number }>({
    queryKey: ["/api/courses", data?.round?.courseId, "ghost"],
    enabled: isSoloGhost && !!data?.round?.courseId,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/courses/${data!.round.courseId}/ghost`);
      return r.json();
    },
  });

  const saveMutation = useMutation({
    mutationFn: async ({ playerId, hole, strokes, putts }: { playerId: string; hole: number; strokes: number | null; putts: number | null }) => {
      const r = await apiRequest("PUT", `/api/rounds/${roundId}/scores`, { playerId, hole, strokes, putts });
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/rounds", roundId] });
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  const completeMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("PATCH", `/api/rounds/${roundId}/status`, { status: "complete" });
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/rounds"] });
      qc.invalidateQueries({ queryKey: ["/api/rounds", roundId] });
      toast({ title: "Round completed!" });
    },
  });

  // Update game type/options mutation
  const updateGameMutation = useMutation({
    mutationFn: async ({ gameType, gameOptions }: { gameType: string; gameOptions: string }) => {
      const r = await apiRequest("PATCH", `/api/rounds/${roundId}/game`, { gameType, gameOptions });
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/rounds", roundId] });
      setEditGameOpen(false);
      toast({ title: "Game mode updated" });
    },
    onError: () => toast({ title: "Failed to update game mode", variant: "destructive" }),
  });

  // Add player mutation
  const addPlayerMutation = useMutation({
    mutationFn: async ({ name, courseHandicap, position }: { name: string; courseHandicap: number; position: number }) => {
      const r = await apiRequest("POST", `/api/rounds/${roundId}/players`, { name, courseHandicap, position });
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/rounds", roundId] });
      setNewPlayerName("");
      setNewPlayerHcp("");
      toast({ title: "Player added" });
    },
    onError: () => toast({ title: "Failed to add player", variant: "destructive" }),
  });

  // Remove player mutation
  const removePlayerMutation = useMutation({
    mutationFn: async (playerId: string) => {
      const r = await apiRequest("DELETE", `/api/rounds/${roundId}/players/${playerId}`);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/rounds", roundId] });
      toast({ title: "Player removed" });
    },
    onError: () => toast({ title: "Failed to remove player", variant: "destructive" }),
  });

  // Update player HCP mutation
  const updatePlayerHcpMutation = useMutation({
    mutationFn: async ({ playerId, courseHandicap }: { playerId: string; courseHandicap: number }) => {
      const r = await apiRequest("PATCH", `/api/rounds/${roundId}/players/${playerId}`, { courseHandicap });
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/rounds", roundId] });
      setEditingPlayerHcp(null);
      setEditPlayerHcpVal("");
      toast({ title: "Handicap updated" });
    },
    onError: () => toast({ title: "Failed to update handicap", variant: "destructive" }),
  });

  // Update round date mutation
  const updateDateMutation = useMutation({
    mutationFn: async (date: string) => {
      const r = await apiRequest("PATCH", `/api/rounds/${roundId}/date`, { date });
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/rounds", roundId] });
      qc.invalidateQueries({ queryKey: ["/api/rounds"] });
      setEditingDate(false);
      toast({ title: "Date updated" });
    },
    onError: () => toast({ title: "Failed to update date", variant: "destructive" }),
  });

  // Update hole handicap ranks mutation
  const updateHoleHcpsMutation = useMutation({
    mutationFn: async (holeHandicaps: number[]) => {
      const r = await apiRequest("PATCH", `/api/rounds/${roundId}/holeHandicaps`, { holeHandicaps });
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/rounds", roundId] });
      toast({ title: "Hole handicaps updated" });
    },
    onError: () => toast({ title: "Failed to update hole handicaps", variant: "destructive" }),
  });

  const updateCourseHcpsMutation = useMutation({
    mutationFn: async ({ courseId, holeHandicaps }: { courseId: number; holeHandicaps: number[] }) => {
      const r = await apiRequest("PATCH", `/api/courses/${courseId}`, { holeHandicaps: JSON.stringify(holeHandicaps) });
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/courses"] });
      toast({ title: "Course hole handicaps saved" });
    },
    onError: () => toast({ title: "Failed to save to course", variant: "destructive" }),
  });

  // Open sheet for a specific player + hole
  const openSheet = useCallback((playerId: string, hole: number) => {
    setSheetPlayerId(playerId);
    setSheetHole(hole);
    setSheetOpen(true);
  }, []);

  // Save handler called by sheet on save/next/close
  const handleSheetSave = useCallback((hole: number, strokes: number, putts: number) => {
    if (sheetPlayerId === null) return;
    saveMutation.mutate({ playerId: sheetPlayerId, hole, strokes, putts });
  }, [sheetPlayerId, saveMutation]);

  const handleSheetDelete = useCallback((hole: number) => {
    if (sheetPlayerId === null) return;
    // Save null strokes/putts to clear the score
    saveMutation.mutate({ playerId: sheetPlayerId, hole, strokes: null, putts: null });
  }, [sheetPlayerId, saveMutation]);

  const handleAddPlayer = () => {
    const name = newPlayerName.trim();
    if (!name) return;
    const hcp = newPlayerHcp !== "" ? parseInt(newPlayerHcp) : 0;
    const nextPosition = (data?.players.length ?? 0) + 1;
    addPlayerMutation.mutate({ name, courseHandicap: isNaN(hcp) ? 0 : hcp, position: nextPosition });
  };

  if (isLoading) return (
    <div className="min-h-screen bg-background p-4 space-y-4">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
  if (error || !data?.round) return (
    <div className="p-8 text-center space-y-3">
      <p className="text-muted-foreground">
        {error instanceof Error ? error.message : "Round not found."}
      </p>
      <Button variant="outline" size="sm" onClick={() => navigate("/")}>
        Back to dashboard
      </Button>
    </div>
  );

  const { round, players, scores } = data;
  const pars: number[] = JSON.parse(round.pars);
  const holeHcps: number[] = JSON.parse(round.holeHandicaps);
  const gameOpts = JSON.parse(round.gameOptions);
  const holes = round.holes;
  const isSoloRound = gameOpts?.solo === true;
  // nineType: "front" (default) or "back" — only meaningful for 9-hole rounds on 18-hole courses
  const nineType: "front" | "back" = (holes === 9 && gameOpts?.nineType === "back") ? "back" : "front";
  // holeOffset shifts display labels: back 9 shows holes 10–18 even though data is stored as 1–9
  const holeOffset = nineType === "back" ? 9 : 0;
  // holeLabel(h) returns display hole number (1-indexed internal → display)
  const holeLabel = (h: number) => h + holeOffset;

  // Team game detection — drives color coding and totals grouping
  const isTeamGame = TEAM_GAME_TYPES.includes(round.gameType);

  // Build score lookup
  const scoreLookup: Record<string, HoleScore> = {};
  scores.forEach(s => { scoreLookup[`${s.playerId}_${s.hole}`] = s; });

  // Build game engine format
  const gPlayers: GPlayer[] = players.map(p => ({
    id: p.id, name: p.name, courseHandicap: p.courseHandicap, position: p.position
  }));

  const grossScores: Record<number, Record<number, number | null>> = {};
  players.forEach(p => {
    grossScores[p.id] = {};
    for (let h = 1; h <= holes; h++) {
      const s = scoreLookup[`${p.id}_${h}`];
      grossScores[p.id][h] = s?.strokes ?? null;
    }
  });

  const holeResults = computeGameResults(gPlayers, grossScores, pars, holeHcps, holes, round.gameType as any, { ...gameOpts, teamAssignment: gameOpts?.teamAssignment });
  const totals = cumulativeTotals(holeResults, gPlayers);

  // Section helpers for front/back/total
  const front = Array.from({ length: Math.min(9, holes) }, (_, i) => i + 1);
  const back = holes === 18 ? Array.from({ length: 9 }, (_, i) => i + 10) : [];

  function getCellValue(playerId: string, hole: number, field: "strokes" | "putts"): string {
    const s = scoreLookup[`${playerId}_${hole}`];
    if (!s) return "";
    const v = field === "strokes" ? s.strokes : s.putts;
    return v == null ? "" : String(v);
  }

  function getSectionTotal(playerId: string, holeList: number[], field: "strokes" | "putts"): number | null {
    let total = 0;
    let hasAny = false;
    for (const h of holeList) {
      const v = getCellValue(playerId, h, field);
      if (v !== "") { total += parseInt(v) || 0; hasAny = true; }
    }
    return hasAny ? total : null;
  }

  function getSectionPar(holeList: number[]): number {
    return holeList.reduce((s, h) => s + (pars[h-1] ?? 4), 0);
  }

  function getNetTotal(playerId: string, holeList: number[]): { net: number; playedPar: number } | null {
    const player = players.find(p => p.id === playerId);
    if (!player) return null;
    let total = 0, hasAny = false, playedPar = 0;
    for (const h of holeList) {
      const strVal = getCellValue(playerId, h, "strokes");
      if (strVal === "") continue;
      const gross = parseInt(strVal);
      const net = gross - handicapStrokesOnHole(player.courseHandicap, holeHcps[h-1] ?? h, holes);
      total += net;
      playedPar += pars[h-1] ?? 4;
      hasAny = true;
    }
    return hasAny ? { net: total, playedPar } : null;
  }

  function renderSection(holeList: number[]) {
    const sectionPar = getSectionPar(holeList);
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse min-w-[600px]">
          <thead>
            <tr className="bg-primary/8 border-b border-border">
              <th className="text-left px-2 py-2 font-semibold text-muted-foreground w-20 sticky left-0 bg-primary/8 z-10">Player</th>
              {holeList.map((h, hi) => (
                <th key={h}
                    className={`text-center px-1 py-2 font-semibold w-10 ${
                      hi % 2 === 1 ? "bg-primary/[0.06]" : ""}`}>
                  <div>{holeLabel(h)}</div>
                  <div className="text-muted-foreground font-normal">{pars[h-1]}</div>
                  <div className="text-[9px] text-muted-foreground/60 font-normal">H{holeHcps[h-1]}</div>
                </th>
              ))}
              <th className="text-center px-2 py-2 font-semibold w-14">OUT/IN</th>
            </tr>
          </thead>
          <tbody>
            {players.map((player, pi) => {
              const grossTotal = getSectionTotal(player.id, holeList, "strokes");
              const netResult = getNetTotal(player.id, holeList);
              const grossDiff = grossTotal != null ? grossTotal - getSectionPar(holeList.filter(h => getCellValue(player.id, h, "strokes") !== "")) : null;
              const holeResultForSection = holeResults.filter(hr => holeList.includes(hr.hole));
              const sectionPts = holeResultForSection.reduce((s, hr) => s + (hr.points[player.id] || 0), 0);
              const playerColor = getPlayerColor(pi, player, isTeamGame);
              return (
                <tr key={player.id} className={`border-b border-border/50 ${pi % 2 === 0 ? "" : "bg-muted/20"}`}>
                  <td className="px-2 py-1.5 sticky left-0 bg-card z-10">
                    <div className={`font-semibold truncate max-w-[70px] ${playerColor}`}>{player.name}</div>
                    <div className="text-[9px] text-muted-foreground">HCP {player.courseHandicap ?? "—"}</div>
                  </td>
                  {holeList.map((h, hi) => {
                    const holeHcpRank = holeHcps[h-1] ?? h;
                    const colTint = hi % 2 === 1 ? "bg-primary/[0.04]" : "";
                    const strVal = getCellValue(player.id, h, "strokes");
                    const puttsVal = getCellValue(player.id, h, "putts");
                    const strInt = strVal !== "" ? parseInt(strVal) : null;
                    const strokesOnHole = handicapStrokesOnHole(player.courseHandicap, holeHcpRank, holes);
                    const hr = holeResults.find(r => r.hole === h);
                    const isWinner = hr?.winners.includes(player.id);
                    const cssClass = scoreCssClass(strInt, pars[h-1] ?? 4);
                    const isSheetActive = sheetOpen && sheetPlayerId === player.id && sheetHole === h;

                    return (
                      <td key={h} className={`text-center p-0.5 ${colTint}`}>
                        <div
                          className={`relative rounded w-9 h-10 mx-auto flex flex-col items-center justify-center cursor-pointer border
                            ${isWinner ? "border-accent bg-accent/10" : "border-transparent"}
                            ${isSheetActive ? "ring-2 ring-primary" : "hover:border-border"}`}
                          data-testid={`score-cell-${player.id}-${h}`}
                          onClick={() => openSheet(player.id, h)}
                        >
                          {strokesOnHole > 0 && (
                            <div className="absolute top-0.5 left-0.5 flex gap-0.5">
                              {Array.from({length: strokesOnHole}).map((_, i) => (
                                <div key={i} className="w-1 h-1 bg-primary/40 rounded-full" />
                              ))}
                            </div>
                          )}
                          <div className="flex items-baseline justify-center gap-0.5">
                            <span className={`font-bold text-sm tabular leading-none ${cssClass}`}>
                              {strVal !== "" ? strVal : <span className="text-muted-foreground/40">—</span>}
                            </span>
                            {puttsVal !== "" && strVal !== "" && (
                              <sup className="text-[8px] text-muted-foreground leading-none">{puttsVal}</sup>
                            )}
                          </div>
                        </div>
                      </td>
                    );
                  })}
                  <td className="text-center px-1">
                    <div className="font-bold tabular text-sm">{grossTotal ?? "—"}</div>
                    {netResult != null && (
                      <div className="text-[10px] tabular text-muted-foreground">net {netResult.net}</div>
                    )}
                    <div className="text-[9px] text-accent font-semibold">{sectionPts}pts</div>
                  </td>
                </tr>
              );
            })}
            {/* Ghost row — shown when solo ghost mode enabled */}
            {isSoloGhost && ghostData && (
              <tr className="border-b border-border/30 opacity-50">
                <td className="px-2 py-1.5 sticky left-0 bg-card z-10">
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <Ghost size={11} />
                    <span className="text-[10px] font-semibold">Best</span>
                  </div>
                  <div className="text-[9px] text-muted-foreground/60">prev.</div>
                </td>
                {holeList.map(h => {
                  const raw = ghostData.scores[h] as any;
                  // Tolerate a bare number as well as {strokes, roundDate}
                  const strokes = typeof raw === "number" ? raw : raw?.strokes;
                  if (strokes == null) return <td key={h} className="text-center p-0.5"><span className="text-[10px] text-muted-foreground/40">—</span></td>;
                  const cssClass = scoreCssClass(strokes, pars[h-1] ?? 4);
                  return (
                    <td key={h} className="text-center p-0.5">
                      <div className="w-9 h-10 mx-auto flex items-center justify-center">
                        <span className={`font-bold text-sm tabular leading-none ${cssClass}`}>{strokes}</span>
                      </div>
                    </td>
                  );
                })}
                <td className="text-center px-1">
                  <div className="font-bold tabular text-sm text-muted-foreground">
                    {holeList.reduce((sum, h) => sum + (ghostData.scores[h]?.strokes ?? 0), 0) || "—"}
                  </div>
                </td>
              </tr>
            )}
            {/* Game points row — hidden for solo rounds */}
            {!isSoloRound && (
            <tr className="bg-primary/5 border-t-2 border-primary/20">
              <td className="px-2 py-1.5 text-xs font-semibold text-primary sticky left-0 bg-primary/5 z-10">Points</td>
              {holeList.map(h => {
                const hr = holeResults.find(r => r.hole === h);
                return (
                  <td key={h} className="text-center py-1">
                    {hr && hr.winners.length > 0 ? (
                      <div className="flex flex-col items-center gap-0.5">
                        {players
                          .filter(p => hr.winners.includes(p.id))
                          .map((p, i) => (
                            <div key={i} className={`text-[9px] font-bold truncate ${getPlayerColor(players.indexOf(p), p, isTeamGame)}`}>
                              {hr.note ? hr.note : `${p.name.split(" ")[0]}`}
                            </div>
                          ))}
                      </div>
                    ) : (
                      <span className="text-[9px] text-muted-foreground/40">—</span>
                    )}
                  </td>
                );
              })}
              <td className="text-center px-1 text-xs text-primary font-semibold">{sectionPar}</td>
            </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  // Grand totals
  function renderTotals() {
    const allHoles = Array.from({ length: holes }, (_, i) => i + 1);
    const maxPts = Math.max(0, ...Object.values(totals));

    // Helper: individual player stat row
    function playerStatRow(
      player: (typeof players)[0],
      pi: number,
      showPts: boolean,
      bgClass = ""
    ) {
      const gross = getSectionTotal(player.id, allHoles, "strokes");
      const netResult2 = getNetTotal(player.id, allHoles);
      const net = netResult2?.net ?? null;
      const puttsAll = getSectionTotal(player.id, allHoles, "putts");
      const diff = gross != null && netResult2 != null ? gross - netResult2.playedPar : null;
      const pts = totals[player.id] ?? 0;
      const isLeading = pts === maxPts && pts > 0;
      const playerColor = getPlayerColor(pi, player, isTeamGame);
      return (
        <tr key={player.id} className={`border-b border-border/40 ${bgClass}`}>
          <td className="px-3 py-1.5">
            <div className={`font-semibold text-xs ${playerColor}`}>{player.name}</div>
            <div className="text-muted-foreground text-[9px]">HCP {player.courseHandicap ?? "—"}</div>
          </td>
          <td className="text-center font-bold tabular text-xs">{gross ?? "—"}</td>
          <td className="text-center font-semibold tabular text-xs text-muted-foreground">{net ?? "—"}</td>
          <td className="text-center tabular text-xs text-muted-foreground">{puttsAll ?? "—"}</td>
          <td className={`text-center font-semibold tabular text-xs ${diff == null ? "" : diff > 0 ? "text-red-500" : diff < 0 ? "text-green-600 dark:text-green-400" : ""}`}>
            {diff == null ? "—" : diff > 0 ? `+${diff}` : diff === 0 ? "E" : diff}
          </td>
          <td className="text-center">
            {showPts
              ? <span className={`font-bold text-xs tabular ${isLeading ? "text-accent" : ""}`}>{pts}</span>
              : <span className="text-muted-foreground/30 text-xs">—</span>
            }
          </td>
        </tr>
      );
    }

    if (isTeamGame) {
      // Resolve team groups from teamAssignment in gameOpts (fallback to position-based)
      const ta: number[] | undefined = gameOpts?.teamAssignment;
      const sortedP = [...players].sort((a, b) => a.position - b.position);
      const getTeam = (p: typeof players[0]) => {
        if (ta && ta.length > 0) {
          const idx = sortedP.findIndex(x => x.id === p.id);
          return idx >= 0 && idx < ta.length ? ta[idx] : (p.position <= 2 ? 1 : 2);
        }
        return p.position <= 2 ? 1 : 2;
      };

      const teamGroups: Record<number, typeof players> = {};
      players.forEach(p => {
        const t = getTeam(p);
        if (!teamGroups[t]) teamGroups[t] = [];
        teamGroups[t].push(p);
      });

      const teamMeta: Record<number, { label: string; bgClass: string; colorClass: string; isSolo: boolean }> = {
        1: { label: "Team 1", bgClass: "bg-emerald-50/40 dark:bg-emerald-950/20", colorClass: "text-emerald-600 dark:text-emerald-400", isSolo: false },
        2: { label: "Team 2", bgClass: "bg-blue-50/40 dark:bg-blue-950/20",       colorClass: "text-blue-600 dark:text-blue-400",       isSolo: false },
        3: { label: "Solo",   bgClass: "bg-orange-50/40 dark:bg-orange-950/20",   colorClass: "text-orange-500 dark:text-orange-400",   isSolo: true  },
      };

      // Team summary row — shows combined pts only (skip for solo players)
      function teamSummaryRow(teamPlayers: typeof players, meta: typeof teamMeta[number]) {
        if (meta.isSolo) return null; // solo players show pts in their individual row
        const teamPts = teamPlayers.reduce((s, p) => s + (totals[p.id] ?? 0), 0);
        const isLeading = teamPts === maxPts && teamPts > 0;
        return (
          <tr key={`${meta.label}-summary`} className={`border-b-2 border-primary/15 ${isLeading ? "bg-accent/8" : "bg-primary/4"}`}>
            <td className="px-3 py-1.5" colSpan={5}>
              <span className={`font-bold text-xs ${meta.colorClass}`}>{meta.label}</span>
              <span className="text-[9px] text-muted-foreground ml-1.5">{teamPlayers.map(p => p.name).join(" & ")}</span>
            </td>
            <td className="text-center py-1.5">
              <span className={`font-bold text-sm tabular ${isLeading ? "text-accent" : "text-foreground"}`}>{teamPts}</span>
              <div className="text-[9px] text-muted-foreground">pts</div>
            </td>
          </tr>
        );
      }

      const teamNums = Object.keys(teamGroups).map(Number).sort();

      return (
        <div className="overflow-x-auto mt-4">
          <table className="text-xs border-collapse w-full">
            <thead>
              <tr className="bg-primary/10 border-b border-primary/20">
                <th className="text-left px-3 py-2 font-semibold w-24">Player</th>
                <th className="text-center px-2 py-2 w-14">Gross</th>
                <th className="text-center px-2 py-2 w-14">Net</th>
                <th className="text-center px-2 py-2 w-14">Putts</th>
                <th className="text-center px-2 py-2 w-14">+/- Par</th>
                <th className="text-center px-2 py-2 w-14">Pts</th>
              </tr>
            </thead>
            <tbody>
              {teamNums.map(t => {
                const group = teamGroups[t];
                const meta = teamMeta[t] ?? teamMeta[2];
                const isSolo = meta.isSolo;
                return (
                  <>
                    {/* Individual stat rows (no pts for team players; pts shown for solo) */}
                    {group.map(p => playerStatRow(p, players.indexOf(p), isSolo, meta.bgClass))}
                    {/* Team summary row with combined pts (skipped for solo) */}
                    {!isSolo && teamSummaryRow(group, meta)}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      );
    }

    // Non-team game: individual rows with pts per player
    return (
      <div className="overflow-x-auto mt-4">
        <table className="text-xs border-collapse w-full">
          <thead>
            <tr className="bg-primary/10 border-b border-primary/20">
              <th className="text-left px-3 py-2 font-semibold w-24">Player</th>
              <th className="text-center px-2 py-2 w-14">Gross</th>
              <th className="text-center px-2 py-2 w-14">Net</th>
              <th className="text-center px-2 py-2 w-14">Putts</th>
              <th className="text-center px-2 py-2 w-14">+/- Par</th>
              <th className="text-center px-2 py-2 w-14">Pts</th>
            </tr>
          </thead>
          <tbody>
            {players.map((player, pi) => playerStatRow(player, pi, true))}
          </tbody>
        </table>
      </div>
    );
  }

  // ── Share — programmatic canvas draw ──────────────────────────────────────
  // Layout: single wide table: label | F9 holes | F9-sub | DIV | B9 holes | B9-sub | TOT
  /**
   * Render the scorecard to a PNG. `mode` decides what happens next:
   *   "save"  — always download the file
   *   "share" — open the OS share sheet, falling back to download
   *
   * These were previously one action, so on mobile (where navigator.share
   * exists) it was impossible to just save a copy.
   */
  const handleShare = async (mode: "save" | "share" = "share") => {
    if (isSharing) return;
    setIsSharing(true);
    try {
      const DPR      = 3;    // ← higher resolution for legibility when zooming
      const COL_W    = 34;   // hole column width
      const SUB_W    = 44;   // F9/B9 subtotal column width (distinct style)
      const ROW_H    = 48;   // player row height
      const LABEL_W  = 88;   // player label column
      const DIV_W    = 6;    // thin gap between F9 block and B9 block
      const TOT_W    = 64;   // total column (gross + net)
      const PAD      = 14;
      const HEADER_H = 58;
      const TH_H     = 36;
      const GHOST_ROW_H   = isSoloGhost ? ROW_H : 0;
      const POINTS_ROW_H  = isSoloRound ? 0 : 26;
      const SCORE_ROW_H   = (!isSoloRound && isTeamGame) ? 28 : 0; // game score summary row

      const front9 = Array.from({ length: Math.min(9, holes) }, (_, i) => i + 1);
      const back9  = holes === 18 ? Array.from({ length: 9 }, (_, i) => i + 10) : [];
      const allHoleList = [...front9, ...back9];
      const has18 = back9.length > 0;

      // Table width: label | front9 holes | F9sub | [divider | back9 holes | B9sub] | TOT
      const tableW = LABEL_W
        + front9.length * COL_W + SUB_W
        + (has18 ? DIV_W + back9.length * COL_W + SUB_W : 0)
        + TOT_W;
      const canvasW = tableW + PAD * 2;

      const tableH = TH_H + players.length * ROW_H + GHOST_ROW_H + POINTS_ROW_H + SCORE_ROW_H;
      const canvasH = HEADER_H + PAD + tableH + PAD + 18;

      const canvas = document.createElement("canvas");
      canvas.width  = canvasW * DPR;
      canvas.height = canvasH * DPR;
      const ctx = canvas.getContext("2d")!;
      ctx.scale(DPR, DPR);

      // ── Palette ──
      const BG       = "#f5f2ea";
      const GREEN    = "#1d5c3a";
      const MUTED    = "#8a8070";
      const BORDER   = "#e2ddd5";
      const WHITE    = "#ffffff";
      const ROW_ALT  = "#edeae2";
      const SUB_BG   = "#e8e4d8"; // subtotal column — slightly darker than BG
      const PLAYER_C = ["#1d5c3a", "#2563eb", "#ea580c", "#7c3aed"];
      const T1_C     = "#059669";
      const T2_C     = "#2563eb";

      // ── Score style ──
      function scoreStyle(s: number | null, par: number): { fill: string | null; stroke1: string | null; stroke2: boolean; fg: string } {
        if (s == null) return { fill: null, stroke1: null, stroke2: false, fg: MUTED };
        const d = s - par;
        if (d <= -2) return { fill: "#fef3c7", stroke1: null,       stroke2: false, fg: "#92400e" };
        if (d === -1) return { fill: "#dcfce7", stroke1: null,       stroke2: false, fg: "#166534" };
        if (d === 0)  return { fill: null,      stroke1: null,       stroke2: false, fg: GREEN };
        if (d === 1)  return { fill: null,      stroke1: "#b45309",  stroke2: false, fg: "#3a3530" };
        return              { fill: null,      stroke1: "#b45309",  stroke2: true,  fg: "#3a3530" };
      }

      function drawScoreCell(cx: number, cy: number, strokes: number | null, par: number, putts: number | null) {
        const { fill, stroke1, stroke2, fg } = scoreStyle(strokes, par);
        const R = 11;
        if (fill) {
          ctx.fillStyle = fill;
          ctx.beginPath();
          (ctx as any).roundRect?.(cx - R, cy - R, R * 2, R * 2, 3) || ctx.rect(cx - R, cy - R, R * 2, R * 2);
          ctx.fill();
        }
        if (stroke1) {
          ctx.strokeStyle = stroke1; ctx.lineWidth = 0.8;
          ctx.beginPath();
          (ctx as any).roundRect?.(cx - R, cy - R, R * 2, R * 2, 3) || ctx.rect(cx - R, cy - R, R * 2, R * 2);
          ctx.stroke();
        }
        if (stroke2) {
          ctx.strokeStyle = stroke1 ?? "#b45309"; ctx.lineWidth = 0.6;
          ctx.beginPath();
          (ctx as any).roundRect?.(cx - R - 3, cy - R - 3, (R + 3) * 2, (R + 3) * 2, 5) || ctx.rect(cx - R - 3, cy - R - 3, (R + 3) * 2, (R + 3) * 2);
          ctx.stroke();
        }
        ctx.textAlign = "center";
        if (strokes != null) {
          ctx.fillStyle = fg; ctx.font = `bold 11px system-ui, sans-serif`;
          ctx.fillText(String(strokes), cx, cy + 4);
          if (putts != null) {
            ctx.fillStyle = MUTED; ctx.font = `6.5px system-ui, sans-serif`;
            ctx.fillText(String(putts), cx + 9, cy - 4);
          }
        } else {
          ctx.fillStyle = "rgba(138,128,112,0.3)"; ctx.font = `10px system-ui, sans-serif`;
          ctx.fillText("—", cx, cy + 4);
        }
        ctx.textAlign = "left";
      }

      // x-center of a hole cell
      function holeX(holeNum: number): number {
        if (holeNum <= 9) {
          return PAD + LABEL_W + (holeNum - 1) * COL_W + COL_W / 2;
        } else {
          return PAD + LABEL_W + front9.length * COL_W + SUB_W + DIV_W + (holeNum - 10) * COL_W + COL_W / 2;
        }
      }
      // x-center of the F9 or B9 subtotal column
      const f9SubX = PAD + LABEL_W + front9.length * COL_W + SUB_W / 2;
      const b9SubX = has18 ? PAD + LABEL_W + front9.length * COL_W + SUB_W + DIV_W + back9.length * COL_W + SUB_W / 2 : 0;
      const totX   = PAD + LABEL_W + front9.length * COL_W + SUB_W + (has18 ? DIV_W + back9.length * COL_W + SUB_W : 0) + TOT_W / 2;

      // x-start of divider gap
      const divStartX = PAD + LABEL_W + front9.length * COL_W + SUB_W;

      // ── Background ──
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, canvasW, canvasH);

      // ── Header ──
      ctx.fillStyle = GREEN;
      ctx.fillRect(0, 0, canvasW, HEADER_H);
      ctx.fillStyle = WHITE; ctx.font = `bold 14px system-ui, sans-serif`;
      ctx.fillText(round.courseName, PAD, 23);
      ctx.font = `10px system-ui, sans-serif`; ctx.fillStyle = "rgba(255,255,255,0.65)";
      ctx.fillText(`${round.date}  ·  ${round.holes}H  ·  ${GAME_LABELS[round.gameType] || round.gameType}`, PAD, 39);
      ctx.textAlign = "right"; ctx.font = `9px system-ui, sans-serif`; ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fillText(players.map(p => p.name).join(" · "), canvasW - PAD, 31);
      ctx.textAlign = "left";

      let y = HEADER_H + PAD;

      // Helper: shade subtotal columns for entire table height first (so background shows under all rows)
      function shadeSubCols(startY: number, height: number) {
        ctx.fillStyle = SUB_BG;
        ctx.fillRect(PAD + LABEL_W + front9.length * COL_W, startY, SUB_W, height);
        if (has18) ctx.fillRect(PAD + LABEL_W + front9.length * COL_W + SUB_W + DIV_W + back9.length * COL_W, startY, SUB_W, height);
      }

      // ── Table header row ──
      ctx.fillStyle = "rgba(29,92,58,0.09)";
      ctx.fillRect(PAD, y, tableW, TH_H);
      shadeSubCols(y, TH_H);
      ctx.strokeStyle = BORDER; ctx.lineWidth = 0.5;
      ctx.strokeRect(PAD, y, tableW, TH_H);

      ctx.fillStyle = MUTED; ctx.font = `bold 8px system-ui, sans-serif`;
      ctx.fillText("Hole", PAD + 4, y + 14);
      ctx.font = `7.5px system-ui, sans-serif`;
      ctx.fillText("Par", PAD + 4, y + 26);

      // Hole numbers + par
      allHoleList.forEach(h => {
        const cx = holeX(h);
        ctx.textAlign = "center";
        ctx.fillStyle = "#3a3530"; ctx.font = `bold 8.5px system-ui, sans-serif`;
        ctx.fillText(String(h), cx, y + 19);
        ctx.fillStyle = MUTED; ctx.font = `7.5px system-ui, sans-serif`;
        ctx.fillText(String(pars[h - 1] ?? 4), cx, y + 30);
        ctx.textAlign = "left";
      });

      // F9 sub header
      ctx.textAlign = "center";
      ctx.fillStyle = GREEN; ctx.font = `bold 8px system-ui, sans-serif`;
      ctx.fillText("F9", f9SubX, y + 14);
      ctx.fillStyle = MUTED; ctx.font = `7px system-ui, sans-serif`;
      ctx.fillText(String(front9.reduce((s, h) => s + (pars[h - 1] ?? 4), 0)), f9SubX, y + 26);
      if (has18) {
        ctx.fillStyle = GREEN; ctx.font = `bold 8px system-ui, sans-serif`;
        ctx.fillText("B9", b9SubX, y + 14);
        ctx.fillStyle = MUTED; ctx.font = `7px system-ui, sans-serif`;
        ctx.fillText(String(back9.reduce((s, h) => s + (pars[h - 1] ?? 4), 0)), b9SubX, y + 26);
      }

      // TOT header
      ctx.fillStyle = MUTED; ctx.font = `bold 8px system-ui, sans-serif`;
      ctx.fillText("Gross", totX, y + 15);
      ctx.font = `7px system-ui, sans-serif`;
      ctx.fillText("Net", totX, y + 27);
      ctx.textAlign = "left";

      // Divider gap line
      if (has18) {
        ctx.fillStyle = BG;
        ctx.fillRect(divStartX, y, DIV_W, TH_H);
      }

      y += TH_H;

      // ── Player rows ──
      players.forEach((player, pi) => {
        const ta2: number[] | undefined = gameOpts?.teamAssignment;
        const sortedPlayers = [...players].sort((a, b) => a.position - b.position);
        const teamNum = ta2 && ta2.length > 0
          ? (ta2[sortedPlayers.findIndex(p => p.id === player.id)] ?? (player.position <= 2 ? 1 : 2))
          : (player.position <= 2 ? 1 : 2);
        const inTeam1 = teamNum === 1;
        const isSolo3 = teamNum === 3;
        const teamLabel = isTeamGame ? (isSolo3 ? "Solo" : inTeam1 ? "Team 1" : "Team 2") : null;
        const teamColor = isTeamGame ? (isSolo3 ? "#ea580c" : inTeam1 ? T1_C : T2_C) : null;

        if (isTeamGame) {
          ctx.fillStyle = isSolo3 ? "rgba(234,88,12,0.05)" : inTeam1 ? "rgba(5,150,105,0.06)" : "rgba(37,99,235,0.06)";
        } else {
          ctx.fillStyle = pi % 2 === 1 ? ROW_ALT : WHITE;
        }
        ctx.fillRect(PAD, y, tableW, ROW_H);
        shadeSubCols(y, ROW_H);
        ctx.strokeStyle = BORDER; ctx.lineWidth = 0.5;
        ctx.strokeRect(PAD, y, tableW, ROW_H);

        // Player name + HCP + team label
        ctx.fillStyle = PLAYER_C[pi] ?? GREEN;
        ctx.font = `bold 9px system-ui, sans-serif`;
        ctx.fillText(player.name, PAD + 4, y + 15);
        ctx.fillStyle = MUTED; ctx.font = `7px system-ui, sans-serif`;
        ctx.fillText(`HCP ${player.courseHandicap ?? "—"}`, PAD + 4, y + 25);
        if (teamLabel && teamColor) {
          ctx.fillStyle = teamColor; ctx.font = `bold 7px system-ui, sans-serif`;
          ctx.fillText(teamLabel, PAD + 4, y + 36);
        }

        // Score cells
        allHoleList.forEach(h => {
          const s = scoreLookup[`${player.id}_${h}`];
          drawScoreCell(holeX(h), y + ROW_H / 2, s?.strokes ?? null, pars[h - 1] ?? 4, s?.putts ?? null);
        });

        // F9 subtotal
        const f9Gross = getSectionTotal(player.id, front9, "strokes");
        const f9Net   = getNetTotal(player.id, front9);
        ctx.textAlign = "center";
        ctx.fillStyle = "#3a3530"; ctx.font = `bold 11px system-ui, sans-serif`;
        ctx.fillText(f9Gross != null ? String(f9Gross) : "—", f9SubX, y + 20);
        ctx.fillStyle = MUTED; ctx.font = `8px system-ui, sans-serif`;
        ctx.fillText(f9Net != null ? `net ${f9Net.net}` : "", f9SubX, y + 33);

        // B9 subtotal
        if (has18) {
          const b9Gross = getSectionTotal(player.id, back9, "strokes");
          const b9Net   = getNetTotal(player.id, back9);
          ctx.fillStyle = "#3a3530"; ctx.font = `bold 11px system-ui, sans-serif`;
          ctx.fillText(b9Gross != null ? String(b9Gross) : "—", b9SubX, y + 20);
          ctx.fillStyle = MUTED; ctx.font = `8px system-ui, sans-serif`;
          ctx.fillText(b9Net != null ? `net ${b9Net.net}` : "", b9SubX, y + 33);
        }

        // TOT column: gross + net
        const grossTotal = getSectionTotal(player.id, allHoleList, "strokes");
        const netResult  = getNetTotal(player.id, allHoleList);
        ctx.fillStyle = "#3a3530"; ctx.font = `bold 12px system-ui, sans-serif`;
        ctx.fillText(grossTotal != null ? String(grossTotal) : "—", totX, y + 19);
        ctx.fillStyle = MUTED; ctx.font = `9px system-ui, sans-serif`;
        ctx.fillText(netResult != null ? String(netResult.net) : "—", totX, y + 33);
        ctx.textAlign = "left";

        // Divider gap
        if (has18) {
          ctx.fillStyle = BG;
          ctx.fillRect(divStartX, y, DIV_W, ROW_H);
        }

        y += ROW_H;
      });

      // ── Ghost row ──
      if (isSoloGhost && ghostData) {
        ctx.fillStyle = "rgba(138,128,112,0.05)";
        ctx.fillRect(PAD, y, tableW, ROW_H);
        shadeSubCols(y, ROW_H);
        ctx.strokeStyle = BORDER; ctx.lineWidth = 0.5;
        ctx.strokeRect(PAD, y, tableW, ROW_H);
        ctx.fillStyle = MUTED; ctx.font = `bold 8px system-ui, sans-serif`;
        ctx.fillText("Best", PAD + 4, y + ROW_H / 2 + 4);
        allHoleList.forEach(h => {
          const gs = ghostData.scores[h];
          if (!gs) return;
          const { fg } = scoreStyle(gs.strokes, pars[h - 1] ?? 4);
          ctx.textAlign = "center"; ctx.globalAlpha = 0.5;
          ctx.fillStyle = fg; ctx.font = `bold 10px system-ui, sans-serif`;
          ctx.fillText(String(gs.strokes), holeX(h), y + ROW_H / 2 + 4);
          ctx.globalAlpha = 1; ctx.textAlign = "left";
        });
        if (has18) { ctx.fillStyle = BG; ctx.fillRect(divStartX, y, DIV_W, ROW_H); }
        y += ROW_H;
      }

      // ── Hole points row ──
      if (!isSoloRound) {
        ctx.fillStyle = "rgba(29,92,58,0.05)";
        ctx.fillRect(PAD, y, tableW, POINTS_ROW_H);
        shadeSubCols(y, POINTS_ROW_H);
        ctx.strokeStyle = "rgba(29,92,58,0.2)"; ctx.lineWidth = 1;
        ctx.strokeRect(PAD, y, tableW, POINTS_ROW_H);
        ctx.fillStyle = GREEN; ctx.font = `bold 8px system-ui, sans-serif`;
        ctx.fillText("Pts", PAD + 4, y + POINTS_ROW_H / 2 + 3);

        allHoleList.forEach(h => {
          const hr = holeResults.find(r => r.hole === h);
          if (!hr || hr.winners.length === 0) return;
          const winner = players.find(p => hr.winners.includes(p.id));
          if (!winner) return;
          const pi2 = players.indexOf(winner);
          ctx.textAlign = "center";
          if (isTeamGame) {
            const ta2: number[] | undefined = gameOpts?.teamAssignment;
            const sortedPlayers = [...players].sort((a, b) => a.position - b.position);
            const wTeam = ta2 && ta2.length > 0
              ? (ta2[sortedPlayers.findIndex(p => p.id === winner.id)] ?? (winner.position <= 2 ? 1 : 2))
              : (winner.position <= 2 ? 1 : 2);
            ctx.fillStyle = wTeam === 1 ? T1_C : wTeam === 3 ? "#ea580c" : T2_C;
            ctx.font = `bold 7.5px system-ui, sans-serif`;
            ctx.fillText(wTeam === 3 ? "Solo" : `T${wTeam}`, holeX(h), y + POINTS_ROW_H / 2 + 3);
          } else {
            ctx.fillStyle = PLAYER_C[pi2] ?? GREEN;
            ctx.font = `bold 8px system-ui, sans-serif`;
            ctx.fillText(winner.name.split(" ")[0], holeX(h), y + POINTS_ROW_H / 2 + 3);
          }
          ctx.textAlign = "left";
        });

        if (has18) { ctx.fillStyle = BG; ctx.fillRect(divStartX, y, DIV_W, POINTS_ROW_H); }

        // Total pts in TOT column
        const totalPts = Object.values(totals).reduce((s, v) => s + v, 0);
        ctx.textAlign = "center";
        ctx.fillStyle = GREEN; ctx.font = `bold 10px system-ui, sans-serif`;
        ctx.fillText(String(totalPts), totX, y + POINTS_ROW_H / 2 + 3);
        ctx.textAlign = "left";

        y += POINTS_ROW_H;
      }

      // ── Game score summary row ──
      if (!isSoloRound && isTeamGame) {
        ctx.fillStyle = "rgba(29,92,58,0.10)";
        ctx.fillRect(PAD, y, tableW, SCORE_ROW_H);
        ctx.strokeStyle = GREEN; ctx.lineWidth = 1;
        ctx.strokeRect(PAD, y, tableW, SCORE_ROW_H);

        ctx.fillStyle = GREEN; ctx.font = `bold 8px system-ui, sans-serif`;
        ctx.fillText("Score", PAD + 4, y + SCORE_ROW_H / 2 + 3);

        // Build team totals
        const ta2: number[] | undefined = gameOpts?.teamAssignment;
        const sortedPlayers = [...players].sort((a, b) => a.position - b.position);
        const teamPtsMap: Record<number, number> = {};
        const teamNamesMap: Record<number, string[]> = {};
        players.forEach(p => {
          const idx = sortedPlayers.findIndex(x => x.id === p.id);
          const tNum = ta2 && ta2.length > 0 ? (ta2[idx] ?? (p.position <= 2 ? 1 : 2)) : (p.position <= 2 ? 1 : 2);
          teamPtsMap[tNum] = (teamPtsMap[tNum] ?? 0) + (totals[p.id] ?? 0);
          if (!teamNamesMap[tNum]) teamNamesMap[tNum] = [];
          teamNamesMap[tNum].push(p.name.split(" ")[0]);
        });

        const teamNums = Object.keys(teamPtsMap).map(Number).sort();
        const maxTeamPts = Math.max(...Object.values(teamPtsMap));
        const scoreRowTextY = y + SCORE_ROW_H / 2 + 3;

        // Place team scores centered in respective half of the table body
        const bodyW = tableW - LABEL_W - TOT_W;
        teamNums.forEach((tNum, idx) => {
          const tPts = teamPtsMap[tNum];
          const tNames = teamNamesMap[tNum]?.join(" & ") ?? "";
          const tColor = tNum === 1 ? T1_C : tNum === 3 ? "#ea580c" : T2_C;
          const isLeading = tPts === maxTeamPts;

          // Spread teams across the scoreline body area
          const segW = bodyW / teamNums.length;
          const cx2 = PAD + LABEL_W + idx * segW + segW / 2;

          ctx.textAlign = "center";
          ctx.fillStyle = tColor;
          ctx.font = `bold ${isLeading ? 11 : 10}px system-ui, sans-serif`;
          ctx.fillText(`${tNum === 3 ? "Solo" : `T${tNum}`}: ${tPts}pts`, cx2, scoreRowTextY - 4);
          ctx.font = `7px system-ui, sans-serif`; ctx.fillStyle = MUTED;
          ctx.fillText(tNames, cx2, scoreRowTextY + 7);
          ctx.textAlign = "left";
        });

        y += SCORE_ROW_H;
      }

      // ── Footer ──
      ctx.fillStyle = MUTED; ctx.font = `8px system-ui, sans-serif`;
      ctx.textAlign = "right";
      ctx.fillText("Golf Dash", canvasW - PAD, canvasH - 4);
      ctx.textAlign = "left";

      canvas.toBlob(async (blob) => {
        if (!blob) { toast({ title: "Failed to create image", variant: "destructive" }); setIsSharing(false); return; }
        const filename = `fairway-${round.date}.png`;
        const file = new File([blob], filename, { type: "image/png" });
        const download = () => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = filename; a.click();
          URL.revokeObjectURL(url);
          toast({ title: "Scorecard saved", description: filename });
        };

        try {
          const canShare = navigator.share && navigator.canShare &&
                           navigator.canShare({ files: [file] });
          if (mode === "share" && canShare) {
            await navigator.share({ title: `${round.courseName} · ${round.date}`, files: [file] });
          } else {
            download();
          }
        } catch (e: any) {
          if (e?.name !== "AbortError") toast({ title: "Sharing cancelled" });
        }
        setIsSharing(false);
      }, "image/png");
    } catch (err) {
      console.error(err);
      toast({ title: "Screenshot failed", variant: "destructive" });
      setIsSharing(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b border-border">
        <div className="max-w-5xl mx-auto px-3">
          {/* Row 1: back + title + finish */}
          <div className="h-12 flex items-center gap-2">
            <button
              onClick={() => navigate("/")}
              className="text-muted-foreground hover:text-foreground transition-colors shrink-0 p-1 -ml-1"
            >
              <ArrowLeft size={20} />
            </button>
            <div className="flex-1 min-w-0">
              <h1 className="font-display font-bold text-sm leading-tight truncate">{round.courseName}</h1>
              <div className="text-[10px] text-muted-foreground leading-tight flex items-center gap-1">
                {editingDate ? (
                  <input
                    type="date"
                    autoFocus
                    value={localDate}
                    className="bg-background border border-input rounded px-1 py-0 text-[10px] h-5 focus:outline-none focus:ring-1 focus:ring-ring"
                    onChange={e => setLocalDate(e.target.value)}
                    onBlur={() => {
                      if (localDate && localDate !== round.date) updateDateMutation.mutate(localDate);
                      else setEditingDate(false);
                    }}
                    onKeyDown={e => {
                      if (e.key === "Enter" && localDate) updateDateMutation.mutate(localDate);
                      if (e.key === "Escape") setEditingDate(false);
                    }}
                  />
                ) : (
                  <button
                    onClick={() => { setLocalDate(round.date); setEditingDate(true); }}
                    className="hover:text-foreground transition-colors underline-offset-2 hover:underline cursor-pointer"
                    title="Edit date"
                  >
                    {round.date}
                  </button>
                )}
                <span>· {round.holes}H</span>
              </div>
            </div>
            {round.status === "active" && (
              <Button
                size="sm"
                data-testid="btn-complete-round"
                onClick={() => completeMutation.mutate()}
                className="gap-1.5 text-xs shrink-0 h-8 border-green-600 bg-transparent text-green-600 hover:bg-green-50 dark:hover:bg-green-950 border"
              >
                <CheckCircle2 size={13} /> Finish
              </Button>
            )}
            {round.status === "complete" && (
              <Badge className="text-[10px] py-0.5 px-2 bg-green-600 shrink-0">Complete</Badge>
            )}
          </div>
          {/* Row 2: game badge + action buttons */}
          <div className="h-9 flex items-center gap-1.5 pb-1">
            {/* Clickable game badge — opens edit sheet for active rounds */}
            {round.status === "active" && !isSoloRound ? (
              <button
                data-testid="btn-edit-game"
                onClick={() => {
                  // Seed edit state from current round values
                  const opts = JSON.parse(round.gameOptions);
                  const isTeamType = TEAM_GAME_TYPES.includes(round.gameType);
                  const baseKey = GAME_TYPE_TO_BASE[round.gameType] ?? round.gameType;
                  const baseDef = GAME_DEFS.find(d => d.value === baseKey) ?? GAME_DEFS[0];
                  setEditGameType(baseDef.value);
                  setEditTeamMode(isTeamType ? "team" : "individual");
                  setEditScoringMode(opts.scoringMode ?? "net_auto");
                  setEditPtsPerHole(opts.ptsPerHole ?? 1);
                  setEditPairsTiebreaker(opts.pairsTiebreaker ?? false);
                  setEditSecondScoreTiebreaker(opts.secondScoreTiebreaker ?? false);
                  setEditHoleHcps([...holeHcps]);
                  // Seed team assignment from gameOptions or current positions
                  const ta: number[] | undefined = opts.teamAssignment;
                  if (ta && ta.length > 0) {
                    setEditTeamAssignment(ta);
                    setEditTeam1Indices(ta.map((t, i) => t === 1 ? i : -1).filter(i => i >= 0));
                  } else {
                    // Derive from positions
                    const sorted = [...players].sort((a, b) => a.position - b.position);
                    const derived = sorted.map(p => p.position <= 2 ? 1 : 2);
                    setEditTeamAssignment(derived);
                    setEditTeam1Indices(derived.map((t, i) => t === 1 ? i : -1).filter(i => i >= 0));
                  }
                  setEditGameOpen(true);
                }}
                className="flex items-center gap-1 text-[10px] font-medium rounded-md border border-dashed border-primary/50 px-2 py-0.5 text-primary hover:bg-primary/6 transition-colors"
              >
                <Pencil size={10} />
                {GAME_LABELS[round.gameType] || round.gameType}
              </button>
            ) : (
              <Badge variant="outline" className="text-[10px] py-0 px-1.5">{GAME_LABELS[round.gameType] || round.gameType}</Badge>
            )}
            {/* Scoring mode badge */}
            {!isSoloRound && (() => {
              const sm = gameOpts?.scoringMode ?? "net_auto";
              const smShort: Record<string, string> = { net_auto: "Net/HCP", net_manual: "Net/Manual", gross: "Gross" };
              return (
                <Badge variant="outline" className="text-[10px] py-0 px-1.5 text-muted-foreground border-dashed">
                  {smShort[sm] ?? sm}
                </Badge>
              );
            })()}
            <div className="flex-1" />
            {round.status === "active" && (
              <Button
                size="sm"
                variant="outline"
                data-testid="btn-manage-players"
                onClick={() => setManagePanelOpen(true)}
                className="gap-1 text-[11px] h-7 px-2"
              >
                <Users size={12} /> Players
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              data-testid="btn-copy-share-link"
              onClick={() => {
                const url = window.location.href.replace(/\/round\//, "/shared/");
                // Try modern clipboard API first, fall back to execCommand for iframe/Android
                const doCopy = () => {
                  try {
                    const ta = document.createElement("textarea");
                    ta.value = url;
                    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
                    document.body.appendChild(ta);
                    ta.focus();
                    ta.select();
                    const ok = document.execCommand("copy");
                    document.body.removeChild(ta);
                    return ok;
                  } catch { return false; }
                };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                  navigator.clipboard.writeText(url)
                    .then(() => toast({ title: "Link copied!", description: "Share with fellow players to view & enter scores." }))
                    .catch(() => {
                      const ok = doCopy();
                      if (ok) toast({ title: "Link copied!", description: "Share with fellow players to view & enter scores." });
                      else toast({ title: "Share link", description: url });
                    });
                } else {
                  const ok = doCopy();
                  if (ok) toast({ title: "Link copied!", description: "Share with fellow players to view & enter scores." });
                  else toast({ title: "Share link", description: url });
                }
              }}
              className="gap-1 text-[11px] h-7 px-2"
            >
              <Link2 size={12} /> Share
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="btn-download-scorecard"
              onClick={() => handleShare("save")}
              disabled={isSharing}
              className="gap-1 text-[11px] h-7 px-2"
              title="Download the scorecard image"
            >
              <Download size={12} /> {isSharing ? "…" : "Save"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="btn-share-scorecard-image"
              onClick={() => handleShare("share")}
              disabled={isSharing}
              className="gap-1 text-[11px] h-7 px-2"
              title="Share the scorecard image to another app"
            >
              <Share2 size={12} /> {isSharing ? "…" : "Send"}
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-3 py-4 space-y-4" ref={scorecardRef}>
        {/* Tap instruction */}
        {round.status === "active" && (
          <p className="text-xs text-muted-foreground text-center">Tap a cell to enter strokes and putts. Putts appear as superscript. Dots = handicap strokes.</p>
        )}

        {/* Legend */}
        <div className="flex flex-wrap gap-3 text-xs items-center">
          <span className="text-muted-foreground">Score:</span>
          {[["Eagle","score-eagle"],["Birdie","score-birdie"],["Par","score-par"],["Bogey","score-bogey"],["Double","score-double"]].map(([l,c]) => (
            <span key={l} className={`font-semibold ${c}`}>{l}</span>
          ))}
          <span className="ml-2 text-muted-foreground">| Gold border = hole win</span>
        </div>

        {/* Front 9 / Back 9 / Scorecard header */}
        <div>
          <h2 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">
            {holes === 18 ? "Front 9" : nineType === "back" ? "Back 9 (Holes 10–18)" : "Front 9 (Holes 1–9)"} · Par {getSectionPar(front)}
          </h2>
          {renderSection(front)}
        </div>

        {/* Back 9 */}
        {holes === 18 && back.length > 0 && (
          <div>
            <h2 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">Back 9 · Par {getSectionPar(back)}</h2>
            {renderSection(back)}
          </div>
        )}

        {/* Totals */}
        <div>
          <h2 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">Round Totals</h2>
          {renderTotals()}
        </div>

        {/* Notes — saved with the round, synced to the sheet */}
        <div>
          <h2 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider flex items-center gap-1.5">
            <StickyNote size={12} /> Notes
          </h2>
          <textarea
            data-testid="input-round-notes"
            value={notes}
            onChange={e => { setNotes(e.target.value); setNotesSaved(false); }}
            onBlur={saveNotes}
            placeholder="Wind off the left all day · new driver shaft · 3-putt on 4, 7, 12…"
            rows={4}
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm
                       placeholder:text-muted-foreground/60 focus:outline-none
                       focus:ring-2 focus:ring-primary/30 resize-y"
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            {notesSaved ? "Saved" : "Saves when you tap away"}
          </p>
        </div>
      </main>

      {/* Manage Players Sheet */}
      <Sheet open={managePanelOpen} onOpenChange={setManagePanelOpen}>
        <SheetContent side="right" className="w-full max-w-sm">
          <SheetHeader className="mb-4">
            <SheetTitle className="flex items-center gap-2">
              <Users size={18} className="text-primary" /> Manage Players
            </SheetTitle>
            <SheetDescription>Add or remove players from this round.</SheetDescription>
          </SheetHeader>

          {/* Current players */}
          <div className="space-y-2 mb-6">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Current Players</p>
            {players.map((player, pi) => (
              <div key={player.id} className="p-2.5 rounded-lg border border-border space-y-2">
                <div className="flex items-center gap-3">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold bg-muted ${getPlayerColor(pi, player, isTeamGame)}`}>
                    {player.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={`font-semibold text-sm truncate ${getPlayerColor(pi, player, isTeamGame)}`}>{player.name}</div>
                    <div className="text-[10px] text-muted-foreground">P{player.position}</div>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground hover:text-primary"
                    onClick={() => {
                      setEditingPlayerHcp(player.id);
                      setEditPlayerHcpVal(String(player.courseHandicap ?? 0));
                    }}
                  >
                    <Pencil size={12} />
                  </Button>
                  {player.position !== 1 && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                      data-testid={`btn-remove-player-${player.id}`}
                      onClick={() => removePlayerMutation.mutate(player.id)}
                      disabled={removePlayerMutation.isPending}
                    >
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>
                {/* Inline HCP editor */}
                {editingPlayerHcp === player.id ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">Course HCP</span>
                    <input
                      autoFocus
                      type="number"
                      min={0} max={54}
                      value={editPlayerHcpVal}
                      onChange={e => setEditPlayerHcpVal(e.target.value)}
                      className="w-16 border border-primary rounded-md px-2 py-1 text-sm text-center font-semibold focus:outline-none"
                      onKeyDown={e => {
                        if (e.key === "Enter") {
                          const v = parseInt(editPlayerHcpVal);
                          if (!isNaN(v)) updatePlayerHcpMutation.mutate({ playerId: player.id, courseHandicap: v });
                        }
                        if (e.key === "Escape") { setEditingPlayerHcp(null); setEditPlayerHcpVal(""); }
                      }}
                    />
                    <Button size="sm" className="h-7 px-3 text-xs" onClick={() => {
                      const v = parseInt(editPlayerHcpVal);
                      if (!isNaN(v)) updatePlayerHcpMutation.mutate({ playerId: player.id, courseHandicap: v });
                    }}>Save</Button>
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { setEditingPlayerHcp(null); setEditPlayerHcpVal(""); }}>Cancel</Button>
                  </div>
                ) : (
                  <div className="text-[11px] text-muted-foreground pl-9">Course HCP: <span className="font-semibold text-foreground">{player.courseHandicap ?? "—"}</span></div>
                )}
              </div>
            ))}
          </div>

          {/* Add new player */}
          {players.length < 4 && (
            <div className="space-y-3 border-t border-border pt-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Add Player</p>
              <div className="space-y-2">
                <div>
                  <Label htmlFor="new-player-name" className="text-xs">Name</Label>
                  <Input
                    id="new-player-name"
                    value={newPlayerName}
                    onChange={e => setNewPlayerName(e.target.value)}
                    placeholder="Player name"
                    className="mt-1 h-9 text-sm"
                    data-testid="input-new-player-name"
                    onKeyDown={e => e.key === "Enter" && handleAddPlayer()}
                  />
                </div>
                <div>
                  <Label htmlFor="new-player-hcp" className="text-xs">Course Handicap (optional)</Label>
                  <Input
                    id="new-player-hcp"
                    type="number"
                    min={0} max={54}
                    value={newPlayerHcp}
                    onChange={e => setNewPlayerHcp(e.target.value)}
                    placeholder="e.g. 18"
                    className="mt-1 h-9 text-sm"
                    data-testid="input-new-player-hcp"
                  />
                </div>
                <Button
                  className="w-full gap-1.5"
                  size="sm"
                  data-testid="btn-add-player-confirm"
                  onClick={handleAddPlayer}
                  disabled={!newPlayerName.trim() || addPlayerMutation.isPending}
                >
                  <UserPlus size={14} /> Add Player
                </Button>
              </div>
            </div>
          )}
          {players.length >= 4 && (
            <p className="text-xs text-muted-foreground text-center pt-4 border-t border-border">
              Maximum of 4 players reached.
            </p>
          )}
        </SheetContent>
      </Sheet>

      {/* ── Edit Game Mode Sheet ─────────────────────────────────────── */}
      <Sheet open={editGameOpen} onOpenChange={setEditGameOpen}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-xl">
          <SheetHeader className="mb-4">
            <SheetTitle className="flex items-center gap-2">
              <Pencil size={16} className="text-primary" /> Edit Game Mode
            </SheetTitle>
            <SheetDescription>Change the game format for this round.</SheetDescription>
          </SheetHeader>

          {/* Game type selector */}
          <div className="space-y-2 mb-4">
            {GAME_DEFS
              .filter(def => players.length >= def.minPlayers && players.length <= def.maxPlayers)
              .map(def => {
                const isSelected = editGameType === def.value;
                return (
                  <button
                    key={def.value}
                    type="button"
                    onClick={() => {
                      setEditGameType(def.value);
                      if (!def.canToggleTeam) setEditTeamMode(def.isTeam ? "team" : "individual");
                    }}
                    className={`w-full text-left rounded-xl border-2 p-3 transition-all
                      ${isSelected ? "border-primary bg-primary/8" : "border-border hover:border-primary/30"}`}
                  >
                    <div className={`font-semibold text-sm ${isSelected ? "text-primary" : ""}`}>{def.label}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{def.desc}</div>
                    {def.canToggleTeam && isSelected && (
                      <div className="flex gap-2 mt-2">
                        {(["individual", "team"] as const).map(m => (
                          <button
                            key={m}
                            type="button"
                            onClick={e => { e.stopPropagation(); setEditTeamMode(m); }}
                            className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border-2 transition-all
                              ${editTeamMode === m ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
                          >
                            {m === "individual" ? "Individual" : "Team"}
                          </button>
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}
          </div>

          {/* Scoring mode */}
          <div className="space-y-1.5 mb-4">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Scoring Mode</div>
            <div className="space-y-1.5">
              {([
                { key: "net_auto",   label: "Net — by hole HCP",    desc: "Handicap strokes distributed across holes by difficulty ranking" },
                { key: "net_manual", label: "Net — manual HCP",      desc: "Course handicap applied as a flat round reduction" },
                { key: "gross",      label: "Gross (no handicap)",   desc: "Raw strokes only, no handicap applied" },
              ] as const).map(({ key, label, desc }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setEditScoringMode(key)}
                  className={`w-full text-left rounded-xl border-2 px-3 py-2 transition-all
                    ${editScoringMode === key ? "border-primary bg-primary/8" : "border-border hover:border-primary/30"}`}
                >
                  <div className={`font-semibold text-xs ${editScoringMode === key ? "text-primary" : ""}`}>{label}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Tiebreaker + pts per hole — shown when team mode active for best_ball or high_low */}
          {editTeamMode === "team" && (editGameType === "best_ball" || editGameType === "high_low") && (
            <div className="space-y-3 mb-4 rounded-xl border border-border p-3">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Options</div>

              {/* 2nd partner ball tiebreaker — best_ball pairs */}
              {editGameType === "best_ball" && (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-medium">2nd partner ball wins tied holes</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">Use the team's 2nd best score to break ties.</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditPairsTiebreaker(v => !v)}
                    className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${
                      editPairsTiebreaker ? "bg-primary" : "bg-border"
                    }`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${
                      editPairsTiebreaker ? "left-5" : "left-0.5"
                    }`} />
                  </button>
                </div>
              )}

              {/* 2nd score tiebreaker — high_low pairs */}
              {editGameType === "high_low" && (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-medium">2nd score as tiebreaker</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">Use the pair's 2nd ball to break tied holes.</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditSecondScoreTiebreaker(v => !v)}
                    className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${
                      editSecondScoreTiebreaker ? "bg-primary" : "bg-border"
                    }`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${
                      editSecondScoreTiebreaker ? "left-5" : "left-0.5"
                    }`} />
                  </button>
                </div>
              )}

              {/* Points per hole — best_ball or high_low in team mode */}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-medium">Points per hole</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {editGameType === "best_ball"
                      ? "1 = team wins hole · 2 = carry over on ties"
                      : "1 = low wins hole · 2 = high+low both awarded"}
                  </div>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  {[1, 2].map(n => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setEditPtsPerHole(n)}
                      className={`w-8 h-8 rounded-md text-sm font-semibold border-2 transition-colors ${
                        editPtsPerHole === n ? "border-primary bg-primary/10 text-primary" : "border-border"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Teammate picker — shown when team mode active */}
          {editTeamMode === "team" && players.length >= 2 && (() => {
            const sorted = [...players].sort((a, b) => a.position - b.position);
            // Ensure editTeamAssignment has an entry per player
            const ta = editTeamAssignment.length === sorted.length
              ? editTeamAssignment
              : sorted.map((_, i) => i < 2 ? 1 : 2);

            const teamColors: Record<number, { border: string; bg: string; text: string; label: string }> = {
              1: { border: "border-emerald-400", bg: "bg-emerald-100/60 dark:bg-emerald-900/30", text: "text-emerald-600", label: "Team 1" },
              2: { border: "border-blue-400",    bg: "bg-blue-100/60 dark:bg-blue-900/30",       text: "text-blue-600",    label: "Team 2" },
              3: { border: "border-orange-400",  bg: "bg-orange-100/60 dark:bg-orange-900/30",   text: "text-orange-600",  label: "Solo" },
            };

            return (
              <div className="mb-4">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Team Assignment</div>
                <div className="space-y-2">
                  {sorted.map((p, i) => {
                    const curTeam = ta[i] ?? 1;
                    const { border, bg, text, label } = teamColors[curTeam];
                    return (
                      <div key={p.id} className="flex items-center gap-2">
                        <div className="flex-1 flex items-center gap-2 min-w-0">
                          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold bg-muted ${text}`}>
                            {p.name[0]?.toUpperCase()}
                          </div>
                          <span className="text-xs font-medium truncate">{p.name}</span>
                        </div>
                        {/* Team selector pills */}
                        <div className="flex gap-1">
                          {([1, 2, 3] as const).map(t => {
                            const c = teamColors[t];
                            const active = curTeam === t;
                            return (
                              <button
                                key={t}
                                type="button"
                                onClick={() => {
                                  const next = [...ta];
                                  next[i] = t;
                                  setEditTeamAssignment(next);
                                }}
                                className={`px-2 py-0.5 rounded-full text-[10px] font-bold border transition-all
                                  ${ active ? `${c.border} ${c.bg} ${c.text}` : "border-border text-muted-foreground/50 hover:border-primary/30" }`}
                              >
                                {t === 3 ? "Solo" : `T${t}`}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="text-[10px] text-muted-foreground mt-2">T1 vs T2 play together. Solo = individual scoring.</p>
              </div>
            );
          })()}

          {/* Hole HCP rank editor */}
          {editHoleHcps.length > 0 && (
            <div className="mb-4 rounded-xl border border-border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Hole Handicap Ranks</div>
                <button
                  type="button"
                  className="text-[10px] text-primary underline"
                  onClick={() => {
                    // Reset to course defaults (1–18 in order)
                    setEditHoleHcps(editHoleHcps.map((_, i) => i + 1));
                  }}
                >Reset</button>
              </div>
              <p className="text-[10px] text-muted-foreground">Rank 1 = hardest hole (most strokes given). Each rank 1–{holes} should be unique.</p>
              <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(9, holes)}, 1fr)` }}>
                {editHoleHcps.map((rank, i) => (
                  <div key={i} className="flex flex-col items-center gap-0.5">
                    <span className="text-[9px] text-muted-foreground">{i + 1}</span>
                    <input
                      type="number"
                      min={1}
                      max={holes}
                      value={rank}
                      onChange={e => {
                        const v = parseInt(e.target.value);
                        if (!isNaN(v) && v >= 1 && v <= holes) {
                          const updated = [...editHoleHcps];
                          updated[i] = v;
                          setEditHoleHcps(updated);
                        }
                      }}
                      className="w-full text-center text-xs font-semibold border border-border rounded-md py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                ))}
              </div>
              {/* Duplicate rank warning */}
              {editHoleHcps.length === new Set(editHoleHcps).size ? null : (
                <p className="text-[10px] text-amber-600">⚠ Duplicate ranks detected — each hole should have a unique rank.</p>
              )}
              {/* Save to course toggle — only when round is linked to a saved course */}
              {round.courseId && (
                <label className="flex items-center gap-2 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={saveHcpToCourse}
                    onChange={e => setSaveHcpToCourse(e.target.checked)}
                    className="rounded border-border accent-primary w-3.5 h-3.5"
                  />
                  <span className="text-[11px] text-muted-foreground">Also save to course defaults</span>
                </label>
              )}
            </div>
          )}

          <Button
            className="w-full mt-2"
            disabled={updateGameMutation.isPending}
            onClick={async () => {
              const def = GAME_DEFS.find(d => d.value === editGameType)!;
              let resolvedType = editGameType;
              if (def.canToggleTeam) {
                resolvedType = editTeamMode === "team" ? (def.teamVariant ?? editGameType) : (def.indivVariant ?? editGameType);
              }
              // Build teamAssignment array if in team mode
              const isTeamMode = TEAM_GAME_TYPES.includes(resolvedType) ||
                (def.canToggleTeam && editTeamMode === "team");
              const sorted = [...players].sort((a, b) => a.position - b.position);
              const ta = isTeamMode && editTeamAssignment.length === sorted.length
                ? editTeamAssignment
                : undefined;

              const gameOptions = JSON.stringify({
                scoringMode: editScoringMode,
                ptsPerHole: editPtsPerHole,
                pairsTiebreaker: editPairsTiebreaker,
                secondScoreTiebreaker: editSecondScoreTiebreaker,
                ...(ta ? { teamAssignment: ta } : {}),
              });

              updateGameMutation.mutate({ gameType: resolvedType, gameOptions });
              // Save hole HCPs if they changed
              if (JSON.stringify(editHoleHcps) !== JSON.stringify(holeHcps)) {
                updateHoleHcpsMutation.mutate(editHoleHcps);
                if (saveHcpToCourse && round.courseId) {
                  updateCourseHcpsMutation.mutate({ courseId: round.courseId, holeHandicaps: editHoleHcps });
                }
              }
            }}
          >
            {updateGameMutation.isPending ? "Saving…" : "Apply Game Mode"}
          </Button>
        </SheetContent>
      </Sheet>

      {/* Bottom sheet stepper for score entry */}
      {sheetPlayerId !== null && (() => {
        const sheetPlayer = players.find(p => p.id === sheetPlayerId);
        if (!sheetPlayer) return null;
        const pi = players.indexOf(sheetPlayer);
        const isTeamGame = TEAM_GAME_TYPES.includes(round.gameType ?? "");
        const playerColor = getPlayerColor(pi, sheetPlayer, isTeamGame);
        const par = pars[sheetHole - 1] ?? 4;
        const holeHcp = holeHcps[sheetHole - 1] ?? sheetHole;
        const strokesOnHole = handicapStrokesOnHole(sheetPlayer.courseHandicap, holeHcp, holes);
        const strVal = getCellValue(sheetPlayerId, sheetHole, "strokes");
        const puttsVal = getCellValue(sheetPlayerId, sheetHole, "putts");
        const initStrokes = strVal !== "" ? parseInt(strVal) : null;
        const initPutts = puttsVal !== "" ? parseInt(puttsVal) : 0;
        return (
          <HoleInputSheet
            key={`${sheetPlayerId}-${sheetHole}`}
            open={sheetOpen}
            hole={sheetHole}
            displayHole={holeLabel(sheetHole)}
            totalHoles={holes}
            par={par}
            holeHcp={holeHcp}
            playerName={sheetPlayer.name}
            playerColor={playerColor}
            strokesOnHole={strokesOnHole}
            initialStrokes={initStrokes}
            initialPutts={initPutts}
            onSave={handleSheetSave}
            onDelete={handleSheetDelete}
            onClose={() => setSheetOpen(false)}
            onNavNext={(h, s, p) => {
              handleSheetSave(h, s, p);
              if (h < holes) setSheetHole(h + 1);
              else setSheetOpen(false);
            }}
            onNavPrev={(h, s, p) => {
              handleSheetSave(h, s, p);
              if (h > 1) setSheetHole(h - 1);
            }}
          />
        );
      })()}
    </div>
  );
}