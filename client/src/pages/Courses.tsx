import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, isAdmin } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft, Plus, Pencil, Trash2, Save, X, Flag, ChevronDown, ChevronUp,
  FileSpreadsheet, Upload, Search, Copy, Loader2, AlertCircle,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import CountryFlag from "@/components/CountryFlag";
import { COUNTRIES, countryName, normalizeCountry } from "@/lib/countries";
import type { Course, Round } from "@shared/schema";

const DEFAULT_PARS_18 = [4,4,3,4,5,4,3,4,4, 4,3,4,5,4,3,4,4,5];
const DEFAULT_PARS_9  = [4,4,3,4,5,4,3,4,4];
const DEFAULT_HCP_18  = [5,9,17,1,13,3,15,7,11, 6,16,2,14,4,18,8,12,10];
const DEFAULT_HCP_9   = [5,9,1,3,7,2,8,4,6];

interface TeeFormState {
  tee: string;
  courseRating: string;
  slopeRating: string;
  par: string;
  yardage: string;
}

interface CourseFormState {
  name: string;
  country: string;
  holes: 9 | 18;
  tees: TeeFormState[];
  pars: number[];
  holeHandicaps: number[];
}

// Common Philippine tee colours, hardest first
const TEE_NAMES = ["Black", "Gold", "Blue", "White", "Silver", "Red"];

function blankTee(name: string, holes: 9 | 18): TeeFormState {
  return {
    tee: name,
    courseRating: holes === 18 ? "72.0" : "36.0",
    slopeRating: "113",
    par: holes === 18 ? "72" : "36",
    yardage: "",
  };
}

function defaultForm(holes: 9 | 18 = 18): CourseFormState {
  return {
    name: "",
    country: "PH",          // the common case; changed in one tap when abroad
    holes,
    tees: [blankTee("Blue", holes)],
    pars: holes === 18 ? [...DEFAULT_PARS_18] : [...DEFAULT_PARS_9],
    holeHandicaps: holes === 18 ? [...DEFAULT_HCP_18] : [...DEFAULT_HCP_9],
  };
}

function courseToForm(c: any): CourseFormState {
  const holes = (c.holes as 9 | 18) ?? 18;
  const tees: TeeFormState[] = (c.tees ?? []).length
    ? c.tees.map((t: any) => ({
        tee: String(t.tee),
        courseRating: String(t.courseRating),
        slopeRating: String(t.slopeRating),
        par: String(t.par),
        yardage: t.yardage == null ? "" : String(t.yardage),
      }))
    : [blankTee("Blue", holes)];
  return {
    name: c.name,
    country: normalizeCountry(c.country),
    holes,
    tees,
    pars: JSON.parse(c.pars),
    holeHandicaps: JSON.parse(c.holeHandicaps),
  };
}

/** Shape the mutations send. Kept in one place so create and update agree. */
function formToPayload(form: CourseFormState) {
  return {
    name: form.name.trim(),
    country: form.country,
    holes: form.holes,
    tees: form.tees.map(t => ({
      tee: t.tee.trim(),
      courseRating: parseFloat(t.courseRating) || 72.0,
      slopeRating: parseInt(t.slopeRating) || 113,
      par: parseInt(t.par) || (form.holes === 18 ? 72 : 36),
      yardage: t.yardage === "" ? null : parseInt(t.yardage),
    })),
    pars: JSON.stringify(form.pars.slice(0, form.holes)),
    holeHandicaps: JSON.stringify(form.holeHandicaps.slice(0, form.holes)),
  };
}

function CourseForm({
  form,
  onChange,
  onSave,
  onSaveAsNew,
  onCancel,
  isSaving,
  isNew,
  originalName,
}: {
  form: CourseFormState;
  onChange: (f: CourseFormState) => void;
  onSave: () => void;
  onSaveAsNew?: () => void;
  onCancel: () => void;
  isSaving: boolean;
  isNew?: boolean;
  originalName?: string;
}) {
  const [showHoleDetail, setShowHoleDetail] = useState(false);

  function setField(field: keyof CourseFormState, value: any) {
    onChange({ ...form, [field]: value });
  }

  function changeHoles(n: 9 | 18) {
    onChange({
      ...form,
      holes: n,
      tees: form.tees.map(t => ({
        ...t,
        courseRating: n === 18 ? "72.0" : "36.0",
        par: n === 18 ? "72" : "36",
      })),
      pars: n === 18 ? [...DEFAULT_PARS_18] : [...DEFAULT_PARS_9],
      holeHandicaps: n === 18 ? [...DEFAULT_HCP_18] : [...DEFAULT_HCP_9],
    });
  }

  function updatePar(holeIdx: number, val: string) {
    const newPars = [...form.pars];
    newPars[holeIdx] = parseInt(val) || 4;
    onChange({ ...form, pars: newPars });
  }

  function updateHcp(holeIdx: number, val: string) {
    const newHcps = [...form.holeHandicaps];
    newHcps[holeIdx] = parseInt(val) || 1;
    onChange({ ...form, holeHandicaps: newHcps });
  }

  const canSave = form.name.trim().length > 0
    && form.tees.length > 0
    && form.tees.every(t =>
         t.tee.trim().length > 0
         && parseFloat(t.courseRating) > 0
         && parseInt(t.slopeRating) >= 55
         && parseInt(t.slopeRating) <= 155);

  // Saving a copy under the same name would just collide server-side, so the
  // button stays disabled until the name actually differs
  const nameChanged = !!originalName && form.name.trim() !== originalName.trim();

  function updateTee(i: number, field: keyof TeeFormState, value: string) {
    const next = [...form.tees];
    next[i] = { ...next[i], [field]: value };
    onChange({ ...form, tees: next });
  }

  function addTee() {
    const used = form.tees.map(t => t.tee);
    const nextName = TEE_NAMES.find(n => !used.includes(n)) ?? "";
    onChange({ ...form, tees: [...form.tees, blankTee(nextName, form.holes)] });
  }

  function removeTee(i: number) {
    if (form.tees.length <= 1) return;
    onChange({ ...form, tees: form.tees.filter((_, j) => j !== i) });
  }

  return (
    <div className="space-y-4">
      {/* Course name + country */}
      <div className="grid grid-cols-[1fr_120px] gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Course Name</Label>
          <Input
            data-testid="input-course-name"
            value={form.name}
            onChange={e => setField("name", e.target.value)}
            placeholder="e.g. Hallow Ridge Filipinas Golf"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Country</Label>
          <div className="flex items-center gap-1.5">
            <CountryFlag code={form.country} size={16} />
            <select
              value={form.country}
              onChange={e => setField("country", e.target.value)}
              data-testid="select-course-country"
              className="flex-1 h-10 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">—</option>
              {COUNTRIES.map(c => (
                <option key={c.code} value={c.code}>{c.code}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
      {form.country && (
        <p className="text-[10px] text-muted-foreground -mt-2">
          {countryName(form.country)}
        </p>
      )}

      {/* Holes toggle */}
      <div className="space-y-1">
        <Label className="text-xs">Holes</Label>
        <div className="flex gap-2">
          {([9, 18] as const).map(n => (
            <button
              key={n}
              type="button"
              onClick={() => changeHoles(n)}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold border-2 transition-all
                ${form.holes === n
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40"}`}
            >
              {n} holes
            </button>
          ))}
        </div>
      </div>

      {/* Tees — one row per set of markers */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Tees</Label>
          <button
            type="button"
            onClick={addTee}
            className="text-xs font-semibold text-primary hover:underline"
          >
            + Add tee
          </button>
        </div>

        <div className="grid grid-cols-[1fr_70px_60px_55px_28px] gap-2 px-1">
          <span className="text-[10px] text-muted-foreground">Tee</span>
          <span className="text-[10px] text-muted-foreground">Rating</span>
          <span className="text-[10px] text-muted-foreground">Slope</span>
          <span className="text-[10px] text-muted-foreground">Par</span>
          <span />
        </div>

        {form.tees.map((t, i) => (
          <div key={i} className="grid grid-cols-[1fr_70px_60px_55px_28px] gap-2 items-center">
            <Input
              list="tee-names"
              value={t.tee}
              onChange={e => updateTee(i, "tee", e.target.value)}
              placeholder="Blue"
              className="h-9"
            />
            <Input
              type="number" step="0.1" min={50} max={80}
              value={t.courseRating}
              onChange={e => updateTee(i, "courseRating", e.target.value)}
              className="h-9 tabular"
            />
            <Input
              type="number" min={55} max={155}
              value={t.slopeRating}
              onChange={e => updateTee(i, "slopeRating", e.target.value)}
              className="h-9 tabular"
            />
            <Input
              type="number" min={27} max={73}
              value={t.par}
              onChange={e => updateTee(i, "par", e.target.value)}
              className="h-9 tabular"
            />
            <button
              type="button"
              onClick={() => removeTee(i)}
              disabled={form.tees.length <= 1}
              className="text-muted-foreground hover:text-destructive disabled:opacity-30 flex justify-center"
              title="Remove tee"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}

        <datalist id="tee-names">
          {TEE_NAMES.map(n => <option key={n} value={n} />)}
        </datalist>

        <p className="text-[10px] text-muted-foreground">
          Course rating and slope come from the scorecard and differ per tee.
          Pars and stroke index below are shared across all tees.
          A tee you remove here is deleted when you save.
        </p>
      </div>

      {/* Per-hole pars / HCPs — collapsible */}
      <div>
        <button
          type="button"
          onClick={() => setShowHoleDetail(v => !v)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {showHoleDetail ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {showHoleDetail ? "Hide" : "Edit"} per-hole pars &amp; handicaps
        </button>

        {showHoleDetail && (
          <div className="mt-3 rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-xs min-w-[420px]">
              <thead>
                <tr className="bg-muted/40 border-b border-border">
                  <th className="px-2 py-2 text-left font-semibold text-muted-foreground w-16">Hole</th>
                  {Array.from({ length: form.holes }, (_, i) => (
                    <th key={i} className="px-1 py-2 text-center font-semibold w-10">{i + 1}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border/60">
                  <td className="px-2 py-1.5 font-medium text-muted-foreground">Par</td>
                  {Array.from({ length: form.holes }, (_, i) => (
                    <td key={i} className="px-1 py-1 text-center">
                      <select
                        value={form.pars[i] ?? 4}
                        onChange={e => updatePar(i, e.target.value)}
                        className="w-9 text-center text-xs rounded border border-border bg-background py-0.5 cursor-pointer"
                      >
                        {[3,4,5,6].map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="px-2 py-1.5 font-medium text-muted-foreground">HCP</td>
                  {Array.from({ length: form.holes }, (_, i) => (
                    <td key={i} className="px-1 py-1 text-center">
                      <select
                        value={form.holeHandicaps[i] ?? (i + 1)}
                        onChange={e => updateHcp(i, e.target.value)}
                        className="w-9 text-center text-xs rounded border border-border bg-background py-0.5 cursor-pointer"
                      >
                        {Array.from({ length: form.holes }, (_, j) => (
                          <option key={j + 1} value={j + 1}>{j + 1}</option>
                        ))}
                      </select>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="space-y-2 pt-1">
        <div className="flex gap-3">
          <Button variant="outline" onClick={onCancel} className="gap-1.5" size="sm">
            <X size={13} /> Cancel
          </Button>
          <Button
            data-testid="btn-save-course"
            disabled={!canSave || isSaving}
            onClick={onSave}
            className="flex-1 gap-1.5"
            size="sm"
          >
            <Save size={13} />
            {isSaving ? "Saving…" : (isNew ? "Add Course" : "Save Changes")}
          </Button>
        </div>

        {/* Copying rather than editing — the way to fork a layout without
            touching the original or the rounds played on it */}
        {onSaveAsNew && (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={!canSave || isSaving || !nameChanged}
              onClick={onSaveAsNew}
              className="w-full gap-1.5"
              data-testid="btn-save-as-new-course"
            >
              <Copy size={13} /> Save as new course
            </Button>
            {!nameChanged && (
              <p className="text-[10px] text-muted-foreground text-center">
                Change the name first to save this as a separate course.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Sorting ────────────────────────────────────────────────────────────────

type SortKey = "name" | "country" | "played" | "recent";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "name",    label: "A–Z" },
  { key: "country", label: "Country" },
  { key: "played",  label: "Most played" },
  { key: "recent",  label: "Recent" },
];

export default function Courses() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const admin = isAdmin();

  const [addingNew, setAddingNew] = useState(false);
  const [newForm, setNewForm] = useState<CourseFormState>(defaultForm());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<CourseFormState>(defaultForm());
  const [deleteTarget, setDeleteTarget] = useState<Course | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importType, setImportType] = useState<"courses" | "scores">("courses");
  const [importUrl, setImportUrl] = useState("");

  // Filter + sort
  const [search, setSearch] = useState("");
  const [countryFilter, setCountryFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");

  const importMutation = useMutation({
    mutationFn: async ({ url, type }: { url: string; type: "courses" | "scores" }) => {
      const r = await apiRequest("POST", `/api/import/${type}`, { sheetUrl: url });
      return r.json();
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["/api/courses"] });
      qc.invalidateQueries({ queryKey: ["/api/rounds"] });
      const lines = [
        ...(data.imported ?? data.created ?? []),
        ...(data.errors ?? []).map((e: string) => `⚠️ ${e}`),
      ];
      toast({
        title: `Import complete — ${data.total ?? 0} item(s)`,
        description: lines.slice(0, 5).join("\n") + (lines.length > 5 ? `\n+${lines.length - 5} more` : ""),
        duration: 6000,
      });
      setImportOpen(false);
      setImportUrl("");
    },
    onError: (e: any) => toast({ title: "Import failed", description: e.message, variant: "destructive" }),
  });

  const {
    data: courses = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<Course[]>({
    queryKey: ["/api/courses"],
    retry: 1,     // the first call after a while wakes Apps Script up
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/courses");
      return r.json();
    },
  });

  // Only needed for the play-count sorts, so a failure here must not break
  // the page — it just falls back to an alphabetical list
  const { data: rounds = [] } = useQuery<Round[]>({
    queryKey: ["/api/rounds"],
    queryFn: async () => (await apiRequest("GET", "/api/rounds")).json(),
  });

  const playStats = useMemo(() => {
    const m: Record<string, { count: number; last: string }> = {};
    rounds.forEach(r => {
      const k = String(r.courseName || "");
      if (!k) return;
      if (!m[k]) m[k] = { count: 0, last: "" };
      m[k].count++;
      if (String(r.date) > m[k].last) m[k].last = String(r.date);
    });
    return m;
  }, [rounds]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = courses.filter(c => {
      const cc = normalizeCountry((c as any).country);
      if (countryFilter && cc !== countryFilter) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q)
        || cc.toLowerCase().includes(q)
        || countryName(cc).toLowerCase().includes(q);
    });

    const stat = (c: Course) => playStats[c.name] ?? { count: 0, last: "" };

    return [...list].sort((a, b) => {
      if (sortKey === "country") {
        const ca = normalizeCountry((a as any).country) || "ZZ";
        const cb = normalizeCountry((b as any).country) || "ZZ";
        if (ca !== cb) return ca.localeCompare(cb);
        return a.name.localeCompare(b.name);
      }
      if (sortKey === "played") {
        const d = stat(b).count - stat(a).count;
        return d !== 0 ? d : a.name.localeCompare(b.name);
      }
      if (sortKey === "recent") {
        const d = stat(b).last.localeCompare(stat(a).last);
        return d !== 0 ? d : a.name.localeCompare(b.name);
      }
      return a.name.localeCompare(b.name);
    });
  }, [courses, search, countryFilter, sortKey, playStats]);

  // Countries actually in use, so the filter never offers an empty result
  const usedCountries = useMemo(() => {
    const set = new Set<string>();
    courses.forEach(c => {
      const cc = normalizeCountry((c as any).country);
      if (cc) set.add(cc);
    });
    return [...set].sort();
  }, [courses]);

  const createMutation = useMutation({
    mutationFn: async (form: CourseFormState) => {
      const r = await apiRequest("POST", "/api/courses", formToPayload(form));
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/courses"] });
      setAddingNew(false);
      setEditingId(null);
      setNewForm(defaultForm());
      toast({ title: "Course added" });
    },
    onError: (e: any) =>
      toast({ title: "Failed to add course", description: e?.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, form }: { id: string; form: CourseFormState }) => {
      const r = await apiRequest("PATCH", `/api/courses/${id}`, formToPayload(form));
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/courses"] });
      qc.invalidateQueries({ queryKey: ["/api/rounds"] });   // a rename moves history
      setEditingId(null);
      toast({ title: "Course updated" });
    },
    onError: (e: any) =>
      toast({ title: "Failed to update course", description: e?.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const r = await apiRequest("DELETE", `/api/courses/${id}`);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/courses"] });
      setDeleteTarget(null);
      toast({ title: "Course deleted" });
    },
    onError: (e: any) =>
      toast({ title: "Failed to delete course", description: e?.message, variant: "destructive" }),
  });

  function startEdit(course: Course) {
    setEditingId(String(course.id));
    setEditForm(courseToForm(course));
    setAddingNew(false);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  const filtering = !!search.trim() || !!countryFilter;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b border-border">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-2">
          <button
            onClick={() => navigate("/")}
            className="text-muted-foreground hover:text-foreground transition-colors"
            data-testid="btn-back-courses"
          >
            <ArrowLeft size={20} />
          </button>
          <h1 className="font-display font-bold text-lg flex-1">Courses</h1>
          {admin && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setImportOpen(true)}
              className="gap-1.5"
              data-testid="btn-import-sheet"
            >
              <FileSpreadsheet size={14} /> Import
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => { setAddingNew(true); setEditingId(null); setNewForm(defaultForm()); }}
            className="gap-1.5"
            data-testid="btn-add-course"
            disabled={addingNew}
          >
            <Plus size={14} /> Add Course
          </Button>
        </div>

        {/* Filter + sort bar */}
        {courses.length > 3 && (
          <div className="max-w-2xl mx-auto px-4 pb-2.5 space-y-2">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search size={13}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
                <Input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search course or country…"
                  className="h-9 pl-8 text-sm"
                  data-testid="input-course-search"
                />
              </div>
              {usedCountries.length > 1 && (
                <select
                  value={countryFilter}
                  onChange={e => setCountryFilter(e.target.value)}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                  data-testid="select-country-filter"
                >
                  <option value="">All</option>
                  {usedCountries.map(cc => (
                    <option key={cc} value={cc}>{cc}</option>
                  ))}
                </select>
              )}
            </div>

            <div className="flex items-center gap-1.5 overflow-x-auto">
              <span className="text-[10px] text-muted-foreground shrink-0">Sort</span>
              {SORTS.map(s => (
                <button
                  key={s.key}
                  onClick={() => setSortKey(s.key)}
                  className={`text-[11px] px-2 py-0.5 rounded-full border shrink-0 transition-colors ${
                    sortKey === s.key
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {s.label}
                </button>
              ))}
              {filtering && (
                <button
                  onClick={() => { setSearch(""); setCountryFilter(""); }}
                  className="text-[11px] text-muted-foreground underline underline-offset-2 ml-auto shrink-0"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        )}
      </header>

      {/* Google Sheets Import Dialog */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet size={18} className="text-primary" /> Import from Google Sheets
            </DialogTitle>
            <DialogDescription>
              Paste the published CSV export URL from your Google Sheet.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="flex gap-2">
              <Button size="sm" variant={importType === "courses" ? "default" : "outline"} onClick={() => setImportType("courses")} className="flex-1">Courses</Button>
              <Button size="sm" variant={importType === "scores" ? "default" : "outline"} onClick={() => setImportType("scores")} className="flex-1">Scores / Rounds</Button>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Google Sheet CSV URL</Label>
              <Input
                placeholder="https://docs.google.com/spreadsheets/d/.../export?format=csv"
                value={importUrl}
                onChange={e => setImportUrl(e.target.value)}
                className="text-xs font-mono"
                data-testid="input-import-url"
              />
              <p className="text-xs text-muted-foreground">In Google Sheets: File → Share → Publish to web → CSV → Copy link</p>
            </div>
            {importType === "courses" && (
              <div className="rounded-lg bg-muted/50 p-3 text-xs space-y-1">
                <p className="font-semibold text-foreground">Required columns:</p>
                <p className="font-mono text-muted-foreground">name, holes, course_rating, slope_rating, par, pars, hole_handicaps</p>
                <p className="font-semibold text-foreground mt-2">pars / hole_handicaps format:</p>
                <p className="font-mono text-muted-foreground">[4,5,3,4,4,3,4,4,5,5,3,4,5,3,4,3,5,4]</p>
                <p className="text-muted-foreground mt-1">Existing courses with same name will be updated.</p>
              </div>
            )}
            {importType === "scores" && (
              <div className="rounded-lg bg-muted/50 p-3 text-xs space-y-1">
                <p className="font-semibold text-foreground">Required columns:</p>
                <p className="font-mono text-muted-foreground">course_name, date, player_name, course_handicap, position</p>
                <p className="font-semibold text-foreground mt-2">Optional columns:</p>
                <p className="font-mono text-muted-foreground">handicap_index, holes, game_type, hole_1…hole_18, putts_1…putts_18</p>
                <p className="text-muted-foreground mt-1">One row per player. Rows sharing course_name + date = one round.</p>
              </div>
            )}
            <Button
              className="w-full gap-2"
              onClick={() => importMutation.mutate({ url: importUrl, type: importType })}
              disabled={!importUrl.trim() || importMutation.isPending}
              data-testid="btn-run-import"
            >
              <Upload size={15} />
              {importMutation.isPending ? "Importing…" : "Import"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-4">

        {/* Add New Course form */}
        {addingNew && (
          <Card className="border-2 border-primary/30 bg-primary/4 animate-in fade-in slide-in-from-top-2 duration-200">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-primary">
                <Plus size={15} /> New Course
              </CardTitle>
            </CardHeader>
            <CardContent>
              <CourseForm
                form={newForm}
                onChange={setNewForm}
                onSave={() => createMutation.mutate(newForm)}
                onCancel={() => setAddingNew(false)}
                isSaving={createMutation.isPending}
                isNew
              />
            </CardContent>
          </Card>
        )}

        {/* Loading */}
        {isLoading && (
          <div className="space-y-3">
            <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground py-1">
              <Loader2 size={12} className="animate-spin" />
              Loading your courses — the first load after a while can take a few seconds.
            </p>
            {[1,2,3].map(i => (
              <div key={i} className="h-24 rounded-xl bg-muted/40 animate-pulse" />
            ))}
          </div>
        )}

        {/* Could not reach the backend — distinct from "no courses" */}
        {isError && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-5 text-center space-y-2">
            <AlertCircle size={22} className="mx-auto text-destructive" />
            <p className="text-sm font-semibold">Couldn't load your courses</p>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              {String((error as any)?.message || "The backend did not respond.")}
            </p>
            <Button size="sm" variant="outline" onClick={() => refetch()} className="mt-1">
              Try again
            </Button>
          </div>
        )}

        {/* Empty states */}
        {!isLoading && !isError && courses.length === 0 && !addingNew && (
          <div className="text-center py-20 text-muted-foreground">
            <Flag size={36} className="mx-auto mb-4 opacity-30" />
            <p className="font-semibold">No courses yet</p>
            <p className="text-sm mt-1">Tap "Add Course" to get started.</p>
          </div>
        )}

        {!isLoading && !isError && courses.length > 0 && visible.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <Search size={28} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">No courses match that filter.</p>
            <button
              onClick={() => { setSearch(""); setCountryFilter(""); }}
              className="text-xs text-primary underline underline-offset-2 mt-2"
            >
              Clear filters
            </button>
          </div>
        )}

        {/* Course cards */}
        {visible.map(course => {
          const cc = normalizeCountry((course as any).country);
          const stat = playStats[course.name];
          return (
            <Card
              key={course.id}
              data-testid={`card-course-${course.id}`}
              className={`transition-all ${editingId === String(course.id) ? "border-2 border-primary/40" : ""}`}
            >
              <CardContent className="pt-4 pb-4">
                {editingId === String(course.id) ? (
                  /* ── Edit mode ── */
                  <CourseForm
                    form={editForm}
                    onChange={setEditForm}
                    originalName={course.name}
                    onSave={() => updateMutation.mutate({ id: String(course.id), form: editForm })}
                    onSaveAsNew={() => createMutation.mutate(editForm)}
                    onCancel={cancelEdit}
                    isSaving={updateMutation.isPending || createMutation.isPending}
                  />
                ) : (
                  /* ── View mode ── */
                  <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <CountryFlag code={cc} size={17} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm leading-tight truncate">{course.name}</div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
                        <span className="text-xs text-muted-foreground">
                          {((course as any).tees ?? []).length
                            ? (course as any).tees
                                .map((t: any) => `${t.tee} ${t.courseRating}/${t.slopeRating}`)
                                .join("  ·  ")
                            : `CR ${course.courseRating} · Slope ${course.slopeRating}`}
                        </span>
                      </div>
                      {(cc || stat) && (
                        <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
                          {cc && <span>{countryName(cc)}</span>}
                          {stat && (
                            <span>
                              · {stat.count} round{stat.count === 1 ? "" : "s"}
                              {stat.last ? ` · last ${stat.last}` : ""}
                            </span>
                          )}
                        </div>
                      )}
                      {/* Per-hole par summary */}
                      <div className="flex flex-wrap gap-1 mt-2">
                        {(JSON.parse(course.pars) as number[]).map((p, i) => (
                          <span
                            key={i}
                            className={`inline-flex items-center justify-center w-5 h-5 rounded text-[9px] font-bold
                              ${p === 3 ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                              : p === 5 ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                              : "bg-muted text-muted-foreground"}`}
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Editing an existing course rewrites the course name on
                        everyone's round history, so it stays with the admin.
                        Adding a course is open to all. */}
                    {admin && (
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          onClick={() => startEdit(course)}
                          data-testid={`btn-edit-course-${course.id}`}
                        >
                          <Pencil size={14} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteTarget(course)}
                          data-testid={`btn-delete-course-${course.id}`}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </main>

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete course?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleteTarget?.name}" and its tees will be removed. This cannot be undone.
              {deleteTarget && playStats[deleteTarget.name]
                ? ` You have ${playStats[deleteTarget.name].count} round(s) recorded there — those keep their scores and ratings.`
                : " Rounds already played there keep their scores and ratings."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(String(deleteTarget.id))}
              data-testid="btn-confirm-delete-course"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
