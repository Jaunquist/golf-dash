import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import type {
  Course, Round, RoundPlayer, HoleScore,
  InsertCourse, InsertRound, InsertRoundPlayer, InsertHoleScore,
} from "@shared/schema";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
// Accept both SUPABASE_KEY (our name) and SUPABASE_ANON_KEY (pplx.app proxy injects this name)
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("WARNING: SUPABASE_URL and SUPABASE_KEY/SUPABASE_ANON_KEY are not set. API calls will fail.");
  console.error("ENV CHECK — SUPABASE_URL:", !!process.env.SUPABASE_URL, "SUPABASE_KEY:", !!process.env.SUPABASE_KEY, "SUPABASE_ANON_KEY:", !!process.env.SUPABASE_ANON_KEY);
}

export const supabase = createClient(
  SUPABASE_URL || "https://placeholder.supabase.co",
  SUPABASE_KEY || "placeholder",
  {
    global: { fetch: fetch as any },
    realtime: { transport: ws as any },
  }
);

// Helper: throw on Supabase error
function check<T>(result: { data: T | null; error: any }, context: string): T {
  if (result.error) throw new Error(`[Supabase ${context}] ${result.error.message}`);
  return result.data as T;
}

export interface IStorage {
  // Courses
  getCourses(): Promise<Course[]>;
  getCourse(id: number): Promise<Course | undefined>;
  createCourse(data: InsertCourse): Promise<Course>;
  updateCourse(id: number, data: Partial<InsertCourse>): Promise<Course | undefined>;
  deleteCourse(id: number): Promise<void>;

  // Rounds
  getRounds(): Promise<Round[]>;
  getRound(id: number): Promise<Round | undefined>;
  createRound(data: InsertRound): Promise<Round>;
  updateRoundStatus(id: number, status: string): Promise<Round | undefined>;
  updateRoundGame(id: number, gameType: string, gameOptions: string): Promise<Round | undefined>;
  updateRoundHoleHandicaps(id: number, holeHandicaps: number[]): Promise<Round | undefined>;
  updateRoundDate(id: number, date: string): Promise<Round | undefined>;
  deleteRound(id: number): Promise<void>;

  // Players
  getRoundPlayers(roundId: number, positionOnly?: number): Promise<RoundPlayer[]>;
  createRoundPlayer(data: InsertRoundPlayer): Promise<RoundPlayer>;
  updateRoundPlayer(playerId: number, data: { name?: string; courseHandicap?: number; handicapIndex?: number; position?: number }): Promise<RoundPlayer | undefined>;
  removeRoundPlayer(roundId: number, playerId: number): Promise<void>;

  // Scores
  getHoleScores(roundId: number): Promise<HoleScore[]>;
  upsertHoleScore(roundId: number, playerId: number, hole: number, strokes: number | null, putts: number | null): Promise<HoleScore>;
  deletePlayerScores(roundId: number, playerId: number): Promise<void>;

  // Settings
  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;
}

// Map Supabase snake_case rows to camelCase types used by the app
function mapCourse(r: any): Course {
  return {
    id: r.id,
    name: r.name,
    holes: r.holes,
    courseRating: r.course_rating,
    slopeRating: r.slope_rating,
    par: r.par,
    pars: r.pars,
    holeHandicaps: r.hole_handicaps,
  };
}

function mapRound(r: any): Round {
  return {
    id: r.id,
    courseName: r.course_name,
    date: r.date,
    holes: r.holes,
    gameType: r.game_type,
    gameOptions: r.game_options,
    pars: r.pars,
    holeHandicaps: r.hole_handicaps,
    status: r.status,
    courseId: r.course_id ?? null,
    courseRating: r.course_rating ?? null,
    slopeRating: r.slope_rating ?? null,
    par: r.par ?? null,
  };
}

function mapPlayer(r: any): RoundPlayer {
  return {
    id: r.id,
    roundId: r.round_id,
    name: r.name,
    courseHandicap: r.course_handicap,
    position: r.position,
    handicapIndex: r.handicap_index ?? 0,
  };
}

function mapScore(r: any): HoleScore {
  return {
    id: r.id,
    roundId: r.round_id,
    playerId: r.player_id,
    hole: r.hole,
    strokes: r.strokes ?? null,
    putts: r.putts ?? null,
  };
}

export class Storage implements IStorage {
  // ── Courses ──────────────────────────────────────────────────────────────
  async getCourses(): Promise<Course[]> {
    const res = await supabase.from("courses").select("*").order("name");
    return check(res, "getCourses").map(mapCourse);
  }

  async getCourse(id: number): Promise<Course | undefined> {
    const res = await supabase.from("courses").select("*").eq("id", id).single();
    if (res.error) return undefined;
    return mapCourse(res.data);
  }

  async createCourse(data: InsertCourse): Promise<Course> {
    const res = await supabase.from("courses").insert({
      name: data.name,
      holes: data.holes ?? 18,
      course_rating: data.courseRating ?? 72.0,
      slope_rating: data.slopeRating ?? 113,
      par: data.par ?? 72,
      pars: data.pars ?? "[]",
      hole_handicaps: data.holeHandicaps ?? "[]",
    }).select().single();
    return mapCourse(check(res, "createCourse"));
  }

  async updateCourse(id: number, data: Partial<InsertCourse>): Promise<Course | undefined> {
    const update: any = {};
    if (data.name !== undefined) update.name = data.name;
    if (data.holes !== undefined) update.holes = data.holes;
    if (data.courseRating !== undefined) update.course_rating = data.courseRating;
    if (data.slopeRating !== undefined) update.slope_rating = data.slopeRating;
    if (data.par !== undefined) update.par = data.par;
    if (data.pars !== undefined) update.pars = data.pars;
    if (data.holeHandicaps !== undefined) update.hole_handicaps = data.holeHandicaps;
    const res = await supabase.from("courses").update(update).eq("id", id).select().single();
    if (res.error) return undefined;
    return mapCourse(res.data);
  }

  async deleteCourse(id: number): Promise<void> {
    await supabase.from("courses").delete().eq("id", id);
  }

  // ── Rounds ───────────────────────────────────────────────────────────────
  async getRounds(): Promise<Round[]> {
    const res = await supabase.from("rounds").select("*").order("date", { ascending: false });
    return check(res, "getRounds").map(mapRound);
  }

  async getRound(id: number): Promise<Round | undefined> {
    const res = await supabase.from("rounds").select("*").eq("id", id).single();
    if (res.error) return undefined;
    return mapRound(res.data);
  }

  async createRound(data: InsertRound): Promise<Round> {
    const res = await supabase.from("rounds").insert({
      course_name: data.courseName,
      date: data.date,
      holes: data.holes ?? 18,
      game_type: data.gameType,
      game_options: data.gameOptions ?? "{}",
      pars: data.pars,
      hole_handicaps: data.holeHandicaps ?? "[]",
      status: data.status ?? "active",
      course_id: data.courseId ?? null,
      course_rating: data.courseRating ?? null,
      slope_rating: data.slopeRating ?? null,
      par: data.par ?? null,
    }).select().single();
    return mapRound(check(res, "createRound"));
  }

  async updateRoundStatus(id: number, status: string): Promise<Round | undefined> {
    const res = await supabase.from("rounds").update({ status }).eq("id", id).select().single();
    if (res.error) return undefined;
    return mapRound(res.data);
  }

  async updateRoundGame(id: number, gameType: string, gameOptions: string): Promise<Round | undefined> {
    const res = await supabase.from("rounds").update({ game_type: gameType, game_options: gameOptions }).eq("id", id).select().single();
    if (res.error) return undefined;
    return mapRound(res.data);
  }

  async updateRoundHoleHandicaps(id: number, holeHandicaps: number[]): Promise<Round | undefined> {
    const res = await supabase.from("rounds").update({ hole_handicaps: JSON.stringify(holeHandicaps) }).eq("id", id).select().single();
    if (res.error) return undefined;
    return mapRound(res.data);
  }

  async updateRoundDate(id: number, date: string): Promise<Round | undefined> {
    const res = await supabase.from("rounds").update({ date }).eq("id", id).select().single();
    if (res.error) return undefined;
    return mapRound(res.data);
  }

  async deleteRound(id: number): Promise<void> {
    // CASCADE handles hole_scores + round_players
    await supabase.from("rounds").delete().eq("id", id);
  }

  // ── Players ──────────────────────────────────────────────────────────────
  async getRoundPlayers(roundId: number, positionOnly?: number): Promise<RoundPlayer[]> {
    let q = supabase.from("round_players").select("*").eq("round_id", roundId).order("position");
    if (positionOnly !== undefined) q = q.eq("position", positionOnly);
    const res = await q;
    return check(res, "getRoundPlayers").map(mapPlayer);
  }

  async createRoundPlayer(data: InsertRoundPlayer): Promise<RoundPlayer> {
    const res = await supabase.from("round_players").insert({
      round_id: data.roundId,
      name: data.name,
      course_handicap: data.courseHandicap ?? 0,
      position: data.position,
      handicap_index: data.handicapIndex ?? 0,
    }).select().single();
    return mapPlayer(check(res, "createRoundPlayer"));
  }

  async updateRoundPlayer(playerId: number, data: { name?: string; courseHandicap?: number; handicapIndex?: number; position?: number }): Promise<RoundPlayer | undefined> {
    const update: any = {};
    if (data.name !== undefined) update.name = data.name;
    if (data.courseHandicap !== undefined) update.course_handicap = data.courseHandicap;
    if (data.handicapIndex !== undefined) update.handicap_index = data.handicapIndex;
    if (data.position !== undefined) update.position = data.position;
    const res = await supabase.from("round_players").update(update).eq("id", playerId).select().single();
    if (res.error) return undefined;
    return mapPlayer(res.data);
  }

  async removeRoundPlayer(roundId: number, playerId: number): Promise<void> {
    await supabase.from("hole_scores").delete().eq("player_id", playerId);
    await supabase.from("round_players").delete().eq("id", playerId);
  }

  // ── Scores ───────────────────────────────────────────────────────────────
  async getHoleScores(roundId: number): Promise<HoleScore[]> {
    const res = await supabase.from("hole_scores").select("*").eq("round_id", roundId);
    return check(res, "getHoleScores").map(mapScore);
  }

  async deletePlayerScores(roundId: number, playerId: number): Promise<void> {
    await supabase.from("hole_scores").delete().eq("player_id", playerId);
  }

  async upsertHoleScore(roundId: number, playerId: number, hole: number, strokes: number | null, putts: number | null): Promise<HoleScore> {
    // Check for existing score
    const existing = await supabase.from("hole_scores")
      .select("id")
      .eq("round_id", roundId)
      .eq("player_id", playerId)
      .eq("hole", hole)
      .single();

    if (existing.data) {
      const res = await supabase.from("hole_scores")
        .update({ strokes, putts })
        .eq("id", existing.data.id)
        .select().single();
      return mapScore(check(res, "upsertHoleScore update"));
    } else {
      const res = await supabase.from("hole_scores")
        .insert({ round_id: roundId, player_id: playerId, hole, strokes, putts })
        .select().single();
      return mapScore(check(res, "upsertHoleScore insert"));
    }
  }

  // ── Settings ─────────────────────────────────────────────────────────────
  async getSetting(key: string): Promise<string | undefined> {
    const res = await supabase.from("settings").select("value").eq("key", key).maybeSingle();
    if (res.error) return undefined;
    return res.data?.value;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await supabase.from("settings").upsert({ key, value });
  }
}

export const storage = new Storage();
