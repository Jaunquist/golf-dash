import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ---- Courses ----
export const courses = sqliteTable("courses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  holes: integer("holes").notNull().default(18),
  courseRating: real("course_rating").notNull().default(72.0),
  slopeRating: integer("slope_rating").notNull().default(113),
  par: integer("par").notNull().default(72),
  pars: text("pars").notNull().default("[]"),             // JSON array of per-hole pars
  holeHandicaps: text("hole_handicaps").notNull().default("[]"), // JSON array of hole HCP rankings
});

export const insertCourseSchema = createInsertSchema(courses).omit({ id: true });
export type InsertCourse = z.infer<typeof insertCourseSchema>;
export type Course = typeof courses.$inferSelect;

// ---- Rounds ----
export const rounds = sqliteTable("rounds", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  courseId: integer("course_id"),                         // nullable FK to courses
  courseName: text("course_name").notNull(),
  courseRating: real("course_rating"),                    // copied from courses at round creation (nullable for legacy rounds)
  slopeRating: integer("slope_rating"),                   // copied from courses at round creation
  date: text("date").notNull(),                           // ISO date string
  holes: integer("holes").notNull().default(18),          // 9 or 18
  par: integer("par"),                                    // total par (sum of hole pars — stored for WHS differential)
  gameType: text("game_type").notNull(),                  // best_ball | best_ball_pairs | high_low | high_low_pairs | niners | twelves | match_play
  gameOptions: text("game_options").notNull().default("{}"), // JSON: { ptsPerHole, secondScoreTiebreaker, etc. }
  pars: text("pars").notNull(),                           // JSON array of par per hole [4,3,4,...]
  holeHandicaps: text("hole_handicaps").notNull().default("[]"), // JSON array of hole handicap rankings
  status: text("status").notNull().default("active"),     // active | complete
});

export const insertRoundSchema = createInsertSchema(rounds).omit({ id: true });
export type InsertRound = z.infer<typeof insertRoundSchema>;
export type Round = typeof rounds.$inferSelect;

// ---- Players in a round ----
export const roundPlayers = sqliteTable("round_players", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  roundId: integer("round_id").notNull(),
  name: text("name").notNull(),
  handicapIndex: real("handicap_index").default(0),       // player's handicap index (stored, not computed)
  courseHandicap: integer("course_handicap").notNull().default(0), // WHS-computed course handicap
  position: integer("position").notNull(),                // 1-4, position 1 = Justin
});

export const insertRoundPlayerSchema = createInsertSchema(roundPlayers).omit({ id: true });
export type InsertRoundPlayer = z.infer<typeof insertRoundPlayerSchema>;
export type RoundPlayer = typeof roundPlayers.$inferSelect;

// ---- Hole scores ----
export const holeScores = sqliteTable("hole_scores", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  roundId: integer("round_id").notNull(),
  playerId: integer("player_id").notNull(),
  hole: integer("hole").notNull(),    // 1-18
  strokes: integer("strokes"),        // gross strokes (null = not entered yet)
  putts: integer("putts"),            // putts for this hole
});

export const insertHoleScoreSchema = createInsertSchema(holeScores).omit({ id: true });
export type InsertHoleScore = z.infer<typeof insertHoleScoreSchema>;
export type HoleScore = typeof holeScores.$inferSelect;

// ---- App settings (key-value) ----
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
export type Setting = typeof settings.$inferSelect;
