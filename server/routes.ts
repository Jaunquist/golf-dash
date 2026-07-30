import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { insertRoundSchema, insertRoundPlayerSchema, insertCourseSchema } from "@shared/schema";
import { z } from "zod";

export function registerRoutes(httpServer: Server, app: Express) {
  // ── Courses ────────────────────────────────────────────────────────────
  app.get("/api/courses", async (_req, res) => {
    try { res.json(await storage.getCourses()); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/courses/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const course = await storage.getCourse(id);
      if (!course) return res.status(404).json({ error: "Course not found" });
      res.json(course);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Ghost scores: best score per hole across completed rounds on this course (position-1 player)
  app.get("/api/courses/:id/ghost", async (req, res) => {
    try {
      const courseId = parseInt(req.params.id);
      const allRounds = (await storage.getRounds()).filter(r => r.courseId === courseId && r.status === "complete");
      if (allRounds.length === 0) return res.json({ scores: {}, roundCount: 0 });
      const bestPerHole: Record<number, { strokes: number; roundDate: string }> = {};
      for (const round of allRounds) {
        const players = await storage.getRoundPlayers(round.id);
        const justin = players.find(p => p.position === 1);
        if (!justin) continue;
        const scores = (await storage.getHoleScores(round.id)).filter(s => s.playerId === justin.id && s.strokes != null);
        for (const s of scores) {
          if (!bestPerHole[s.hole] || s.strokes! < bestPerHole[s.hole].strokes) {
            bestPerHole[s.hole] = { strokes: s.strokes!, roundDate: round.date };
          }
        }
      }
      res.json({ scores: bestPerHole, roundCount: allRounds.length });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/courses", async (req, res) => {
    try {
      const data = insertCourseSchema.parse(req.body);
      const course = await storage.createCourse(data);
      res.json(course);
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  app.patch("/api/courses/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const course = await storage.updateCourse(id, req.body);
      if (!course) return res.status(404).json({ error: "Course not found" });
      res.json(course);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.delete("/api/courses/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      await storage.deleteCourse(id);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── Google Sheets Import ───────────────────────────────────────────────
  // POST /api/import/courses — import courses from a Google Sheet (CSV export URL)
  // POST /api/import/scores  — import a round + scores from a Google Sheet (CSV export URL)
  //
  // Both accept { sheetUrl: string } where sheetUrl is the published CSV export URL.
  // Google Sheets CSV URL format:
  //   https://docs.google.com/spreadsheets/d/{ID}/export?format=csv&gid={GID}

  app.post("/api/import/courses", async (req, res) => {
    try {
      const { sheetUrl } = req.body as { sheetUrl: string };
      if (!sheetUrl) return res.status(400).json({ error: "sheetUrl required" });
      try {
        const parsed = new URL(sheetUrl);
        if (parsed.hostname !== "docs.google.com") return res.status(400).json({ error: "sheetUrl must be a docs.google.com URL" });
      } catch { return res.status(400).json({ error: "Invalid sheetUrl" }); }

      // Fetch CSV
      const csvRes = await fetch(sheetUrl);
      if (!csvRes.ok) return res.status(400).json({ error: `Failed to fetch sheet: ${csvRes.statusText}` });
      const csv = await csvRes.text();

      const rows = parseCSV(csv);
      if (rows.length < 2) return res.status(400).json({ error: "Sheet has no data rows" });

      const headers = rows[0].map(h => h.trim().toLowerCase());
      const required = ["name", "holes", "course_rating", "slope_rating", "par", "pars", "hole_handicaps"];
      for (const h of required) {
        if (!headers.includes(h)) return res.status(400).json({ error: `Missing column: ${h}. Required: ${required.join(", ")}` });
      }

      const imported: string[] = [];
      const errors: string[] = [];

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row.every(c => !c.trim())) continue; // skip blank rows
        const get = (col: string) => row[headers.indexOf(col)]?.trim() ?? "";

        try {
          const name = get("name");
          if (!name) { errors.push(`Row ${i + 1}: name is empty`); continue; }

          const parsedPars = parseBracketArray(get("pars"));
          const parsedHcps = parseBracketArray(get("hole_handicaps"));
          const holes = parseInt(get("holes")) || 18;

          if (parsedPars.length !== holes) { errors.push(`Row ${i + 1}: pars array length (${parsedPars.length}) must equal holes (${holes})`); continue; }
          if (parsedHcps.length !== holes) { errors.push(`Row ${i + 1}: hole_handicaps array length (${parsedHcps.length}) must equal holes (${holes})`); continue; }

          // Check if course with same name already exists
          const existing = (await storage.getCourses()).find(c => c.name.toLowerCase() === name.toLowerCase());
          if (existing) {
            await storage.updateCourse(existing.id, {
              name,
              holes,
              courseRating: parseFloat(get("course_rating")) || 72,
              slopeRating: parseInt(get("slope_rating")) || 113,
              par: parseInt(get("par")) || 72,
              pars: JSON.stringify(parsedPars),
              holeHandicaps: JSON.stringify(parsedHcps),
            });
            imported.push(`Updated: ${name}`);
          } else {
            await storage.createCourse({
              name,
              holes,
              courseRating: parseFloat(get("course_rating")) || 72,
              slopeRating: parseInt(get("slope_rating")) || 113,
              par: parseInt(get("par")) || 72,
              pars: JSON.stringify(parsedPars),
              holeHandicaps: JSON.stringify(parsedHcps),
            });
            imported.push(`Created: ${name}`);
          }
        } catch (rowErr: any) {
          errors.push(`Row ${i + 1}: ${rowErr.message}`);
        }
      }

      res.json({ imported, errors, total: imported.length });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/import/scores", async (req, res) => {
    try {
      const { sheetUrl } = req.body as { sheetUrl: string };
      if (!sheetUrl) return res.status(400).json({ error: "sheetUrl required" });
      try {
        const parsed = new URL(sheetUrl);
        if (parsed.hostname !== "docs.google.com") return res.status(400).json({ error: "sheetUrl must be a docs.google.com URL" });
      } catch { return res.status(400).json({ error: "Invalid sheetUrl" }); }

      const csvRes = await fetch(sheetUrl);
      if (!csvRes.ok) return res.status(400).json({ error: `Failed to fetch sheet: ${csvRes.statusText}` });
      const csv = await csvRes.text();

      const rows = parseCSV(csv);
      if (rows.length < 2) return res.status(400).json({ error: "Sheet has no data rows" });

      const headers = rows[0].map(h => h.trim().toLowerCase());
      // Expected columns: course_name, date, player_name, handicap_index, course_handicap, position, hole_1..hole_18 (strokes), putts_1..putts_18
      const requiredBase = ["course_name", "date", "player_name", "course_handicap", "position"];
      for (const h of requiredBase) {
        if (!headers.includes(h)) return res.status(400).json({ error: `Missing column: ${h}` });
      }

      // Group rows by (course_name, date) — each group = one round
      const groups: Map<string, typeof rows> = new Map();
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row.every(c => !c.trim())) continue;
        const get = (col: string) => row[headers.indexOf(col)]?.trim() ?? "";
        const key = `${get("course_name")}|${get("date")}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(row);
      }

      const createdRounds: string[] = [];
      const errors: string[] = [];

      for (const [key, groupRows] of groups.entries()) {
        try {
          const get = (row: string[], col: string) => row[headers.indexOf(col)]?.trim() ?? "";
          const firstRow = groupRows[0];
          const courseName = get(firstRow, "course_name");
          const date = get(firstRow, "date");
          const holesCol = headers.includes("holes") ? parseInt(get(firstRow, "holes")) || 18 : 18;
          const gameType = headers.includes("game_type") ? get(firstRow, "game_type") || "stroke_play" : "stroke_play";

          // Find course for pars/hcps
          const course = (await storage.getCourses()).find(c => c.name.toLowerCase() === courseName.toLowerCase());
          const pars = course ? course.pars : JSON.stringify(Array(holesCol).fill(4));
          const hcps = course ? course.holeHandicaps : JSON.stringify(Array.from({ length: holesCol }, (_, i) => i + 1));

          const round = await storage.createRound({
            courseName,
            date,
            holes: holesCol,
            gameType,
            gameOptions: "{}",
            pars,
            holeHandicaps: hcps,
            status: "complete",
            courseId: course?.id ?? null,
            courseRating: course?.courseRating ?? null,
            slopeRating: course?.slopeRating ?? null,
            par: course?.par ?? null,
          });

          // Create players + scores
          for (const row of groupRows) {
            const playerName = get(row, "player_name");
            const position = parseInt(get(row, "position")) || 1;
            const courseHandicap = parseInt(get(row, "course_handicap")) || 0;
            const handicapIndex = headers.includes("handicap_index") ? parseFloat(get(row, "handicap_index")) || 0 : 0;

            const player = await storage.createRoundPlayer({
              roundId: round.id,
              name: playerName,
              courseHandicap,
              position,
              handicapIndex,
            });

            // hole_1..hole_N = strokes, putts_1..putts_N = putts
            for (let h = 1; h <= holesCol; h++) {
              const strokesStr = get(row, `hole_${h}`);
              const puttsStr = headers.includes(`putts_${h}`) ? get(row, `putts_${h}`) : "";
              const strokes = strokesStr !== "" ? parseInt(strokesStr) : null;
              const putts = puttsStr !== "" ? parseInt(puttsStr) : null;
              if (strokes !== null || putts !== null) {
                await storage.upsertHoleScore(round.id, player.id, h, strokes, putts);
              }
            }
          }
          createdRounds.push(`Round ${date} @ ${courseName} (${groupRows.length} players)`);
        } catch (e: any) {
          errors.push(`${key}: ${e.message}`);
        }
      }

      res.json({ created: createdRounds, errors, total: createdRounds.length });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── Rounds ─────────────────────────────────────────────────────────────

  // ── Export ──────────────────────────────────────────────────────────────────

  // Helper: escape a CSV cell value
  function csvCell(val: string | number | null | undefined): string {
    const s = val == null ? "" : String(val);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }
  function csvRow(cells: (string | number | null | undefined)[]): string {
    return cells.map(csvCell).join(",");
  }

  // GET /api/export/courses — download all courses as CSV (matches import format)
  app.get("/api/export/courses", async (_req, res) => {
    try {
      const courses = await storage.getCourses();
      const lines: string[] = [];
      lines.push(csvRow(["name", "holes", "course_rating", "slope_rating", "par", "pars", "hole_handicaps"]));
      for (const c of courses) {
        lines.push(csvRow([c.name, c.holes, c.courseRating, c.slopeRating, c.par, c.pars, c.holeHandicaps]));
      }
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="golf-dash-courses.csv"');
      res.send(lines.join("\n"));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/export/scores — download all rounds + scores as CSV (matches import format)
  app.get("/api/export/scores", async (_req, res) => {
    try {
      const rounds = await storage.getRounds();
      const maxHoles = 18;
      const holeHeaders = Array.from({ length: maxHoles }, (_, i) => `hole_${i + 1}`);
      const puttsHeaders = Array.from({ length: maxHoles }, (_, i) => `putts_${i + 1}`);
      const lines: string[] = [];
      lines.push(csvRow(["course_name", "date", "holes", "game_type", "player_name", "handicap_index", "course_handicap", "position", ...holeHeaders, ...puttsHeaders]));
      for (const round of rounds) {
        const players = await storage.getRoundPlayers(round.id);
        const scores = await storage.getHoleScores(round.id);
        for (const player of players) {
          const playerScores = scores.filter((s: any) => s.playerId === player.id);
          const holeStrokes = Array.from({ length: maxHoles }, (_, i) => {
            const s = playerScores.find((sc: any) => sc.hole === i + 1);
            return s?.strokes ?? "";
          });
          const holePutts = Array.from({ length: maxHoles }, (_, i) => {
            const s = playerScores.find((sc: any) => sc.hole === i + 1);
            return s?.putts ?? "";
          });
          lines.push(csvRow([
            round.courseName, round.date, round.holes, round.gameType,
            player.name, player.handicapIndex ?? "", player.courseHandicap, player.position,
            ...holeStrokes, ...holePutts,
          ]));
        }
      }
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="golf-dash-scores.csv"');
      res.send(lines.join("\n"));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Optimized endpoint: returns all rounds with ONLY Justin (position=1) player + his scores.
  // Avoids pulling hundreds of players from CSV-imported group rounds.
  app.get("/api/rounds/justin", async (_req, res) => {
    try {
      const rounds = await storage.getRounds();
      const results = await Promise.all(rounds.map(async round => {
        // Only fetch position-1 player (Justin) — DB-filtered, skips bulk import players
        const [justin] = await storage.getRoundPlayers(round.id, 1);
        if (!justin) return null;
        // Only fetch Justin's scores
        const allScores = await storage.getHoleScores(round.id);
        const justinScores = allScores.filter(s => s.playerId === justin.id);
        return { round, players: [justin], scores: justinScores };
      }));
      res.json(results.filter(Boolean));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/rounds", async (_req, res) => {
    try { res.json(await storage.getRounds()); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/rounds/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const round = await storage.getRound(id);
      if (!round) return res.status(404).json({ error: "Round not found" });
      const players = await storage.getRoundPlayers(id);
      const scores = await storage.getHoleScores(id);
      res.json({ round, players, scores });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/rounds", async (req, res) => {
    try {
      const { round: roundData, players } = req.body as {
        round: z.infer<typeof insertRoundSchema>;
        players: Array<{ name: string; handicapIndex?: number; courseHandicap: number; position: number }>;
      };
      console.log("[POST /api/rounds] payload:", JSON.stringify({ round: roundData, players }));
      // Validate required fields early with clear messages
      if (!roundData.courseName || !roundData.courseName.trim()) {
        return res.status(400).json({ error: "Course name is required" });
      }
      if (!roundData.gameType) {
        return res.status(400).json({ error: "Game type is required" });
      }
      if (!players || players.length === 0) {
        return res.status(400).json({ error: "At least one player is required" });
      }
      let enrichedRound = { ...roundData };
      if (roundData.courseId && !roundData.courseRating) {
        try {
          const course = await storage.getCourse(roundData.courseId);
          if (course) {
            enrichedRound.courseRating = course.courseRating;
            enrichedRound.slopeRating = course.slopeRating;
            enrichedRound.par = course.par;
          }
        } catch (lookupErr: any) {
          console.warn("[POST /api/rounds] course lookup failed (non-fatal):", lookupErr.message);
        }
      }
      const round = await storage.createRound(enrichedRound);
      const createdPlayers = await Promise.all(players.map(p =>
        storage.createRoundPlayer({
          roundId: round.id,
          name: p.name,
          handicapIndex: p.handicapIndex ?? null,
          courseHandicap: p.courseHandicap,
          position: p.position,
        })
      ));
      res.json({ round, players: createdPlayers });
    } catch (e: any) {
      console.error("[POST /api/rounds] error:", e.message);
      res.status(400).json({ error: e.message });
    }
  });

  app.patch("/api/rounds/:id/status", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { status } = req.body;
      const round = await storage.updateRoundStatus(id, status);
      if (!round) return res.status(404).json({ error: "Round not found" });
      res.json(round);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.patch("/api/rounds/:id/holeHandicaps", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { holeHandicaps } = req.body as { holeHandicaps: number[] };
      if (!Array.isArray(holeHandicaps)) return res.status(400).json({ error: "holeHandicaps array required" });
      const round = await storage.updateRoundHoleHandicaps(id, holeHandicaps);
      if (!round) return res.status(404).json({ error: "Round not found" });
      res.json(round);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.patch("/api/rounds/:id/date", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { date } = req.body as { date: string };
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
      const round = await storage.updateRoundDate(id, date);
      if (!round) return res.status(404).json({ error: "Round not found" });
      res.json(round);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.patch("/api/rounds/:id/game", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { gameType, gameOptions } = req.body as { gameType: string; gameOptions: string };
      if (!gameType || !gameOptions) return res.status(400).json({ error: "gameType and gameOptions required" });
      const round = await storage.updateRoundGame(id, gameType, gameOptions);
      if (!round) return res.status(404).json({ error: "Round not found" });
      res.json(round);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.delete("/api/rounds/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      await storage.deleteRound(id);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── Round Players ──────────────────────────────────────────────────────
  app.post("/api/rounds/:id/players", async (req, res) => {
    try {
      const roundId = parseInt(req.params.id);
      const { name, courseHandicap, handicapIndex, position } = req.body as {
        name: string; courseHandicap: number; handicapIndex?: number; position: number;
      };
      const player = await storage.createRoundPlayer({ roundId, name, courseHandicap, handicapIndex: handicapIndex ?? null, position });
      res.json(player);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.delete("/api/rounds/:id/players/:playerId", async (req, res) => {
    try {
      const roundId = parseInt(req.params.id);
      const playerId = parseInt(req.params.playerId);
      await storage.removeRoundPlayer(roundId, playerId);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.patch("/api/rounds/:id/players/:playerId", async (req, res) => {
    try {
      const playerId = parseInt(req.params.playerId);
      const { name, courseHandicap, handicapIndex, position } = req.body as {
        name?: string; courseHandicap?: number; handicapIndex?: number; position?: number;
      };
      const player = await storage.updateRoundPlayer(playerId, { name, courseHandicap, handicapIndex, position });
      if (!player) return res.status(404).json({ error: "Player not found" });
      res.json(player);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── Settings ────────────────────────────────────────────────────────────
  app.get("/api/settings/:key", async (req, res) => {
    try {
      const value = await storage.getSetting(req.params.key);
      if (value === undefined) return res.status(404).json({ error: "Not found" });
      res.json({ key: req.params.key, value });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.patch("/api/settings/:key", async (req, res) => {
    try {
      const { value } = req.body as { value: string };
      if (!value) return res.status(400).json({ error: "value required" });
      await storage.setSetting(req.params.key, value);
      res.json({ key: req.params.key, value });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── Scores ─────────────────────────────────────────────────────────────
  app.put("/api/rounds/:id/scores", async (req, res) => {
    try {
      const roundId = parseInt(req.params.id);
      const { playerId, hole, strokes, putts } = req.body as {
        playerId: number;
        hole: number;
        strokes: number | null;
        putts: number | null;
      };
      const score = await storage.upsertHoleScore(roundId, playerId, hole, strokes, putts);
      res.json(score);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── NGAP WHS Sync (async fire-and-poll to avoid proxy timeout) ─────────
  // State stored in memory — persists for the lifetime of the sandbox process
  let ngapSyncState: { status: "idle" | "running" | "done" | "error"; handicapIndex?: number; error?: string; updatedAt?: number } = { status: "idle" };

  async function runNgapSync() {
    const ngapMember = process.env.NGAP_MEMBER_ID;
    const ngapPassword = process.env.NGAP_PASSWORD;
    if (!ngapMember || !ngapPassword) throw new Error("NGAP credentials not configured");

    const LOGIN_URL = "https://www.ngapwhs.com/layouts/terraces_golfnz/Template.aspx?page=NGAP+Login";
    const LOGIN_PAGE = "https://www.ngapwhs.com/ngap-login";
    const MY_OVERVIEW = "https://www.ngapwhs.com/my-overview";
    const HI_API = "https://www.ngapwhs.com/api/Score/GetMemberHandicapIndex";
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    const TIMEOUT = 25000;
    const ctrl = (ms: number) => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };

    // Helper: parse Set-Cookie header(s) into a cookie jar object
    const parseCookies = (raw: string | null): Record<string, string> => {
      if (!raw) return {};
      const jar: Record<string, string> = {};
      raw.split(/\r?\n/).forEach((line) => {
        const part = line.split(";")[0].trim();
        const eq = part.indexOf("=");
        if (eq > 0) jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
      });
      return jar;
    };
    const jarToStr = (jar: Record<string, string>) =>
      Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

    // Step 1: GET login page -> session cookie + ViewState
    const getResp = await fetch(LOGIN_PAGE, {
      headers: { "User-Agent": UA, "Accept": "text/html" },
      redirect: "follow",
      signal: ctrl(TIMEOUT),
    });
    if (!getResp.ok) throw new Error(`Login page GET failed: ${getResp.status}`);
    const html = await getResp.text();
    let jar = parseCookies(getResp.headers.get("set-cookie"));

    const extract = (id: string) => {
      const m = html.match(new RegExp(`id="${id}"\\s+value="([^"]*)"`))
        ?? html.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`));
      return m ? m[1] : "";
    };

    // Step 2: POST login -> 302 to /my-overview (do NOT follow redirect)
    const body = new URLSearchParams({
      __EVENTTARGET: "",
      __EVENTARGUMENT: "",
      __VIEWSTATE: extract("__VIEWSTATE"),
      __VIEWSTATEGENERATOR: extract("__VIEWSTATEGENERATOR"),
      __SCROLLPOSITIONX: "0",
      __SCROLLPOSITIONY: "0",
      __EVENTVALIDATION: extract("__EVENTVALIDATION"),
      "ctl54$tbMembershipNumber": ngapMember,
      "ctl54$tbPassword": ngapPassword,
      "ctl54$btnLogin": "Login",
    });
    const loginResp = await fetch(LOGIN_URL, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": LOGIN_PAGE,
        "Cookie": jarToStr(jar),
        "Accept": "text/html",
      },
      body: body.toString(),
      redirect: "manual",
      signal: ctrl(TIMEOUT),
    });
    Object.assign(jar, parseCookies(loginResp.headers.get("set-cookie")));
    if (loginResp.status !== 302) {
      throw new Error(`Login POST returned ${loginResp.status} (expected 302 — check credentials)`);
    }

    // Step 3: GET /my-overview -> server issues CWApiToken JWT cookie
    const overviewResp = await fetch(MY_OVERVIEW, {
      headers: { "User-Agent": UA, "Cookie": jarToStr(jar), "Accept": "text/html" },
      redirect: "follow",
      signal: ctrl(TIMEOUT),
    });
    if (!overviewResp.ok) throw new Error(`GET /my-overview returned ${overviewResp.status}`);
    // Merge ALL Set-Cookie lines from overview response
    const rawOverviewCookies = overviewResp.headers.get("set-cookie") ?? "";
    // Each Set-Cookie comes as a separate header; node-fetch joins them with \n
    rawOverviewCookies.split(/\r?\n/).forEach((line) => {
      const part = line.split(";")[0].trim();
      const eq = part.indexOf("=");
      if (eq > 0) jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    });
    const overviewHtml = await overviewResp.text();

    // Fallback: try to scrape HI directly from the overview page HTML
    // (in case CWApiToken isn’t set due to redirect or cookie policy changes)
    if (!jar["CWApiToken"]) {
      // NGAP overview page renders HI in patterns like: >27.9< or Handicap Index: 27.9
      const hiMatch = overviewHtml.match(/Handicap\s+Index[^\d]*(\d+\.\d)/i)
        ?? overviewHtml.match(/class="[^"]*handicap[^"]*"[^>]*>\s*([\d.]+)/i)
        ?? overviewHtml.match(/>\s*(\d{1,2}\.\d)\s*<\/(?:span|div|td|p)>/i);
      if (hiMatch) {
        const scraped = parseFloat(hiMatch[1]);
        if (!isNaN(scraped) && scraped > 0 && scraped < 54) {
          await storage.setSetting("handicap_index", String(scraped));
          await storage.setSetting("ngap_last_sync", new Date().toISOString());
          return scraped;
        }
      }
      throw new Error("CWApiToken not set after visiting /my-overview — login may have failed (scraped HTML did not contain HI either)");
    }

    // Step 4: POST /api/Score/GetMemberHandicapIndex with session + CWApiToken cookies
    const apiResp = await fetch(HI_API, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Cookie": jarToStr(jar),
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: "{}",
      signal: ctrl(TIMEOUT),
    });
    if (!apiResp.ok) throw new Error(`GetMemberHandicapIndex API returned ${apiResp.status}`);
    const apiData = await apiResp.json() as { HandicapIndexText?: string; ErrorMessage?: string };
    if (!apiData.HandicapIndexText) throw new Error(`No HandicapIndexText in response: ${JSON.stringify(apiData)}`);
    const hiValue = parseFloat(apiData.HandicapIndexText);
    if (isNaN(hiValue)) throw new Error(`Could not parse HI: ${apiData.HandicapIndexText}`);

    await storage.setSetting("handicap_index", String(hiValue));
    await storage.setSetting("ngap_last_sync", new Date().toISOString());
    return hiValue;
  }

  // GET /api/ngap/debug — runs sync synchronously and returns full result or error for debugging
  app.get("/api/ngap/debug", async (_req, res) => {
    try {
      const hi = await runNgapSync();
      res.json({ ok: true, handicapIndex: hi, message: `Synced successfully: HI = ${hi}` });
    } catch (e: any) {
      console.error("[NGAP DEBUG]", e);
      res.json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // POST /api/ngap/sync — fires immediately, runs in background
  app.post("/api/ngap/sync", (_req, res) => {
    if (ngapSyncState.status === "running") {
      return res.json({ status: "running", message: "Sync already in progress" });
    }
    ngapSyncState = { status: "running" };
    // Respond immediately — client polls /api/ngap/sync/status
    res.json({ status: "running", message: "Sync started — poll /api/ngap/sync/status for result" });
    // Run in background
    runNgapSync()
      .then((hi) => { ngapSyncState = { status: "done", handicapIndex: hi, updatedAt: Date.now() }; })
      .catch((e) => { ngapSyncState = { status: "error", error: e.message, updatedAt: Date.now() }; });
  });

  // GET /api/ngap/sync/status — poll this after triggering sync
  app.get("/api/ngap/sync/status", (_req, res) => {
    res.json(ngapSyncState);
  });
}

// ── CSV helpers ────────────────────────────────────────────────────────────
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { row.push(field); field = ""; }
      else if (ch === '\r' && next === '\n') { row.push(field); rows.push(row); row = []; field = ""; i++; }
      else if (ch === '\n' || ch === '\r') { row.push(field); rows.push(row); row = []; field = ""; }
      else { field += ch; }
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 0 && r.some(c => c.trim()));
}

function parseBracketArray(str: string): number[] {
  // Accepts "[4,5,3,4...]" or "4,5,3,4..." or "4 5 3 4..."
  const cleaned = str.replace(/[\[\]]/g, "").trim();
  if (!cleaned) return [];
  return cleaned.split(/[,\s]+/).map(Number).filter(n => !isNaN(n));
}


