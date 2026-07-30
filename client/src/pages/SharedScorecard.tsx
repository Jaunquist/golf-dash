/**
 * SharedScorecard — public score-entry view for fellow players.
 * Accessed via /#/shared/:roundId
 * - No navigation bar, no access to dashboard/courses/rounds history
 * - Score entry enabled for active rounds (same cell UX as main Scorecard)
 * - Read-only totals + legend
 * - Cannot finish, delete, or change game settings
 */

import { useState, useCallback, useRef } from "react";
import { useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Ghost } from "lucide-react";
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

function getPlayerColor(playerIndex: number, player: RoundPlayer, isTeamGame: boolean): string {
  if (!isTeamGame) return PLAYER_COLORS[playerIndex];
  return player.position <= 2
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-blue-600 dark:text-blue-400";
}

export default function SharedScorecard() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const qc = useQueryClient();
  const roundId = id!;

  const [pending, setPending] = useState<Record<string, { strokes: string; putts: string }>>({});
  const [activeCell, setActiveCell] = useState<{ playerId: number; hole: number } | null>(null);
  const cellFocusRef = useRef<Record<string, boolean>>({});

  const { data, isLoading } = useQuery<{ round: Round; players: RoundPlayer[]; scores: HoleScore[] }>({
    queryKey: ["/api/rounds", roundId],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/rounds/${roundId}`);
      return r.json();
    },
  });

  const gameOptsRaw = data?.round ? JSON.parse(data.round.gameOptions) : {};
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
    mutationFn: async ({ playerId, hole, strokes, putts }: { playerId: number; hole: number; strokes: number | null; putts: number | null }) => {
      const r = await apiRequest("PUT", `/api/rounds/${roundId}/scores`, { playerId, hole, strokes, putts });
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/rounds", roundId] }),
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  const getPendingKey = (playerId: number, hole: number) => `${playerId}_${hole}`;

  const handleCellChange = useCallback((playerId: number, hole: number, field: "strokes" | "putts", value: string) => {
    const key = getPendingKey(playerId, hole);
    setPending(prev => ({
      ...prev,
      [key]: { strokes: prev[key]?.strokes ?? "", putts: prev[key]?.putts ?? "", [field]: value }
    }));
  }, []);

  const handleCellBlur = useCallback((playerId: number, hole: number) => {
    setTimeout(() => {
      const key = getPendingKey(playerId, hole);
      if (cellFocusRef.current[key]) return;
      const edit = pending[key];
      if (!edit) return;
      const strokes = edit.strokes !== "" ? parseInt(edit.strokes) : null;
      const putts = edit.putts !== "" ? parseInt(edit.putts) : null;
      saveMutation.mutate({
        playerId, hole,
        strokes: strokes != null && !isNaN(strokes) ? strokes : null,
        putts: putts != null && !isNaN(putts) ? putts : null,
      });
      setPending(prev => { const n = { ...prev }; delete n[key]; return n; });
      setActiveCell(null);
    }, 120);
  }, [pending, saveMutation]);

  const handleCellFocusIn = useCallback((playerId: number, hole: number) => {
    cellFocusRef.current[getPendingKey(playerId, hole)] = true;
  }, []);
  const handleCellFocusOut = useCallback((playerId: number, hole: number) => {
    cellFocusRef.current[getPendingKey(playerId, hole)] = false;
    handleCellBlur(playerId, hole);
  }, [handleCellBlur]);

  if (isLoading) return (
    <div className="min-h-screen bg-background p-4 space-y-4">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
  if (!data) return <div className="p-8 text-center text-muted-foreground">Round not found.</div>;

  const { round, players, scores } = data;
  const pars: number[] = JSON.parse(round.pars);
  const holeHcps: number[] = JSON.parse(round.holeHandicaps);
  const gameOpts = JSON.parse(round.gameOptions);
  const holes = round.holes;
  const isSoloRound = gameOpts?.solo === true;
  const isTeamGame = TEAM_GAME_TYPES.includes(round.gameType);

  const scoreLookup: Record<string, HoleScore> = {};
  scores.forEach(s => { scoreLookup[`${s.playerId}_${s.hole}`] = s; });

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

  const front = Array.from({ length: Math.min(9, holes) }, (_, i) => i + 1);
  const back = holes === 18 ? Array.from({ length: 9 }, (_, i) => i + 10) : [];

  function getCellValue(playerId: number, hole: number, field: "strokes" | "putts"): string {
    const key = getPendingKey(playerId, hole);
    if (pending[key]?.[field] !== undefined && pending[key][field] !== "") return pending[key][field];
    const s = scoreLookup[`${playerId}_${hole}`];
    if (!s) return "";
    const v = field === "strokes" ? s.strokes : s.putts;
    return v == null ? "" : String(v);
  }

  function getSectionTotal(playerId: number, holeList: number[], field: "strokes" | "putts"): number | null {
    let total = 0, hasAny = false;
    for (const h of holeList) {
      const v = getCellValue(playerId, h, field);
      if (v !== "") { total += parseInt(v) || 0; hasAny = true; }
    }
    return hasAny ? total : null;
  }

  function getSectionPar(holeList: number[]): number {
    return holeList.reduce((s, h) => s + (pars[h - 1] ?? 4), 0);
  }

  function getNetTotal(playerId: number, holeList: number[]): { net: number; playedPar: number } | null {
    const player = players.find(p => p.id === playerId);
    if (!player) return null;
    let total = 0, hasAny = false, playedPar = 0;
    for (const h of holeList) {
      const strVal = getCellValue(playerId, h, "strokes");
      if (strVal === "") continue;
      const gross = parseInt(strVal);
      const net = gross - handicapStrokesOnHole(player.courseHandicap, holeHcps[h - 1] ?? h, holes);
      total += net;
      playedPar += pars[h - 1] ?? 4;
      hasAny = true;
    }
    return hasAny ? { net: total, playedPar } : null;
  }

  function renderSection(holeList: number[]) {
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse min-w-[600px]">
          <thead>
            <tr className="bg-primary/8 border-b border-border">
              <th className="text-left px-2 py-2 font-semibold text-muted-foreground w-20 sticky left-0 bg-primary/8 z-10">Player</th>
              {holeList.map(h => (
                <th key={h} className="text-center px-1 py-2 font-semibold w-10">
                  <div>{h}</div>
                  <div className="text-muted-foreground font-normal">{pars[h - 1]}</div>
                  <div className="text-[9px] text-muted-foreground/60 font-normal">H{holeHcps[h - 1]}</div>
                </th>
              ))}
              <th className="text-center px-2 py-2 font-semibold w-14">OUT/IN</th>
            </tr>
          </thead>
          <tbody>
            {players.map((player, pi) => {
              const grossTotal = getSectionTotal(player.id, holeList, "strokes");
              const netResult = getNetTotal(player.id, holeList);
              const holeResultForSection = holeResults.filter(hr => holeList.includes(hr.hole));
              const sectionPts = holeResultForSection.reduce((s, hr) => s + (hr.points[player.id] || 0), 0);
              const playerColor = getPlayerColor(pi, player, isTeamGame);
              return (
                <tr key={player.id} className={`border-b border-border/50 ${pi % 2 === 0 ? "" : "bg-muted/20"}`}>
                  <td className="px-2 py-1.5 sticky left-0 bg-card z-10">
                    <div className={`font-semibold truncate max-w-[70px] ${playerColor}`}>{player.name}</div>
                    <div className="text-[9px] text-muted-foreground">HCP {player.courseHandicap ?? "—"}</div>
                  </td>
                  {holeList.map(h => {
                    const holeHcpRank = holeHcps[h - 1] ?? h;
                    const strVal = getCellValue(player.id, h, "strokes");
                    const puttsVal = getCellValue(player.id, h, "putts");
                    const strInt = strVal !== "" ? parseInt(strVal) : null;
                    const strokesOnHole = handicapStrokesOnHole(player.courseHandicap, holeHcpRank, holes);
                    const hr = holeResults.find(r => r.hole === h);
                    const isWinner = hr?.winners.includes(player.id);
                    const cssClass = scoreCssClass(strInt, pars[h - 1] ?? 4);
                    const isActive = activeCell?.playerId === player.id && activeCell?.hole === h;
                    const isEditable = round.status === "active";
                    const cellKey = getPendingKey(player.id, h);

                    return (
                      <td key={h} className="text-center p-0.5">
                        <div
                          className={`relative rounded w-9 h-10 mx-auto flex flex-col items-center justify-center
                            ${isEditable ? "cursor-pointer" : "cursor-default"}
                            border ${isWinner ? "border-accent bg-accent/10" : "border-transparent"}
                            ${isActive ? "ring-2 ring-primary" : isEditable ? "hover:border-border" : ""}`}
                          data-testid={`score-cell-${player.id}-${h}`}
                          onClick={() => isEditable && !isActive && setActiveCell({ playerId: player.id, hole: h })}
                        >
                          {strokesOnHole > 0 && (
                            <div className="absolute top-0.5 left-0.5 flex gap-0.5">
                              {Array.from({ length: strokesOnHole }).map((_, i) => (
                                <div key={i} className="w-1 h-1 bg-primary/40 rounded-full" />
                              ))}
                            </div>
                          )}
                          {isActive && isEditable ? (
                            <div
                              className="flex flex-col gap-0.5"
                              onFocus={() => handleCellFocusIn(player.id, h)}
                              onBlur={() => handleCellFocusOut(player.id, h)}
                            >
                              <input
                                autoFocus
                                type="number"
                                min={0} max={15}
                                value={pending[cellKey]?.strokes ?? getCellValue(player.id, h, "strokes")}
                                onChange={e => handleCellChange(player.id, h, "strokes", e.target.value)}
                                className="w-8 text-center text-xs font-bold bg-transparent outline-none tabular"
                                placeholder="—"
                              />
                              <input
                                type="number"
                                min={0} max={7}
                                value={pending[cellKey]?.putts ?? getCellValue(player.id, h, "putts")}
                                onChange={e => handleCellChange(player.id, h, "putts", e.target.value)}
                                className="w-8 text-center text-[9px] text-muted-foreground bg-transparent outline-none tabular"
                                placeholder="putts"
                              />
                            </div>
                          ) : (
                            <div className="flex items-baseline justify-center gap-0.5">
                              <span className={`font-bold text-sm tabular leading-none ${cssClass}`}>
                                {strVal !== "" ? strVal : <span className="text-muted-foreground/40">—</span>}
                              </span>
                              {puttsVal !== "" && strVal !== "" && (
                                <sup className="text-[8px] text-muted-foreground leading-none">{puttsVal}</sup>
                              )}
                            </div>
                          )}
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
            {/* Ghost row */}
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
                  const ghostScore = ghostData.scores[h];
                  if (!ghostScore) return <td key={h} className="text-center p-0.5"><span className="text-[10px] text-muted-foreground/40">—</span></td>;
                  const cssClass = scoreCssClass(ghostScore.strokes, pars[h - 1] ?? 4);
                  return (
                    <td key={h} className="text-center p-0.5">
                      <div className="w-9 h-10 mx-auto flex items-center justify-center">
                        <span className={`font-bold text-sm tabular leading-none ${cssClass}`}>{ghostScore.strokes}</span>
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
            {/* Points row */}
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
                <td className="text-center px-1 text-xs text-primary font-semibold">{getSectionPar(holeList)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  function renderTotals() {
    const allHoles = Array.from({ length: holes }, (_, i) => i + 1);
    const maxPts = Math.max(0, ...Object.values(totals));

    function playerStatRow(player: (typeof players)[0], pi: number, showPts: boolean, bgClass = "") {
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
      players.forEach(p => { const t = getTeam(p); if (!teamGroups[t]) teamGroups[t] = []; teamGroups[t].push(p); });
      const teamMeta: Record<number, { label: string; bgClass: string; colorClass: string; isSolo: boolean }> = {
        1: { label: "Team 1", bgClass: "bg-emerald-50/40 dark:bg-emerald-950/20", colorClass: "text-emerald-600 dark:text-emerald-400", isSolo: false },
        2: { label: "Team 2", bgClass: "bg-blue-50/40 dark:bg-blue-950/20", colorClass: "text-blue-600 dark:text-blue-400", isSolo: false },
        3: { label: "Solo", bgClass: "bg-orange-50/40 dark:bg-orange-950/20", colorClass: "text-orange-500 dark:text-orange-400", isSolo: true },
      };
      function teamSummaryRow(teamPlayers: typeof players, meta: typeof teamMeta[number]) {
        if (meta.isSolo) return null;
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
              {Object.keys(teamGroups).map(Number).sort().map(t => {
                const group = teamGroups[t];
                const meta = teamMeta[t] ?? teamMeta[2];
                return (
                  <>
                    {group.map(p => playerStatRow(p, players.indexOf(p), meta.isSolo, meta.bgClass))}
                    {!meta.isSolo && teamSummaryRow(group, meta)}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      );
    }

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

  const smShort: Record<string, string> = { net_auto: "Net/HCP", net_manual: "Net/Manual", gross: "Gross" };
  const sm = gameOpts?.scoringMode ?? "net_auto";

  return (
    <div className="min-h-screen bg-background">
      {/* Minimal header — no nav links */}
      <header className="sticky top-0 z-20 bg-background/95 backdrop-blur-sm border-b border-border">
        <div className="max-w-5xl mx-auto px-3">
          {/* Row 1: branding + status */}
          <div className="h-12 flex items-center gap-2">
            {/* Golf logo mark */}
            <svg viewBox="0 0 32 32" width="24" height="24" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
              <circle cx="16" cy="16" r="16" fill="#1d5c3a"/>
              <line x1="13" y1="7" x2="13" y2="24" stroke="#f5f2ea" strokeWidth="1.8" strokeLinecap="round"/>
              <path d="M13 7 L22 10.5 L13 14 Z" fill="#d4a017"/>
              <circle cx="13" cy="25.5" r="2.5" fill="#f5f2ea"/>
            </svg>
            <div className="flex-1 min-w-0">
              <h1 className="font-display font-bold text-sm leading-tight truncate">{round.courseName}</h1>
              <div className="text-[10px] text-muted-foreground leading-tight">{round.date} · {round.holes}H · Shared scorecard</div>
            </div>
            {round.status === "active"
              ? <Badge className="text-[10px] py-0.5 px-2 bg-green-600 shrink-0">Live</Badge>
              : <Badge className="text-[10px] py-0.5 px-2 shrink-0" variant="outline">Complete</Badge>
            }
          </div>
          {/* Row 2: game + scoring badges */}
          <div className="h-8 flex items-center gap-1.5 pb-1">
            <Badge variant="outline" className="text-[10px] py-0 px-1.5">{GAME_LABELS[round.gameType] || round.gameType}</Badge>
            {!isSoloRound && (
              <Badge variant="outline" className="text-[10px] py-0 px-1.5 text-muted-foreground border-dashed">{smShort[sm] ?? sm}</Badge>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-3 py-4 space-y-4">
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

        {/* Front 9 */}
        <div>
          <h2 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">
            {holes === 18 ? "Front 9" : "Scorecard"} · Par {getSectionPar(front)}
          </h2>
          {renderSection(front)}
        </div>

        {/* Back 9 */}
        {back.length > 0 && (
          <div>
            <h2 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">Back 9 · Par {getSectionPar(back)}</h2>
            {renderSection(back)}
          </div>
        )}

        {/* Totals */}
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="bg-primary/8 px-3 py-2 border-b border-border">
            <span className="text-xs font-semibold text-primary uppercase tracking-wider">Totals</span>
          </div>
          {renderTotals()}
        </div>

        {/* Footer note */}
        <p className="text-[10px] text-muted-foreground text-center pb-4">
          Shared by Golf Dash · View only — scores update live
        </p>
      </main>
    </div>
  );
}
