import { useState, useEffect, useCallback } from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { scoreCssClass } from "@/lib/gameEngine";

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
  onSave: (hole: number, strokes: number, putts: number) => void;
  onDelete: (hole: number) => void;   // reset / clear this hole's score
  onClose: () => void;                // close WITHOUT saving
  onNavNext: (hole: number, strokes: number, putts: number) => void;  // save + go next
  onNavPrev: (hole: number, strokes: number, putts: number) => void;  // save + go prev
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
  onSave,
  onDelete,
  onClose,
  onNavNext,
  onNavPrev,
}: HoleInputSheetProps) {
  const [strokes, setStrokes] = useState<number>(initialStrokes ?? par);
  const [putts, setPutts] = useState<number>(initialPutts ?? 0);
  const [puttWarn, setPuttWarn] = useState(false);

  // Reset local state whenever the sheet opens on a new hole
  useEffect(() => {
    setStrokes(initialStrokes ?? par);
    setPutts(initialPutts ?? 0);
    setPuttWarn(false);
  }, [hole, initialStrokes, initialPutts, par]);

  const handlePuttsInc = () => {
    if (putts < strokes) setPutts(p => p + 1);
    else { setPuttWarn(true); setTimeout(() => setPuttWarn(false), 2500); }
  };

  const handleStrokesDec = (next: number) => {
    setStrokes(next);
    if (putts > next) setPutts(next); // clamp putts
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
          style={{ maxHeight: "72vh" }}
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
              onClick={() => { if (hole > 1) onNavPrev(hole, strokes, putts); }}
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
              onClick={() => { if (hole < totalHoles) onNavNext(hole, strokes, putts); }}
              disabled={hole >= totalHoles}
              className="w-10 h-10 rounded-full bg-muted flex items-center justify-center disabled:opacity-30 active:scale-95 transition-transform"
            >
              <ChevronRight size={18} />
            </button>
          </div>

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
              onChange={v => handleStrokesDec(v)}
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

          {/* Actions */}
          <div className="px-5 pt-2 pb-8 shrink-0 flex flex-col gap-2">
            {/* Primary: Save & Close */}
            <Button
              className="w-full h-12 text-base rounded-2xl"
              onPointerDown={e => e.preventDefault()}
              onClick={() => { onSave(hole, strokes, putts); onClose(); }}
            >
              Save & Close
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
