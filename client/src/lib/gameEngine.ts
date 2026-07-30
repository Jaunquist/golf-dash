/**
 * Golf Game Engine
 * Calculates game results hole-by-hole for:
 *   best_ball, best_ball_pairs, high_low, high_low_pairs,
 *   niners (3 players), twelves (4 players), match_play, match_play_indiv
 */

export type GameType =
  | "best_ball"
  | "best_ball_pairs"
  | "high_low"
  | "high_low_pairs"
  | "niners"
  | "twelves"
  | "match_play"
  | "match_play_indiv";

/**
 * scoringMode:
 *   "net_auto"   — subtract handicap strokes per hole (default, original behaviour)
 *   "net_manual" — each player's courseHandicap applied as a flat per-round reduction;
 *                  the engine still uses handicapStrokesOnHole() so it distributes the
 *                  manual hcp across holes in the standard way (identical to net_auto for
 *                  1×18 courses). Stored so UI can label it differently.
 *   "gross"      — use raw strokes, no handicap applied
 */
export type ScoringMode = "net_auto" | "net_manual" | "gross";

export interface GameOptions {
  // Scoring
  scoringMode?: ScoringMode;     // default "net_auto"

  // high_low / high_low_pairs
  ptsPerHole?: number;           // 1 or 2
  secondScoreTiebreaker?: boolean;
  // best_ball / best_ball_pairs
  pairsTiebreaker?: boolean;

  // Team assignment override: index = player sort order, value = team number (1, 2, 3)
  // If absent, fall back to position-based (pos 1-2 = T1, pos 3-4 = T2)
  teamAssignment?: number[];

  // Solo/ghost flags (existing)
  solo?: boolean;
  ghost?: boolean;
}

export interface Player {
  id: number;
  name: string;
  courseHandicap: number;
  position: number; // 1-4
}

/** Get the team number for a player: uses teamAssignment if present, else position-based (1-2=T1, 3-4=T2) */
export function playerTeam(player: Player, players: Player[], teamAssignment?: number[]): number {
  if (teamAssignment && teamAssignment.length > 0) {
    // teamAssignment is indexed by player sort order (by position)
    const sorted = [...players].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex(p => p.id === player.id);
    return idx >= 0 && idx < teamAssignment.length ? teamAssignment[idx] : player.position <= 2 ? 1 : 2;
  }
  return player.position <= 2 ? 1 : 2;
}

// Returns net score given gross, course handicap, hole handicap ranking (1=hardest), totalHoles
export function netScore(gross: number, courseHandicap: number, holeHcpRank: number, totalHoles: number): number {
  const strokes = handicapStrokesOnHole(courseHandicap, holeHcpRank, totalHoles);
  return gross - strokes;
}

export function handicapStrokesOnHole(courseHandicap: number, holeHcpRank: number, totalHoles: number): number {
  if (courseHandicap <= 0) return 0;
  const full = Math.floor(courseHandicap / totalHoles);
  const remainder = courseHandicap % totalHoles;
  return full + (holeHcpRank <= remainder ? 1 : 0);
}

/** Compute the "playing score" for a player on a hole based on scoring mode */
function playingScore(
  gross: number,
  courseHandicap: number,
  holeHcpRank: number,
  totalHoles: number,
  mode: ScoringMode
): number {
  if (mode === "gross") return gross;
  // net_auto and net_manual both use handicap-distributed strokes
  return netScore(gross, courseHandicap, holeHcpRank, totalHoles);
}

export interface HoleResult {
  hole: number;
  // For each player: points won this hole
  points: Record<number, number>; // playerId -> points
  // Which playerIds won this hole
  winners: number[];
  note?: string; // e.g. "Tie", "Eagle!"
}

// Compute hole results for the full round
export function computeGameResults(
  players: Player[],
  // gross strokes per player per hole: { [playerId]: { [hole]: strokes } }
  grossScores: Record<number, Record<number, number | null>>,
  pars: number[],
  holeHandicaps: number[], // holeHandicaps[i] = handicap rank for hole i+1
  holes: number,
  gameType: GameType,
  options: GameOptions = {}
): HoleResult[] {
  const results: HoleResult[] = [];
  const totalHoles = holes;
  const mode: ScoringMode = options.scoringMode ?? "net_auto";

  for (let h = 1; h <= totalHoles; h++) {
    const holeIdx = h - 1;
    const par = pars[holeIdx] ?? 4;
    const hcpRank = holeHandicaps[holeIdx] ?? h;
    const holeResult: HoleResult = { hole: h, points: {}, winners: [] };
    players.forEach(p => { holeResult.points[p.id] = 0; });

    // Playing scores for this hole (net or gross)
    const playScores: Record<number, number | null> = {};
    players.forEach(p => {
      const g = grossScores[p.id]?.[h] ?? null;
      if (g == null) { playScores[p.id] = null; }
      else { playScores[p.id] = playingScore(g, p.courseHandicap, hcpRank, totalHoles, mode); }
    });

    const anyNull = players.some(p => playScores[p.id] == null);

    const ta = options.teamAssignment;

    switch (gameType) {
      case "best_ball":
      case "match_play": {
        if (!anyNull) {
          // Group players by team (supports T1, T2, T3 via teamAssignment)
          const teamMap: Record<number, Player[]> = {};
          players.forEach(p => {
            const t = playerTeam(p, players, ta);
            if (!teamMap[t]) teamMap[t] = [];
            teamMap[t].push(p);
          });
          const teamNums = Object.keys(teamMap).map(Number).sort();
          // Best score per team
          const teamBest: Record<number, number> = {};
          teamNums.forEach(t => {
            teamBest[t] = Math.min(...teamMap[t].map(p => playScores[p.id]!));
          });
          const minScore = Math.min(...Object.values(teamBest));
          const winningTeams = teamNums.filter(t => teamBest[t] === minScore);
          const pts = options.ptsPerHole ?? 1;
          if (winningTeams.length === 1) {
            const wt = winningTeams[0];
            // Award pts to the first (representative) player only so team total = pts, not pts * teamSize
            const rep = teamMap[wt][0];
            holeResult.points[rep.id] = pts;
            holeResult.winners = teamMap[wt].map(p => p.id);
          } else {
            holeResult.note = "Tie";
          }
        }
        break;
      }

      case "match_play_indiv": {
        // Individual match play: each player vs every other; winner of most matchups earns the hole
        // Simpler: low score wins the hole point (same as high_low but named match play)
        if (!anyNull && players.length >= 2) {
          const sorted = [...players].sort((a, b) => playScores[a.id]! - playScores[b.id]!);
          const lowest = playScores[sorted[0].id]!;
          const second = playScores[sorted[1].id]!;
          if (lowest < second) {
            holeResult.points[sorted[0].id] = 1;
            holeResult.winners = [sorted[0].id];
          } else {
            // Tie between lowest scorers
            holeResult.note = "Tie";
          }
        }
        break;
      }

      case "best_ball_pairs": {
        if (!anyNull) {
          const team1 = players.filter(p => playerTeam(p, players, ta) === 1);
          const team2 = players.filter(p => playerTeam(p, players, ta) === 2);
          const t1Scores = team1.map(p => playScores[p.id]!).sort((a,b)=>a-b);
          const t2Scores = team2.map(p => playScores[p.id]!).sort((a,b)=>a-b);
          let winner: Player[] | null = null;
          if (t1Scores[0] < t2Scores[0]) {
            winner = team1;
          } else if (t2Scores[0] < t1Scores[0]) {
            winner = team2;
          } else {
            if (options.pairsTiebreaker && t1Scores[1] != null && t2Scores[1] != null) {
              if (t1Scores[1] < t2Scores[1]) winner = team1;
              else if (t2Scores[1] < t1Scores[1]) winner = team2;
            }
          }
          const bbPts = options.ptsPerHole ?? 1;
          if (winner) {
            // Award pts to representative player only — team total shown as sum, so 1 rep = correct total
            holeResult.points[winner[0].id] = bbPts;
            holeResult.winners = winner.map(p => p.id);
          } else {
            holeResult.note = "Tie";
          }
        }
        break;
      }

      case "high_low": {
        if (!anyNull && players.length >= 2) {
          const pts = options.ptsPerHole ?? 1;
          const sorted = [...players].sort((a, b) => playScores[a.id]! - playScores[b.id]!);
          const lowestPlay = playScores[sorted[0].id]!;
          const highestPlay = playScores[sorted[sorted.length - 1].id]!;
          if (lowestPlay < highestPlay) {
            holeResult.points[sorted[0].id] = pts;
            holeResult.points[sorted[sorted.length - 1].id] = 0;
            holeResult.winners = [sorted[0].id];
          }
        }
        break;
      }

      case "high_low_pairs": {
        if (!anyNull) {
          const pts = options.ptsPerHole ?? 1;
          const team1 = players.filter(p => playerTeam(p, players, ta) === 1);
          const team2 = players.filter(p => playerTeam(p, players, ta) === 2);
          if (team1.length >= 2 && team2.length >= 2) {
            const t1Sorted = [...team1].sort((a,b)=>playScores[a.id]!-playScores[b.id]!);
            const t2Sorted = [...team2].sort((a,b)=>playScores[a.id]!-playScores[b.id]!);

            // Determine low match winner (0=tie, 1=team1, 2=team2)
            let lowWinner = 0;
            if (playScores[t1Sorted[0].id]! < playScores[t2Sorted[0].id]!) {
              lowWinner = 1;
            } else if (playScores[t2Sorted[0].id]! < playScores[t1Sorted[0].id]!) {
              lowWinner = 2;
            } else if (options.secondScoreTiebreaker) {
              if (playScores[t1Sorted[1].id]! < playScores[t2Sorted[1].id]!) lowWinner = 1;
              else if (playScores[t2Sorted[1].id]! < playScores[t1Sorted[1].id]!) lowWinner = 2;
            }

            // Determine high match winner
            let highWinner = 0;
            if (playScores[t1Sorted[1].id]! < playScores[t2Sorted[1].id]!) {
              highWinner = 1;
            } else if (playScores[t2Sorted[1].id]! < playScores[t1Sorted[1].id]!) {
              highWinner = 2;
            }

            const t1Wins = (lowWinner === 1 ? 1 : 0) + (highWinner === 1 ? 1 : 0);
            const t2Wins = (lowWinner === 2 ? 1 : 0) + (highWinner === 2 ? 1 : 0);

            // Split (1-1): offset to zero — push, no points awarded
            if (t1Wins === 1 && t2Wins === 1) {
              holeResult.note = "Push";
              // No points awarded — hole cancels out
            } else if (t1Wins > t2Wins) {
              // Team 1 wins the hole — award pts to rep player
              holeResult.points[t1Sorted[0].id] = pts;
              holeResult.winners = team1.map(p => p.id);
            } else if (t2Wins > t1Wins) {
              // Team 2 wins the hole
              holeResult.points[t2Sorted[0].id] = pts;
              holeResult.winners = team2.map(p => p.id);
            } else {
              // Full tie (0-0)
              holeResult.note = "Tie";
            }
          }
        }
        break;
      }

      case "niners": {
        if (!anyNull && players.length >= 3) {
          const sorted = [...players.slice(0,3)].sort((a, b) => playScores[a.id]! - playScores[b.id]!);
          const [a, b, c] = sorted.map(p => playScores[p.id]!);
          if (a === b && b === c) {
            sorted.forEach(p => { holeResult.points[p.id] = 3; });
            holeResult.note = "Tie – 3 pts each";
          } else if (a === b) {
            holeResult.points[sorted[0].id] = 4;
            holeResult.points[sorted[1].id] = 4;
            holeResult.points[sorted[2].id] = 1;
            holeResult.winners = [sorted[0].id, sorted[1].id];
          } else if (b === c) {
            holeResult.points[sorted[0].id] = 5;
            holeResult.points[sorted[1].id] = 2;
            holeResult.points[sorted[2].id] = 2;
            holeResult.winners = [sorted[0].id];
          } else {
            holeResult.points[sorted[0].id] = 5;
            holeResult.points[sorted[1].id] = 3;
            holeResult.points[sorted[2].id] = 1;
            holeResult.winners = [sorted[0].id];
          }
        }
        break;
      }

      case "twelves": {
        if (!anyNull && players.length >= 4) {
          const distribution = [5, 3, 2, 1];
          const sorted = [...players].sort((a, b) => playScores[a.id]! - playScores[b.id]!);
          let i = 0;
          while (i < 4) {
            const currentScore = playScores[sorted[i].id]!;
            const tiedGroup: Player[] = [sorted[i]];
            let j = i + 1;
            while (j < 4 && playScores[sorted[j].id]! === currentScore) {
              tiedGroup.push(sorted[j]);
              j++;
            }
            const groupPts = distribution.slice(i, j).reduce((s, p) => s + p, 0) / tiedGroup.length;
            tiedGroup.forEach(p => { holeResult.points[p.id] = Math.round(groupPts); });
            i = j;
          }
          const maxPts = Math.max(...Object.values(holeResult.points));
          holeResult.winners = players.filter(p => holeResult.points[p.id] === maxPts).map(p => p.id);
        }
        break;
      }
    }

    results.push(holeResult);
  }

  return results;
}

// Compute cumulative totals across holes
export function cumulativeTotals(holeResults: HoleResult[], players: Player[]): Record<number, number> {
  const totals: Record<number, number> = {};
  players.forEach(p => { totals[p.id] = 0; });
  holeResults.forEach(hr => {
    players.forEach(p => {
      totals[p.id] = (totals[p.id] || 0) + (hr.points[p.id] || 0);
    });
  });
  return totals;
}

// Score label relative to par
export function scoreToPar(strokes: number | null, par: number): string {
  if (strokes == null) return "-";
  const diff = strokes - par;
  if (diff <= -2) return "Eagle";
  if (diff === -1) return "Birdie";
  if (diff === 0) return "Par";
  if (diff === 1) return "Bogey";
  if (diff === 2) return "Double";
  return `+${diff}`;
}

export function scoreCssClass(strokes: number | null, par: number): string {
  if (strokes == null) return "";
  const diff = strokes - par;
  if (diff <= -2) return "score-eagle";
  if (diff === -1) return "score-birdie";
  if (diff === 0) return "score-par";
  if (diff === 1) return "score-bogey";
  if (diff === 2) return "score-double";
  return "score-worse";
}
