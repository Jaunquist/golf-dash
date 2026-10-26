import { useState, useEffect } from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { scoreCssClass } from "@/lib/gameEngine";
import type { FairwayResult } from "@shared/schema";

/**
 * Everything one hole can record.
 *
 * Passed as an object rather than four more positional arguments, so adding a
 * field later does not mean editing every call site in the scorecard again.
 */
export interface HoleEntry {
  strokes: number;
  putts: number;
  penalties: number;
  fairway: FairwayResult | null;
  mishit: boolean;
  /**
   * A note about the HOLE, not about this player.
   *
   * The sheet opens from one player's cell, but a hole has one note shared by
   * the group — four notes per hole is friction nobody absorbs mid-round, and
   * the interesting remark is almost always about the hole anyway. Whichever
   * cell you opened, you are editing the same text.
   *
   * undefined means "this build has comments switched off, leave whatever is
   * stored alone" — distinct from "" which means the user cleared it.
   */
  note?: string;
}

/** Keeps a comment to something a sheet cell and a prompt can both carry. */
export const NOTE_MAX = 200;

/**
 * Taps instead of typing.
 *
 * These cover only what the scorecard cannot already infer. There is no
 * "3-putt" chip because putts are recorded, and no "penalty" chip because the
 * count is — what is missing is WHICH kind, which is why water and OB are
 * here and a bare "penalty" is not.
 */
const NOTE_CHIPS = [
  "water", "OB", "trees", "bunker", "lipped out",
  "great recovery", "conceded", "lost ball",
];

interface HoleInputSheetProps {
  open: boolean;
  hole: number;          // internal 1-based index (used for save callbacks)
  displayHole?: number;  // display label (e.g. 10-18 for back 9)
  totalHoles: number;
  par: number;
  holeHcp: number;
  playerName: string;
  playerColor: string;
  strokesOnHole: number;
  initialStrokes: number | null; // null = no score yet → defaults to par
  initialPutts: number | null;
  initialPenalties?: number | null;
  initialFairway?: FairwayResult | null;
  initialMishit?: boolean | null;
  /** Current note for this hole. Undefined when comments are switched off. */
  initialNote?: string | null;
  /** False hides the comment block entirely — "I just want to score". */
  notesEnabled?: boolean;
  /** Only the round owner may write; everyone else sees it read-only. */
  canComment?: boolean;
  onSave: (hole: number, entry: HoleEntry) => void;
  onDelete: (hole: number) => void;        // reset / clear this hole's score
  onClose: () => void;                     // close WITHOUT saving
  onNavNext: (hole: number, entry: HoleEntry) => void;  // save + go next
  onNavPrev: (hole: number, entry: HoleEntry) => void;  // save + go prev
}

// Vertical stepper: label → + → value → −
function Stepper({
  label,
  value,
  min,
  max,
  onChange,
  onAttemptExceedMax,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  onAttemptExceedMax?: () => void;
}) {
  const dec = () => { if (value > min) onChange(value - 1); };
  const inc = () => {
    if (value < max) onChange(value + 1);
    else onAttemptExceedMax?.();
  };

  return (
    <div className="flex flex-col items-center gap-1 flex-1">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">
        {label}
      </span>
      <button
        onPointerDown={e => { e.preventDefault(); inc(); }}
        style={{ opacity: value < max ? 1 : 0.3 }}
        className="w-14 h-14 rounded-2xl bg-muted active:bg-muted/60 flex items-center justify-center text-2xl font-light select-none active:scale-95 transition-transform"
      >
        +
      </button>
      <span className="text-4xl font-bold tabular-nums select-none h-12 flex items-center justify-center">
        {value}
      </span>
      <button
        onPointerDown={e => { e.preventDefault(); dec(); }}
        style={{ opacity: value > min ? 1 : 0.3 }}
        className="w-14 h-14 rounded-2xl bg-muted active:bg-muted/60 flex items-center justify-center text-2xl font-light select-none active:scale-95 transition-transform"
      >
        −
      </button>
    </div>
  );
}

/**
 * Compact horizontal counter for things that are usually zero.
 *
 * Penalties get this rather than a third tall stepper because most holes have
 * none: the common path should cost no taps and no vertical space, and three
 * large steppers across would crowd a phone.
 */
function MiniCounter({ label, value, min, max, onChange }: {
  label: string; value: number; min: number; max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted-foreground flex-1">{label}</span>
      <button
        onPointerDown={e => { e.preventDefault(); if (value > min) onChange(value - 1); }}
        style={{ opacity: value > min ? 1 : 0.3 }}
        className="w-8 h-8 rounded-lg bg-muted active:bg-muted/60 flex items-center justify-center text-lg font-light select-none active:scale-95 transition-transform"
      >
        −
      </button>
      <span className={`w-6 text-center text-base font-bold tabular-nums select-none ${
        value > 0 ? "text-destructive" : "text-muted-foreground/50"
      }`}>
        {value}
      </span>
      <button
        onPointerDown={e => { e.preventDefault(); if (value < max) onChange(value + 1); }}
        style={{ opacity: value < max ? 1 : 0.3 }}
        className="w-8 h-8 rounded-lg bg-muted active:bg-muted/60 flex items-center justify-center text-lg font-light select-none active:scale-95 transition-transform"
      >
        +
      </button>
    </div>
  );
}

export default function HoleInputSheet({
  open,
  hole,
  displayHole,
  totalHoles,
  par,
  holeHcp,
  playerName,
  playerColor,
  strokesOnHole,
  initialStrokes,
  initialPutts,
  initialPenalties,
  initialFairway,
  initialMishit,
  initialNote,
  notesEnabled = false,
  canComment = false,
  onSave,
  onDelete,
  onClose,
  onNavNext,
  onNavPrev,
}: HoleInputSheetProps) {
  const [strokes, setStrokes] = useState<number>(initialStrokes ?? par);
  const [putts, setPutts] = useState<number>(initialPutts ?? 0);
  const [penalties, setPenalties] = useState<number>(initialPenalties ?? 0);
  const [fairway, setFairway] = useState<FairwayResult | null>(initialFairway ?? null);
  const [mishit, setMishit] = useState<boolean>(!!initialMishit);
  const [puttWarn, setPuttWarn] = useState(false);
  const [note, setNote] = useState<string>(initialNote ?? "");

  // A par 3 has no tee shot to a fairway, so the control does not appear there
  const hasFairway = par >= 4;

  // Reset local state whenever the sheet opens on a new hole
  useEffect(() => {
    setStrokes(initialStrokes ?? par);
    setPutts(initialPutts ?? 0);
    setPenalties(initialPenalties ?? 0);
    setFairway(initialFairway ?? null);
    setMishit(!!initialMishit);
    setNote(initialNote ?? "");
    setPuttWarn(false);
  }, [hole, initialStrokes, initialPutts, initialPenalties, initialFairway,
      initialMishit, initialNote, par]);

  const entry = (): HoleEntry => ({
    strokes,
    putts,
    penalties,
    fairway: hasFairway ? fairway : null,
    mishit: hasFairway ? mishit : false,
    // Left undefined when this user cannot write a note, so a read-only
    // viewer saving a score cannot blank out the owner's comment.
    note: canComment ? note.slice(0, NOTE_MAX) : undefined,
  });

  const handlePuttsInc = () => {
    if (putts < strokes) setPutts(p => p + 1);
    else { setPuttWarn(true); setTimeout(() => setPuttWarn(false), 2500); }
  };

  const handleStrokesChange = (next: number) => {
    setStrokes(next);
    if (putts > next) setPutts(next);          // clamp putts
    if (penalties > next) setPenalties(next);  // and penalties
  };

  const scoreDiff = strokes - par;
  const scoreLabel =
    scoreDiff <= -2 ? "Eagle" :
    scoreDiff === -1 ? "Birdie" :
    scoreDiff === 0  ? "Par" :
    scoreDiff === 1  ? "Bogey" :
    scoreDiff === 2  ? "Double" :
    scoreDiff === 3  ? "Triple" :
    `+${scoreDiff}`;
  const cssClass = scoreCssClass(strokes, par);

  const FAIRWAYS: { key: FairwayResult; label: string }[] = [
    { key: "left",  label: "Left" },
    { key: "hit",   label: "Fairway" },
    { key: "right", label: "Right" },
  ];

  return (
    <SheetPrimitive.Root
      open={open}
      onOpenChange={v => {
        // Tapping backdrop (v=false) → close WITHOUT saving
        if (!v) onClose();
      }}
    >
      <SheetPrimitive.Portal>
        {/* Backdrop — tap to dismiss without saving */}
        <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />

        {/* Sheet — no built-in close button */}
        <SheetPrimitive.Content
          className={[
            "fixed inset-x-0 bottom-0 z-50",
            "bg-background rounded-t-3xl shadow-xl",
            "flex flex-col",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
            "duration-300",
          ].join(" ")}
          style={{ maxHeight: "88vh" }}
          onOpenAutoFocus={e => e.preventDefault()}
          // Intercept Radix close-on-escape — treat escape same as backdrop (no save)
          onEscapeKeyDown={() => onClose()}
          onInteractOutside={e => {
            e.preventDefault(); // prevent Radix default close
            onClose();          // close without saving
          }}
        >
          {/* Drag handle */}
          <div className="flex justify-center pt-3 pb-2 shrink-0">
            <div className="w-10 h-1 rounded-full bg-border" />
          </div>

          {/* Player row */}
          <div className="flex items-center gap-2 px-5 pb-2 border-b border-border shrink-0">
            <span className={`text-sm font-bold ${playerColor}`}>{playerName}</span>
            {strokesOnHole > 0 && (
              <div className="flex gap-0.5">
                {Array.from({ length: strokesOnHole }).map((_, i) => (
                  <div key={i} className="w-1.5 h-1.5 rounded-full bg-primary/50" />
                ))}
              </div>
            )}
          </div>

          {/* Hole nav — arrows save + navigate */}
          <div className="flex items-center justify-between px-4 py-3 bg-muted/30 shrink-0">
            <button
              onPointerDown={e => { e.preventDefault(); }}
              onClick={() => { if (hole > 1) onNavPrev(hole, entry()); }}
              disabled={hole <= 1}
              className="w-10 h-10 rounded-full bg-muted flex items-center justify-center disabled:opacity-30 active:scale-95 transition-transform"
            >
              <ChevronLeft size={18} />
            </button>
            <div className="text-center">
              <div className="text-2xl font-bold">Hole {displayHole ?? hole}</div>
              <div className="text-sm text-muted-foreground">Par {par} · HCP {holeHcp}</div>
            </div>
            <button
              onPointerDown={e => { e.preventDefault(); }}
              onClick={() => { if (hole < totalHoles) onNavNext(hole, entry()); }}
              disabled={hole >= totalHoles}
              className="w-10 h-10 rounded-full bg-muted flex items-center justify-center disabled:opacity-30 active:scale-95 transition-transform"
            >
              <ChevronRight size={18} />
            </button>
          </div>

          {/* Scrolls if a short phone cannot fit the tee row */}
          <div className="overflow-y-auto">
            {/* Score badge */}
            <div className="flex justify-center pt-2 shrink-0">
              <span className={`text-xs font-semibold px-3 py-0.5 rounded-full border ${cssClass}`}>
                {scoreLabel}
              </span>
            </div>

            {/* Putts warning */}
            {puttWarn && (
              <div className="mx-5 mt-2 px-3 py-1.5 rounded-xl bg-destructive/10 border border-destructive/30 text-destructive text-xs font-medium text-center shrink-0">
                Putts can't exceed strokes
              </div>
            )}

            {/* Steppers */}
            <div className="flex items-start justify-center gap-8 px-6 pt-3 pb-2">
              <Stepper
                label="Strokes"
                value={strokes}
                min={1}
                max={20}
                onChange={handleStrokesChange}
              />
              <div className="w-px self-stretch bg-border/40 mt-6" />
              <Stepper
                label="Putts"
                value={putts}
                min={0}
                max={strokes}
                onChange={setPutts}
                onAttemptExceedMax={handlePuttsInc}
              />
            </div>

            {/* Detail: both optional, both default to untouched */}
            <div className="mx-5 mt-1 mb-2 rounded-2xl border border-border/60 divide-y divide-border/60">
              <div className="px-3 py-2">
                <MiniCounter
                  label="Penalty strokes"
                  value={penalties}
                  min={0}
                  max={strokes}
                  onChange={setPenalties}
                />
              </div>

              {hasFairway && (
                <div className="px-3 py-2.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground shrink-0">Off the tee</span>
                    {fairway && (
                      <button
                        onPointerDown={e => { e.preventDefault(); setFairway(null); }}
                        className="text-[10px] text-muted-foreground/60 hover:text-foreground ml-auto"
                      >
                        clear
                      </button>
                    )}
                  </div>
                  <div className="flex gap-1.5">
                    {FAIRWAYS.map(f => (
                      <button
                        key={f.key}
                        onPointerDown={e => {
                          e.preventDefault();
                          setFairway(cur => (cur === f.key ? null : f.key));
                        }}
                        className={`flex-1 h-9 rounded-xl text-xs font-semibold select-none active:scale-95 transition-all border ${
                          fairway === f.key
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-muted/50 border-transparent text-muted-foreground"
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                  {/* Distance is its own axis: a drive can be short AND left, so
                      this is a separate flag rather than a fourth direction */}
                  <button
                    onPointerDown={e => { e.preventDefault(); setMishit(m => !m); }}
                    className={`w-full h-8 rounded-xl text-[11px] font-semibold select-none active:scale-95 transition-all border ${
                      mishit
                        ? "bg-destructive/15 text-destructive border-destructive/40"
                        : "bg-muted/50 border-transparent text-muted-foreground"
                    }`}
                  >
                    {mishit ? "Mishit — didn't advance" : "Mishit?"}
                  </button>
                </div>
              )}
            </div>

            {/*
              Hole note.
              Deliberately last: strokes and putts are the job, this is the
              optional extra. Hidden entirely when notes are switched off, so
              a round you just want to score looks exactly as it did before.
            */}
            {notesEnabled && (
              <div className="mt-4 pt-3 border-t border-border/40 space-y-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-[11px] font-semibold text-muted-foreground">
                    Note for hole {displayHole ?? hole}
                  </span>
                  {canComment && (
                    <span className="text-[10px] text-muted-foreground/60 ml-auto tabular-nums">
                      {note.length}/{NOTE_MAX}
                    </span>
                  )}
                </div>

                {canComment ? (
                  <>
                    <textarea
                      value={note}
                      onChange={e => setNote(e.target.value.slice(0, NOTE_MAX))}
                      rows={2}
                      placeholder="What happened? Tee shot, trouble, a putt worth remembering…"
                      className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm
                                 placeholder:text-muted-foreground/50 focus:outline-none
                                 focus:ring-2 focus:ring-primary/30 resize-none"
                    />
                    {/*
                      Tapping beats typing with three people waiting on the next
                      tee. Chips append rather than replace, so several can be
                      stacked, and each one is a word the scorecard could not
                      have worked out on its own.
                    */}
                    <div className="flex flex-wrap gap-1">
                      {NOTE_CHIPS.map(c => (
                        <button
                          key={c}
                          onPointerDown={e => e.preventDefault()}
                          onClick={() =>
                            setNote(prev => {
                              const next = prev.trim() ? `${prev.trim()}, ${c}` : c;
                              return next.slice(0, NOTE_MAX);
                            })
                          }
                          className="px-2 py-1 rounded-lg text-[10px] font-medium bg-muted/60
                                     text-muted-foreground hover:bg-muted active:scale-95 transition-all"
                        >
                          {c}
                        </button>
                      ))}
                      {note && (
                        <button
                          onPointerDown={e => e.preventDefault()}
                          onClick={() => setNote("")}
                          className="px-2 py-1 rounded-lg text-[10px] font-medium
                                     text-muted-foreground/70 hover:text-destructive active:scale-95 transition-all"
                        >
                          clear
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground/80 leading-snug">
                    {note || "No note on this hole."}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="px-5 pt-2 pb-8 shrink-0 flex flex-col gap-2 border-t border-border/40">
            {/* Primary: Save & Close */}
            <Button
              className="w-full h-12 text-base rounded-2xl"
              onPointerDown={e => e.preventDefault()}
              onClick={() => { onSave(hole, entry()); onClose(); }}
            >
              Save &amp; Close
            </Button>
            {/* Secondary: Delete Score */}
            <button
              onPointerDown={e => e.preventDefault()}
              onClick={() => { onDelete(hole); onClose(); }}
              className="flex items-center justify-center gap-1.5 w-full py-2 rounded-xl text-sm text-muted-foreground hover:text-destructive active:scale-95 transition-all"
            >
              <Trash2 size={14} />
              Delete Score
            </button>
          </div>
        </SheetPrimitive.Content>
      </SheetPrimitive.Portal>
    </SheetPrimitive.Root>
  );
}
