import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Flag, Users, Trophy, ChevronRight, ChevronLeft, Shield, User, Plus, BookOpen, Info, Ghost } from "lucide-react";
import type { GameType, ScoringMode } from "@/lib/gameEngine";
import type { Course } from "@shared/schema";

const DEFAULT_PARS_18 = [4,4,3,4,5,4,3,4,4, 4,3,4,5,4,3,4,4,5];
const DEFAULT_PARS_9  = [4,4,3,4,5,4,3,4,4];
const DEFAULT_HCP_18  = [5,9,17,1,13,3,15,7,11, 6,16,2,14,4,18,8,12,10];
const DEFAULT_HCP_9   = [5,9,1,3,7,2,8,4,6];

// WHS Course Handicap formula:
// Course Handicap = round(Handicap Index × (Slope / 113) + (Course Rating − Par))
// The (Rating − Par) term is what makes mixed tees work: a player off an easier
// tee receives fewer strokes automatically, with no separate adjustment.
function computeCourseHandicap(hi: number, slope: number, rating: number, par: number): number {
  return Math.round(hi * (slope / 113) + (rating - par));
}

interface TeeInfo {
  tee: string;
  courseRating: number;
  slopeRating: number;
  par: number;
  yardage: number | null;
}

interface RosterPlayer {
  playerId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  ngapNumber: string;
  handicapIndex: number | null;
  defaultTee: string;
  lastPlayed: string;
}

interface GameDef {
  value: GameType;
  label: string;
  desc: string;
  minPlayers: number;
  maxPlayers: number;
  isTeam: boolean;
  canToggleTeam: boolean;
  teamVariant?: GameType;
  indivVariant?: GameType;
  hasTiebreaker: boolean;
}

const GAME_DEFS: GameDef[] = [
  {
    value: "best_ball",
    label: "Best Ball",
    desc: "Best score per team wins each hole.",
    minPlayers: 2, maxPlayers: 4,
    isTeam: false, canToggleTeam: true,
    teamVariant: "best_ball_pairs",
    indivVariant: "best_ball",
    hasTiebreaker: true,
  },
  {
    value: "high_low",
    label: "High Low",
    desc: "Low score wins the hole.",
    minPlayers: 2, maxPlayers: 4,
    isTeam: false, canToggleTeam: true,
    teamVariant: "high_low_pairs",
    indivVariant: "high_low",
    hasTiebreaker: true,
  },
  {
    value: "match_play_indiv",
    label: "Match Play",
    desc: "Hole-by-hole: lowest score wins each hole. Teams supported.",
    minPlayers: 2, maxPlayers: 4,
    isTeam: false, canToggleTeam: true,
    teamVariant: "match_play",
    indivVariant: "match_play_indiv",
    hasTiebreaker: false,
  },
  {
    value: "niners",
    label: "Niners",
    desc: "3 players, 9 pts/hole: 5-3-1. Ties split.",
    minPlayers: 3, maxPlayers: 3,
    isTeam: false, canToggleTeam: false,
    hasTiebreaker: false,
  },
  {
    value: "twelves",
    label: "Twelves",
    desc: "4 players, 12 pts/hole: 5-3-2-1. Ties split.",
    minPlayers: 4, maxPlayers: 4,
    isTeam: false, canToggleTeam: false,
    hasTiebreaker: false,
  },
];

const PLAYER_COLORS = [
  "bg-emerald-600", "bg-blue-600", "bg-orange-500", "bg-purple-500"
];

type Step = "course" | "players" | "game";

// Solo game type — stored in gameOptions, no game engine scoring
const SOLO_GAME_TYPE: GameType = "high_low"; // stored as high_low but ghost mode flag in gameOptions suppresses scoring UI

// ── New Course Form State ────────────────────────────────────────────────────
interface NewCourseForm {
  name: string;
  holes: 9 | 18;
  courseRating: string;
  slopeRating: string;
  par: string;
  pars: number[];
  holeHandicaps: number[];
}

function defaultNewCourse(holes: 9 | 18): NewCourseForm {
  return {
    name: "",
    holes,
    courseRating: holes === 18 ? "72.0" : "36.0",
    slopeRating: "113",
    par: holes === 18 ? "72" : "36",
    pars: holes === 18 ? [...DEFAULT_PARS_18] : [...DEFAULT_PARS_9],
    holeHandicaps: holes === 18 ? [...DEFAULT_HCP_18] : [...DEFAULT_HCP_9],
  };
}

export default function NewRound() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>("course");

  // ── Courses query ──────────────────────────────────────────────────────
  const { data: savedCourses = [] } = useQuery<Course[]>({
    queryKey: ["/api/courses"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/courses");
      return r.json();
    },
  });

  // ── Course selection state ─────────────────────────────────────────────
  // courseSelectValue: a course ID (string), or "__new__" to show creation form, or "" for no selection
  const [courseSelectValue, setCourseSelectValue] = useState<string>("");
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);

  // New course form (shown when courseSelectValue === "__new__")
  const [newCourseForm, setNewCourseForm] = useState<NewCourseForm>(defaultNewCourse(18));
  const [savingCourse, setSavingCourse] = useState(false);

  // Course details used for the round (either from a saved course or newly created)
  const [courseName, setCourseName] = useState("");
  const [holeCount, setHoleCount] = useState<9 | 18>(18);
  // front = holes 1-9, back = holes 10-18 (only relevant when holeCount===9 and course has 18 holes)
  const [nineType, setNineType] = useState<"front" | "back">("front");
  const [pars, setPars] = useState<number[]>(DEFAULT_PARS_18);
  const [holeHcps, setHoleHcps] = useState<number[]>(DEFAULT_HCP_18);
  // For WHS auto-compute — set when a course with rating/slope is selected
  const [activeCourseRating, setActiveCourseRating] = useState<number | null>(null);
  const [activeSlopeRating, setActiveSlopeRating] = useState<number | null>(null);
  const [activeCoursePar, setActiveCoursePar] = useState<number | null>(null);

  // ── Players step ──────────────────────────────────────────────────────
  // Each player now stores a handicapIndex (raw) and courseHandicap (computed or entered)
  const [players, setPlayers] = useState([
    { name: "Justin", handicapIndex: "", courseHandicap: "", tee: "", playerId: "", position: 1, active: true },
    { name: "",        handicapIndex: "",  courseHandicap: "", tee: "", playerId: "", position: 2, active: false },
    { name: "",        handicapIndex: "",  courseHandicap: "", tee: "", playerId: "", position: 3, active: false },
    { name: "",        handicapIndex: "",  courseHandicap: "", tee: "", playerId: "", position: 4, active: false },
  ]);

  // ── Saved player roster, for the name dropdown ───────────────────────────
  const { data: roster = [] } = useQuery<RosterPlayer[]>({
    queryKey: ["/api/players"],
    queryFn: async () => (await apiRequest("GET", "/api/players")).json(),
  });

  // ── Pre-fill Player 1 HI from stored WHS index ───────────────────────────
  const { data: storedHI } = useQuery<{ value: string }>({
    queryKey: ["/api/settings/handicap_index"],
    queryFn: async () => (await apiRequest("GET", "/api/settings/handicap_index")).json(),
  });
  useEffect(() => {
    if (storedHI?.value) {
      setPlayers(prev => prev.map((p, i) =>
        i === 0 ? { ...p, handicapIndex: storedHI.value } : p
      ));
    }
  }, [storedHI?.value]);

  // ── Ghost round state ────────────────────────────────────────────────────
  const [ghostEnabled, setGhostEnabled] = useState(false);
  const [roundDate, setRoundDate] = useState(() => new Date().toISOString().slice(0, 10));

  // Query ghost data when a course is selected
  const { data: ghostData } = useQuery<{ scores: Record<number, { strokes: number; roundDate: string }>; roundCount: number }>({
    queryKey: ["/api/courses", selectedCourse?.id, "ghost"],
    enabled: !!selectedCourse?.id,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/courses/${selectedCourse!.id}/ghost`);
      return r.json();
    },
  });
  const hasGhostData = (ghostData?.roundCount ?? 0) > 0;

  // ── Game step ────────────────────────────────────────────────────────────
  const [selectedDef, setSelectedDef] = useState<GameDef>(GAME_DEFS[0]);
  const [teamMode, setTeamMode] = useState<"individual" | "team">("individual");
  const [scoringMode, setScoringMode] = useState<ScoringMode>("net_auto");
  const [ptsPerHole, setPtsPerHole] = useState(1);
  const [pairsTiebreaker, setPairsTiebreaker] = useState(false);
  const [secondScoreTiebreaker, setSecondScoreTiebreaker] = useState(false);
  const [team1Indices, setTeam1Indices] = useState<number[]>([0, 1]);
  // teamAssignment[i] = team number (1, 2, 3=Solo) per active player index
  const [teamAssignment, setTeamAssignment] = useState<number[]>([1, 1, 2, 2]);

  const activePlayers = players.filter(p => p.active);
  const isSolo = activePlayers.length === 1;
  const today = new Date().toISOString().slice(0, 10);

  function resolveGameType(): GameType {
    if (selectedDef.canToggleTeam) {
      return teamMode === "team"
        ? (selectedDef.teamVariant ?? selectedDef.value)
        : (selectedDef.indivVariant ?? selectedDef.value);
    }
    return selectedDef.value;
  }

  const actualGameType = resolveGameType();
  const isTeamGame = selectedDef.isTeam || (selectedDef.canToggleTeam && teamMode === "team");
  const showTeamAssign = isTeamGame && activePlayers.length >= 2;
  const showTiebreaker = selectedDef.hasTiebreaker && isTeamGame;
  const showPtsPerHole = actualGameType === "high_low_pairs";
  const playersOkForDef = activePlayers.length >= selectedDef.minPlayers && activePlayers.length <= selectedDef.maxPlayers;
  const gameValid = playersOkForDef;

  const team1Players = activePlayers.filter((_, i) => team1Indices.includes(i));
  const team2Players = activePlayers.filter((_, i) => !team1Indices.includes(i));

  function toggleTeam(activeIdx: number) {
    setTeam1Indices(prev =>
      prev.includes(activeIdx) ? prev.filter(i => i !== activeIdx) : [...prev, activeIdx]
    );
  }

  // ── Tees available for the selected course ───────────────────────────────
  const courseTees: TeeInfo[] = ((selectedCourse as any)?.tees ?? []) as TeeInfo[];
  const hasTees = courseTees.length > 0;

  /** The tee a player is on, falling back to the course default. */
  function teeFor(teeName: string): TeeInfo | null {
    if (!hasTees) return null;
    return courseTees.find(t => t.tee === teeName) ?? courseTees[0];
  }

  // ── WHS Handicap compute, per player's own tee ───────────────────────────
  function getComputedCourseHcpFor(hiStr: string, teeName: string): number | null {
    const hi = parseFloat(hiStr);
    if (isNaN(hi)) return null;
    const t = teeFor(teeName);
    if (t) return computeCourseHandicap(hi, t.slopeRating, t.courseRating, t.par);
    // Manually entered course with no tee list
    if (!activeCourseRating || !activeSlopeRating || !activeCoursePar) return null;
    return computeCourseHandicap(hi, activeSlopeRating, activeCourseRating, activeCoursePar);
  }

  /** Kept for the solo path and anywhere a tee isn't in scope. */
  function getComputedCourseHcp(hiStr: string): number | null {
    return getComputedCourseHcpFor(hiStr, players[0]?.tee ?? "");
  }

  // ── Course selection handler ─────────────────────────────────────────────
  function handleCourseSelect(value: string) {
    setCourseSelectValue(value);
    if (value === "__new__") {
      setSelectedCourse(null);
      setCourseName("");
      setActiveCourseRating(null);
      setActiveSlopeRating(null);
      setActiveCoursePar(null);
      return;
    }
    const course = savedCourses.find(c => String(c.id) === String(value)) ?? null;
    setSelectedCourse(course);
    if (course) {
      setCourseName(course.name);
      const h = (course.holes as 9 | 18);
      setHoleCount(h);
      setNineType("front"); // reset to front 9 whenever course changes
      const coursePars: number[] = JSON.parse(course.pars);
      const courseHcps: number[] = JSON.parse(course.holeHandicaps);
      const fullPars = coursePars.length > 0 ? coursePars : (h === 18 ? DEFAULT_PARS_18 : DEFAULT_PARS_9);
      const fullHcps = courseHcps.length > 0 ? courseHcps : (h === 18 ? DEFAULT_HCP_18 : DEFAULT_HCP_9);
      // For 9-hole rounds on an 18-hole course, default to front 9
      setPars(fullPars.slice(0, h === 9 ? 9 : h));
      setHoleHcps(fullHcps.slice(0, h === 9 ? 9 : h));
      setActiveCourseRating(course.courseRating);
      setActiveSlopeRating(course.slopeRating);
      setActiveCoursePar(course.par);

      // Put each player on their usual tee, or the course default
      const tees: TeeInfo[] = ((course as any).tees ?? []) as TeeInfo[];
      if (tees.length) {
        const names = tees.map(t => t.tee);
        setPlayers(prev => prev.map(p => {
          const saved = roster.find(r => r.fullName === p.name)?.defaultTee;
          const keep = p.tee && names.includes(p.tee) ? p.tee : "";
          return { ...p, tee: keep || (saved && names.includes(saved) ? saved : names[0]) };
        }));
      }
    }
  }

  // ── New course form helpers ──────────────────────────────────────────────
  function updateNewCourseForm(field: keyof NewCourseForm, value: any) {
    setNewCourseForm(prev => ({ ...prev, [field]: value }));
  }

  function handleNewCourseHoleCount(n: 9 | 18) {
    setNewCourseForm(prev => ({
      ...prev,
      holes: n,
      courseRating: n === 18 ? "72.0" : "36.0",
      par: n === 18 ? "72" : "36",
      pars: n === 18 ? [...DEFAULT_PARS_18] : [...DEFAULT_PARS_9],
      holeHandicaps: n === 18 ? [...DEFAULT_HCP_18] : [...DEFAULT_HCP_9],
    }));
  }

  async function handleSaveNewCourse() {
    if (!newCourseForm.name.trim()) return;
    setSavingCourse(true);
    try {
      const payload = {
        name: newCourseForm.name.trim(),
        holes: newCourseForm.holes,
        courseRating: parseFloat(newCourseForm.courseRating) || 72.0,
        slopeRating: parseInt(newCourseForm.slopeRating) || 113,
        par: parseInt(newCourseForm.par) || (newCourseForm.holes === 18 ? 72 : 36),
        pars: JSON.stringify(newCourseForm.pars),
        holeHandicaps: JSON.stringify(newCourseForm.holeHandicaps),
      };
      const r = await apiRequest("POST", "/api/courses", payload);
      const created: Course = await r.json();
      // Invalidate courses cache and auto-select the new course
      await qc.invalidateQueries({ queryKey: ["/api/courses"] });
      // Apply new course details to round
      setCourseName(created.name);
      setHoleCount(created.holes as 9 | 18);
      const cp: number[] = JSON.parse(created.pars);
      const ch: number[] = JSON.parse(created.holeHandicaps);
      setPars(cp.length > 0 ? cp : (created.holes === 18 ? DEFAULT_PARS_18 : DEFAULT_PARS_9));
      setHoleHcps(ch.length > 0 ? ch : (created.holes === 18 ? DEFAULT_HCP_18 : DEFAULT_HCP_9));
      setActiveCourseRating(created.courseRating);
      setActiveSlopeRating(created.slopeRating);
      setActiveCoursePar(created.par);
      setSelectedCourse(created);
      setCourseSelectValue(String(created.id));
      toast({ title: "Course saved", description: created.name });
    } catch {
      toast({ title: "Failed to save course", variant: "destructive" });
    } finally {
      setSavingCourse(false);
    }
  }

  function handleHoleCountChange(n: 9 | 18) {
    setHoleCount(n);
    if (n === 18) {
      setNineType("front");
      setPars(DEFAULT_PARS_18);
      setHoleHcps(DEFAULT_HCP_18);
    } else {
      // Default to front 9 when switching to 9 holes
      setNineType("front");
      setPars(DEFAULT_PARS_9);
      setHoleHcps(DEFAULT_HCP_9);
    }
  }

  // When nineType changes on a selected 18-hole course, use the correct half
  function handleNineTypeChange(t: "front" | "back") {
    setNineType(t);
    // selectedCourse pars/hcps are 18-hole arrays — slice correct half
    if (selectedCourse && selectedCourse.holes === 18) {
      const cp = selectedCourse.pars ? JSON.parse(selectedCourse.pars as string) : DEFAULT_PARS_18;
      const ch = selectedCourse.holeHandicaps ? JSON.parse(selectedCourse.holeHandicaps as string) : DEFAULT_HCP_18;
      setPars(t === "front" ? cp.slice(0, 9) : cp.slice(9, 18));
      setHoleHcps(t === "front" ? ch.slice(0, 9) : ch.slice(9, 18));
    }
  }

  function updatePlayer(idx: number, field: string, value: any) {
    setPlayers(prev => {
      const a = [...prev];
      a[idx] = { ...a[idx], [field]: value };
      return a;
    });
  }

  /**
   * Typing or picking a name: if it matches someone on the roster, pull in
   * their index and usual tee so adding a regular partner is one action.
   */
  function handlePlayerName(idx: number, value: string) {
    const match = roster.find(r => r.fullName.toLowerCase() === value.trim().toLowerCase());
    setPlayers(prev => {
      const a = [...prev];
      const teeNames = courseTees.map(t => t.tee);
      a[idx] = {
        ...a[idx],
        name: value,
        playerId: match?.playerId ?? "",
        handicapIndex: match?.handicapIndex != null
          ? String(match.handicapIndex)
          : a[idx].handicapIndex,
        tee: match?.defaultTee && teeNames.includes(match.defaultTee)
          ? match.defaultTee
          : (a[idx].tee || teeNames[0] || ""),
      };
      return a;
    });
  }

  function canProceedFromCourse() {
    if (courseSelectValue === "__new__") return false; // must save course first
    return courseName.trim().length > 0;
  }
  function canProceedFromPlayers() {
    return activePlayers.length >= 1 && activePlayers[0].name.trim().length > 0;
  }
  // Solo rounds skip game step entirely and start directly
  function canStartSolo() {
    return isSolo && activePlayers[0]?.name.trim().length > 0 && courseName.trim().length > 0;
  }

  const steps: Step[] = ["course", "players", "game"];

  const SCORING_MODE_LABELS: Record<ScoringMode, string> = {
    net_auto:   "Net — by hole HCP",
    net_manual: "Net — manual HCP",
    gross:      "Gross (no handicap)",
  };

  // ── Create round mutation ───────────────────────────────────────────────
  /** One place that decides a player's tee, ratings and course handicap. */
  function buildPlayerPayload(p: typeof players[number], i: number) {
    const hi = parseFloat(p.handicapIndex);
    const t = teeFor(p.tee);
    const chp = getComputedCourseHcpFor(p.handicapIndex, p.tee)
      ?? (p.courseHandicap !== "" ? parseInt(p.courseHandicap) : 0);
    return {
      name: p.name,
      playerId: p.playerId || "",
      tee: t?.tee ?? p.tee ?? "",
      courseRating: t?.courseRating ?? activeCourseRating ?? null,
      slopeRating: t?.slopeRating ?? activeSlopeRating ?? null,
      par: t?.par ?? activeCoursePar ?? null,
      handicapIndex: isNaN(hi) ? null : hi,
      courseHandicap: chp,
      position: i + 1,
    };
  }

  const createMutation = useMutation({
    mutationFn: async (solo: boolean = false) => {
      const gt = solo ? SOLO_GAME_TYPE : resolveGameType();
      let playersPayload;
      if (!solo && isTeamGame) {
        // Assign positions in order (1-based) — engine uses teamAssignment for grouping
        playersPayload = activePlayers.map((p, i) => buildPlayerPayload(p, i));
      } else {
        playersPayload = activePlayers.map((p, i) => buildPlayerPayload(p, i));
      }

      // Build teamAssignment for team games
      const ta = (!solo && isTeamGame)
        ? teamAssignment.slice(0, activePlayers.length)
        : undefined;

      // Embed nineType so Scorecard knows which half of the course is being played
      const nineTypeMeta = holeCount === 9 ? { nineType } : {};
      const gameOptions = solo
        ? { solo: true, ghost: ghostEnabled, scoringMode: "gross", ...nineTypeMeta }
        : { scoringMode, ptsPerHole, pairsTiebreaker, secondScoreTiebreaker, ...(ta ? { teamAssignment: ta } : {}), ...nineTypeMeta };

      const resp = await apiRequest("POST", "/api/rounds", {
        round: {
          courseId: selectedCourse?.id ?? null,
          courseName,
          date: roundDate,
          holes: holeCount,
          gameType: gt,
          gameOptions: JSON.stringify(gameOptions),
          pars: JSON.stringify(pars.slice(0, holeCount)),
          holeHandicaps: JSON.stringify(holeHcps.slice(0, holeCount)),
          status: "active",
        },
        players: playersPayload,
      });
      return resp.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/rounds"] });
      qc.invalidateQueries({ queryKey: ["/api/rounds/justin"] });
      navigate(`/round/${data.round.id}`);
    },
    onError: (err: any) => toast({ title: "Error", description: err?.message ?? "Could not create round.", variant: "destructive" }),
  });

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b border-border">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <button onClick={() => navigate("/")} className="text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft size={20} />
          </button>
          <h1 className="font-display font-bold text-lg flex-1">New Round</h1>
          <div className="flex items-center gap-1">
            {(isSolo ? ["course", "players"] as Step[] : steps).map((s, i, arr) => (
              <div key={s} className="flex items-center gap-1">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-colors
                  ${step === s ? "bg-primary text-primary-foreground" :
                  ((isSolo ? ["course", "players"] as Step[] : steps).indexOf(step) > i ? "bg-primary/30 text-primary" : "bg-muted text-muted-foreground")}`}>
                  {i+1}
                </div>
                {i < arr.length - 1 && <div className="w-4 h-px bg-border" />}
              </div>
            ))}
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-6">

        {/* ─── STEP 1 — Course ─────────────────────────────────────────────── */}
        {step === "course" && (
          <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-200">
            <div className="flex items-center gap-2 text-primary">
              <Flag size={18} />
              <span className="font-semibold">Course Setup</span>
            </div>

            {/* Course dropdown */}
            <div className="space-y-2">
              <Label>Select Course</Label>
              <Select value={courseSelectValue} onValueChange={handleCourseSelect}>
                <SelectTrigger data-testid="select-course" className="w-full">
                  <SelectValue placeholder="Choose a course or add new…" />
                </SelectTrigger>
                <SelectContent>
                  {savedCourses.map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      <div className="flex items-center gap-2">
                        <BookOpen size={13} className="text-muted-foreground" />
                        <span>{c.name}</span>
                        <span className="text-xs text-muted-foreground ml-1">({c.holes}H · CR {c.courseRating} · S {c.slopeRating})</span>
                      </div>
                    </SelectItem>
                  ))}
                  <SelectItem value="__new__">
                    <div className="flex items-center gap-2 text-primary font-medium">
                      <Plus size={13} />
                      <span>Add new course…</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Show saved course info */}
            {selectedCourse && courseSelectValue !== "__new__" && (
              <Card className="border-primary/20 bg-primary/4">
                <CardContent className="pt-4 pb-3">
                  <div className="flex items-start gap-2">
                    <Info size={14} className="text-primary mt-0.5 shrink-0" />
                    <div className="text-sm space-y-0.5">
                      <div className="font-semibold text-primary">{selectedCourse.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {selectedCourse.holes} holes · Par {selectedCourse.par} · Course Rating {selectedCourse.courseRating} · Slope {selectedCourse.slopeRating}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ── New Course Form ────────────────────────────────────────── */}
            {courseSelectValue === "__new__" && (
              <Card className="border-primary/30">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2 text-primary">
                    <Plus size={14} /> New Course
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="nc-name">Course Name</Label>
                    <Input
                      id="nc-name"
                      data-testid="input-new-course-name"
                      placeholder="e.g. Wack Wack Golf & Country Club"
                      value={newCourseForm.name}
                      onChange={e => updateNewCourseForm("name", e.target.value)}
                    />
                  </div>

                  {/* Holes */}
                  <div className="space-y-2">
                    <Label>Number of Holes</Label>
                    <div className="flex gap-2">
                      {([9, 18] as const).map(n => (
                        <button
                          key={n}
                          data-testid={`btn-nc-holes-${n}`}
                          onClick={() => handleNewCourseHoleCount(n)}
                          className={`flex-1 py-2.5 rounded-lg border-2 font-semibold transition-all text-sm
                            ${newCourseForm.holes === n ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"}`}
                        >
                          {n} Holes
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Rating / Slope / Par in a row */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Course Rating</Label>
                      <Input
                        data-testid="input-nc-course-rating"
                        type="number"
                        step="0.1"
                        min={60} max={80}
                        value={newCourseForm.courseRating}
                        onChange={e => updateNewCourseForm("courseRating", e.target.value)}
                        placeholder="72.0"
                        className="tabular"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Slope Rating</Label>
                      <Input
                        data-testid="input-nc-slope-rating"
                        type="number"
                        min={55} max={155}
                        value={newCourseForm.slopeRating}
                        onChange={e => updateNewCourseForm("slopeRating", e.target.value)}
                        placeholder="113"
                        className="tabular"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Total Par</Label>
                      <Input
                        data-testid="input-nc-par"
                        type="number"
                        min={27} max={80}
                        value={newCourseForm.par}
                        onChange={e => updateNewCourseForm("par", e.target.value)}
                        placeholder="72"
                        className="tabular"
                      />
                    </div>
                  </div>

                  <p className="text-[10px] text-muted-foreground bg-muted/40 rounded-lg p-2">
                    Course Handicap = Handicap Index × (Slope / 113) + (Course Rating − Par). These values enable auto-computation for each player.
                  </p>

                  {/* Par per hole */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Par per Hole</Label>
                      <span className="text-xs text-muted-foreground">
                        Total: {newCourseForm.pars.slice(0, newCourseForm.holes).reduce((s,p)=>s+p,0)}
                      </span>
                    </div>
                    <div className="grid grid-cols-9 gap-1.5">
                      {newCourseForm.pars.slice(0, newCourseForm.holes).map((par, i) => (
                        <div key={i} className="flex flex-col items-center gap-1">
                          <span className="text-[10px] text-muted-foreground">{i+1}</span>
                          <Select
                            value={String(par)}
                            onValueChange={v => {
                              const a = [...newCourseForm.pars];
                              a[i] = parseInt(v);
                              updateNewCourseForm("pars", a);
                            }}
                          >
                            <SelectTrigger className="h-8 w-full px-1 text-sm font-semibold text-center tabular" data-testid={`select-nc-par-${i+1}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {[0,1,2,3,4,5,6].map(v => (
                                <SelectItem key={v} value={String(v)}>{v === 0 ? "—" : v}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Hole HCP rankings */}
                  <div className="space-y-3">
                    <Label className="text-xs">Hole Handicap Rankings <span className="text-muted-foreground">(1 = hardest)</span></Label>
                    <div className="grid grid-cols-9 gap-1.5">
                      {newCourseForm.holeHandicaps.slice(0, newCourseForm.holes).map((hcp, i) => (
                        <div key={i} className="flex flex-col items-center gap-1">
                          <span className="text-[10px] text-muted-foreground">{i+1}</span>
                          <Select
                            value={String(hcp)}
                            onValueChange={v => {
                              const a = [...newCourseForm.holeHandicaps];
                              a[i] = parseInt(v);
                              updateNewCourseForm("holeHandicaps", a);
                            }}
                          >
                            <SelectTrigger className="h-8 w-full px-1 text-sm text-center tabular" data-testid={`select-nc-hcp-${i+1}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Array.from({length: newCourseForm.holes}, (_, j) => j+1).map(v => (
                                <SelectItem key={v} value={String(v)}>{v}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                  </div>

                  <Button
                    data-testid="btn-save-new-course"
                    className="w-full gap-2"
                    disabled={!newCourseForm.name.trim() || savingCourse}
                    onClick={handleSaveNewCourse}
                  >
                    {savingCourse ? "Saving…" : <><Plus size={14} /> Save Course & Use for Round</>}
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Manual par / HCP overrides shown when a course IS selected */}
            {selectedCourse && courseSelectValue !== "__new__" && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Number of Holes</Label>
                  <div className="flex gap-2">
                    {([9, 18] as const).map(n => (
                      <button
                        key={n}
                        data-testid={`btn-holes-${n}`}
                        onClick={() => handleHoleCountChange(n)}
                        className={`flex-1 py-2.5 rounded-lg border-2 font-semibold transition-all text-sm
                          ${holeCount === n ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"}`}
                      >
                        {n} Holes
                      </button>
                    ))}
                  </div>
                  {holeCount === 9 && selectedCourse && selectedCourse.holes === 18 && (
                    <div className="flex gap-2 mt-2">
                      {(["front", "back"] as const).map(t => (
                        <button
                          key={t}
                          data-testid={`btn-nine-${t}`}
                          onClick={() => handleNineTypeChange(t)}
                          className={`flex-1 py-2 rounded-lg border-2 font-semibold transition-all text-sm
                            ${nineType === t ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"}`}
                        >
                          {t === "front" ? "Front 9 (1–9)" : "Back 9 (10–18)"}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label>Par per Hole</Label>
                    <span className="text-xs text-muted-foreground">Total: {pars.slice(0,holeCount).reduce((s,p)=>s+p,0)}</span>
                  </div>
                  <div className="grid grid-cols-9 gap-1.5">
                    {pars.slice(0, holeCount).map((par, i) => (
                      <div key={i} className="flex flex-col items-center gap-1">
                        <span className="text-[10px] text-muted-foreground">{i+1+(holeCount===9&&nineType==="back"?9:0)}</span>
                        <Select
                          value={String(par)}
                          onValueChange={v => setPars(prev => { const a=[...prev]; a[i]=parseInt(v); return a; })}
                        >
                          <SelectTrigger className="h-8 w-full px-1 text-sm font-semibold text-center tabular" data-testid={`select-par-${i+1}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {[0,1,2,3,4,5,6].map(v => (
                              <SelectItem key={v} value={String(v)}>{v === 0 ? "—" : v}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-3">
                  <Label>Hole Handicap Rankings <span className="text-xs text-muted-foreground">(1 = hardest)</span></Label>
                  <div className="grid grid-cols-9 gap-1.5">
                    {holeHcps.slice(0, holeCount).map((hcp, i) => (
                      <div key={i} className="flex flex-col items-center gap-1">
                        <span className="text-[10px] text-muted-foreground">{i+1+(holeCount===9&&nineType==="back"?9:0)}</span>
                        <Select
                          value={String(hcp)}
                          onValueChange={v => setHoleHcps(prev => { const a=[...prev]; a[i]=parseInt(v); return a; })}
                        >
                          <SelectTrigger className="h-8 w-full px-1 text-sm text-center tabular" data-testid={`select-hcp-${i+1}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {Array.from({length: holeCount}, (_, j) => j+1).map(v => (
                              <SelectItem key={v} value={String(v)}>{v}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* No course selected yet — show manual entry fallback */}
            {!selectedCourse && courseSelectValue !== "__new__" && courseSelectValue === "" && (
              <div className="space-y-4 border-t border-dashed border-border pt-4">
                <p className="text-xs text-muted-foreground text-center">— or enter course details manually —</p>
                <div className="space-y-2">
                  <Label htmlFor="courseName">Course Name</Label>
                  <Input
                    id="courseName"
                    data-testid="input-course-name"
                    placeholder="e.g. Wack Wack Golf and Country Club"
                    value={courseName}
                    onChange={e => setCourseName(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Number of Holes</Label>
                  <div className="flex gap-2">
                    {([9, 18] as const).map(n => (
                      <button
                        key={n}
                        data-testid={`btn-holes-${n}`}
                        onClick={() => handleHoleCountChange(n)}
                        className={`flex-1 py-2.5 rounded-lg border-2 font-semibold transition-all text-sm
                          ${holeCount === n ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"}`}
                      >
                        {n} Holes
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label>Par per Hole</Label>
                    <span className="text-xs text-muted-foreground">Total: {pars.slice(0,holeCount).reduce((s,p)=>s+p,0)}</span>
                  </div>
                  <div className="grid grid-cols-9 gap-1.5">
                    {pars.slice(0, holeCount).map((par, i) => (
                      <div key={i} className="flex flex-col items-center gap-1">
                        <span className="text-[10px] text-muted-foreground">{i+1+(holeCount===9&&nineType==="back"?9:0)}</span>
                        <Select
                          value={String(par)}
                          onValueChange={v => setPars(prev => { const a=[...prev]; a[i]=parseInt(v); return a; })}
                        >
                          <SelectTrigger className="h-8 w-full px-1 text-sm font-semibold text-center tabular" data-testid={`select-par-${i+1}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {[0,1,2,3,4,5,6].map(v => (
                              <SelectItem key={v} value={String(v)}>{v === 0 ? "—" : v}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-3">
                  <Label>Hole Handicap Rankings <span className="text-xs text-muted-foreground">(1 = hardest)</span></Label>
                  <div className="grid grid-cols-9 gap-1.5">
                    {holeHcps.slice(0, holeCount).map((hcp, i) => (
                      <div key={i} className="flex flex-col items-center gap-1">
                        <span className="text-[10px] text-muted-foreground">{i+1+(holeCount===9&&nineType==="back"?9:0)}</span>
                        <Select
                          value={String(hcp)}
                          onValueChange={v => setHoleHcps(prev => { const a=[...prev]; a[i]=parseInt(v); return a; })}
                        >
                          <SelectTrigger className="h-8 w-full px-1 text-sm text-center tabular" data-testid={`select-hcp-${i+1}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {Array.from({length: holeCount}, (_, j) => j+1).map(v => (
                              <SelectItem key={v} value={String(v)}>{v}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <Button
              data-testid="btn-next-course"
              disabled={!canProceedFromCourse()}
              onClick={() => setStep("players")}
              className="w-full gap-2"
            >
              Next: Players <ChevronRight size={16} />
            </Button>
          </div>
        )}

        {/* ─── STEP 2 — Players ────────────────────────────────────────────── */}
        {step === "players" && (
          <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-200">
            <div className="flex items-center gap-2 text-primary">
              <Users size={18} />
              <span className="font-semibold">Players</span>
            </div>

            {/* WHS info banner — only if course has rating/slope */}
            {activeCourseRating && activeSlopeRating && activeCoursePar ? (
              <div className="flex items-start gap-2 bg-primary/6 border border-primary/20 rounded-lg p-3 text-xs">
                <Info size={13} className="text-primary mt-0.5 shrink-0" />
                <div className="text-muted-foreground">
                  Course HCP auto-computed using WHS formula.
                  Enter each player's <span className="font-semibold text-foreground">Handicap Index</span> and their Course Handicap will be shown below.
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 bg-muted/40 border border-border rounded-lg p-3 text-xs">
                <Info size={13} className="text-muted-foreground mt-0.5 shrink-0" />
                <div className="text-muted-foreground">
                  Enter Course Handicap directly. To enable auto-compute, select a course with Course Rating and Slope.
                </div>
              </div>
            )}

            <datalist id="roster-names">
              {roster.map(r => (
                <option key={r.playerId} value={r.fullName}>
                  {r.handicapIndex != null ? `HI ${r.handicapIndex}` : ""}
                </option>
              ))}
            </datalist>

            {players.map((p, idx) => {
              const computedHcp = getComputedCourseHcpFor(p.handicapIndex, p.tee);
              const hasAutoCompute = computedHcp !== null;
              const playerTee = teeFor(p.tee);
              return (
                <Card key={idx} className={`transition-all ${!p.active && idx > 0 ? "opacity-60" : ""}`}>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center gap-3 mb-3">
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white
                        ${p.active ? PLAYER_COLORS[idx] : "bg-muted text-muted-foreground"}`}>
                        P{p.position}
                      </div>
                      {idx > 0 && (
                        <div className="flex items-center gap-2 ml-auto">
                          <Label htmlFor={`player-active-${idx}`} className="text-sm text-muted-foreground">Include</Label>
                          <Switch
                            id={`player-active-${idx}`}
                            data-testid={`switch-player-${idx+1}`}
                            checked={p.active}
                            onCheckedChange={v => updatePlayer(idx, "active", v)}
                          />
                        </div>
                      )}
                    </div>
                    {(p.active || idx === 0) && (
                      <div className="space-y-3">
                        <div className="flex gap-3">
                          <div className="flex-1 space-y-1">
                            <Label className="text-xs">Name {idx === 0 && <span className="text-muted-foreground">(you)</span>}</Label>
                            <Input
                              data-testid={`input-player-name-${idx+1}`}
                              list={idx === 0 ? undefined : "roster-names"}
                              value={p.name}
                              disabled={idx === 0}
                              onChange={e => handlePlayerName(idx, e.target.value)}
                              placeholder={`Player ${p.position} name`}
                            />
                          </div>
                          {hasTees && (
                            <div className="w-24 space-y-1">
                              <Label className="text-xs">Tee</Label>
                              <select
                                data-testid={`select-player-tee-${idx+1}`}
                                value={p.tee || courseTees[0]?.tee || ""}
                                onChange={e => updatePlayer(idx, "tee", e.target.value)}
                                className="w-full h-10 rounded-md border border-input bg-background px-2 text-sm"
                              >
                                {courseTees.map(t => (
                                  <option key={t.tee} value={t.tee}>{t.tee}</option>
                                ))}
                              </select>
                            </div>
                          )}
                          <div className="w-28 space-y-1">
                            <Label className="text-xs">
                              {hasAutoCompute ? "Handicap Index" : "Course HCP"}
                              <span className="text-muted-foreground"> (opt.)</span>
                            </Label>
                            <Input
                              data-testid={`input-player-hcp-${idx+1}`}
                              type="number"
                              min={0}
                              max={54}
                              step="0.1"
                              value={p.handicapIndex}
                              onChange={e => updatePlayer(idx, "handicapIndex", e.target.value)}
                              placeholder="0"
                              className="tabular"
                            />
                          </div>
                        </div>
                        {/* Auto-computed course HCP */}
                        {hasAutoCompute && p.handicapIndex !== "" && (
                          <div className="flex items-center gap-2 text-xs bg-muted/40 rounded-md px-3 py-1.5">
                            <span className="text-muted-foreground">Course HCP:</span>
                            <span className="font-bold text-primary">{computedHcp}</span>
                            <span className="text-muted-foreground ml-auto text-[10px]">
                              {playerTee
                                ? `${playerTee.tee} · Slope ${playerTee.slopeRating} · CR ${playerTee.courseRating}`
                                : `WHS · Slope ${activeSlopeRating} · CR ${activeCourseRating}`}
                            </span>
                          </div>
                        )}
                        {!hasAutoCompute && (
                          <div className="text-[10px] text-muted-foreground">
                            No course rating/slope available — HCP entered directly.
                          </div>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}

            {/* Ghost toggle — only when solo + course has prior round data */}
            {isSolo && hasGhostData && (
              <div
                onClick={() => setGhostEnabled(v => !v)}
                className={`flex items-center gap-3 rounded-xl border-2 px-4 py-3 cursor-pointer transition-all select-none
                  ${ghostEnabled
                    ? "border-primary bg-primary/8 shadow-sm"
                    : "border-border bg-card hover:border-primary/40"}`}
              >
                <Ghost size={18} className={ghostEnabled ? "text-primary" : "text-muted-foreground"} />
                <div className="flex-1">
                  <div className={`text-sm font-semibold ${ghostEnabled ? "text-primary" : "text-foreground"}`}>
                    Play vs. my ghost
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Compare against your best scores from {selectedCourse?.name ?? courseName}
                    {ghostData?.roundCount ? ` · ${ghostData.roundCount} round${ghostData.roundCount === 1 ? "" : "s"}` : ""}
                  </div>
                </div>
                <div className={`w-9 h-5 rounded-full transition-colors relative ${ghostEnabled ? "bg-primary" : "bg-muted"}`}>
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${ghostEnabled ? "left-[18px]" : "left-0.5"}`} />
                </div>
              </div>
            )}

            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep("course")} className="gap-2">
                <ChevronLeft size={16} /> Back
              </Button>
              {isSolo ? (
                <Button
                  data-testid="btn-start-solo"
                  disabled={!canStartSolo() || createMutation.isPending}
                  onClick={() => createMutation.mutate(true)}
                  className="flex-1 gap-2"
                >
                  <Ghost size={15} />
                  {createMutation.isPending ? "Starting…" : (ghostEnabled ? "Start Ghost Round →" : "Start Solo Round →")}
                </Button>
              ) : (
                <Button
                  data-testid="btn-next-players"
                  disabled={!canProceedFromPlayers()}
                  onClick={() => setStep("game")}
                  className="flex-1 gap-2"
                >
                  Next: Game Type <ChevronRight size={16} />
                </Button>
              )}
            </div>
          </div>
        )}

        {/* ─── STEP 3 — Game Format ─────────────────────────────────────────── */}
        {step === "game" && (
          <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-200">
            <div className="flex items-center gap-2 text-primary">
              <Trophy size={18} />
              <span className="font-semibold">Game Format</span>
            </div>

            {/* Scoring Mode */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Shield size={14} className="text-primary" /> Scoring
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {(["net_auto", "net_manual", "gross"] as ScoringMode[]).map(mode => (
                  <button
                    key={mode}
                    onClick={() => setScoringMode(mode)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg border-2 transition-all text-sm
                      ${scoringMode === mode ? "border-primary bg-primary/8 text-primary" : "border-border hover:border-primary/40"}`}
                    data-testid={`btn-scoring-${mode}`}
                  >
                    <div className="font-semibold">{SCORING_MODE_LABELS[mode]}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      {mode === "net_auto" && "Handicap strokes distributed across holes by HCP rank."}
                      {mode === "net_manual" && "Course handicap applied as-entered, distributed across holes."}
                      {mode === "gross" && "Raw strokes only — no handicap adjustment."}
                    </div>
                  </button>
                ))}
              </CardContent>
            </Card>

            {/* Game Type cards */}
            <div className="space-y-2">
              {GAME_DEFS.map(def => {
                const playersOk = activePlayers.length >= def.minPlayers && activePlayers.length <= def.maxPlayers;
                const isSelected = selectedDef.value === def.value;
                return (
                  <div key={def.value}>
                    <button
                      data-testid={`btn-game-${def.value}`}
                      disabled={!playersOk}
                      onClick={() => {
                        setSelectedDef(def);
                        if (!def.canToggleTeam) setTeamMode("individual");
                      }}
                      className={`w-full text-left p-3.5 rounded-lg border-2 transition-all
                        ${!playersOk ? "opacity-40 cursor-not-allowed border-border" :
                        isSelected ? "border-primary bg-primary/8" : "border-border hover:border-primary/40"}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`font-semibold text-sm ${isSelected ? "text-primary" : ""}`}>{def.label}</span>
                        {def.isTeam && <Badge variant="outline" className="text-[10px] py-0 px-1.5">Teams</Badge>}
                        {def.canToggleTeam && <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-muted-foreground/40">Indiv / Team</Badge>}
                        <span className="text-xs text-muted-foreground ml-auto">
                          {def.minPlayers === def.maxPlayers ? `${def.minPlayers}P` : `${def.minPlayers}–${def.maxPlayers}P`}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{def.desc}</p>
                    </button>

                    {isSelected && def.canToggleTeam && playersOk && (
                      <div className="mt-1.5 ml-2 flex gap-2">
                        <button
                          onClick={() => setTeamMode("individual")}
                          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border-2 text-xs font-semibold transition-all
                            ${teamMode === "individual" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"}`}
                          data-testid="btn-mode-individual"
                        >
                          <User size={13} /> Individual
                        </button>
                        <button
                          onClick={() => setTeamMode("team")}
                          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border-2 text-xs font-semibold transition-all
                            ${teamMode === "team" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"}`}
                          data-testid="btn-mode-team"
                        >
                          <Users size={13} /> Per Team
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Team assignment */}
            {showTeamAssign && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Shield size={14} className="text-primary" />
                    Assign Teams
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">Tap a player to move them between teams.</p>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-2">
                    {activePlayers.map((p, i) => {
                      const globalIdx = players.findIndex(pl => pl.name === p.name);
                      const curTeam = teamAssignment[i] ?? (i < 2 ? 1 : 2);
                      const teamColors = [
                        { t: 1, label: "T1", active: "border-emerald-400 bg-emerald-100/60 text-emerald-700" },
                        { t: 2, label: "T2", active: "border-blue-400 bg-blue-100/60 text-blue-700" },
                        { t: 3, label: "Solo", active: "border-orange-400 bg-orange-100/60 text-orange-700" },
                      ];
                      return (
                        <div key={p.name} className="flex items-center gap-2">
                          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white ${PLAYER_COLORS[globalIdx] ?? "bg-muted"}`}>
                            {p.name[0]}
                          </div>
                          <span className="text-xs font-medium flex-1 truncate">{p.name}</span>
                          <div className="flex gap-1">
                            {teamColors.map(({ t, label, active }) => (
                              <button
                                key={t}
                                type="button"
                                onClick={() => {
                                  const next = [...teamAssignment];
                                  next[i] = t;
                                  setTeamAssignment(next);
                                }}
                                className={`px-2 py-0.5 rounded-full text-[10px] font-bold border transition-all
                                  ${ curTeam === t ? active : "border-border text-muted-foreground/50 hover:border-primary/30" }`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-muted-foreground">T1 and T2 play as teams. Solo = plays individually.</p>
                </CardContent>
              </Card>
            )}

            {/* Tiebreaker */}
            {showTiebreaker && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Tiebreaker</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-sm">2nd score as tiebreaker</Label>
                      <p className="text-[11px] text-muted-foreground mt-0.5">Use the pair's 2nd ball to break tied holes.</p>
                    </div>
                    <Switch
                      checked={actualGameType === "high_low_pairs" ? secondScoreTiebreaker : pairsTiebreaker}
                      onCheckedChange={v => {
                        if (actualGameType === "high_low_pairs") setSecondScoreTiebreaker(v);
                        else setPairsTiebreaker(v);
                      }}
                      data-testid="switch-tiebreaker"
                    />
                  </div>
                  {showPtsPerHole && (
                    <div className="flex items-center justify-between">
                      <Label className="text-sm">Points per hole</Label>
                      <div className="flex gap-2">
                        {[1, 2].map(n => (
                          <button key={n} onClick={() => setPtsPerHole(n)}
                            className={`w-8 h-8 rounded-md text-sm font-semibold border-2 transition-colors
                              ${ptsPerHole === n ? "border-primary bg-primary/10 text-primary" : "border-border"}`}>
                            {n}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Round date */}
            <div className="flex items-center gap-3">
              <label className="text-xs font-medium text-muted-foreground whitespace-nowrap">Round Date</label>
              <input
                type="date"
                value={roundDate}
                onChange={e => setRoundDate(e.target.value)}
                className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            {/* Player count warning */}
            {!gameValid && (
              <p className="text-sm text-destructive text-center">
                {selectedDef.label} requires {selectedDef.minPlayers === selectedDef.maxPlayers ? `exactly ${selectedDef.minPlayers}` : `${selectedDef.minPlayers}–${selectedDef.maxPlayers}`} players. You have {activePlayers.length}.
              </p>
            )}

            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep("players")} className="gap-2">
                <ChevronLeft size={16} /> Back
              </Button>
              <Button
                data-testid="btn-start-round"
                disabled={!gameValid || createMutation.isPending}
                onClick={() => createMutation.mutate(false)}
                className="flex-1 gap-2"
              >
                {createMutation.isPending ? "Starting…" : "Start Round →"}
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}