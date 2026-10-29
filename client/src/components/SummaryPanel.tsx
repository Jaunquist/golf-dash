/**
 * Generate a written account of the round, over a chosen stretch of holes.
 *
 * VERIFY: summary-panel-copy
 *
 * Admin only, because this is the one button in the app that spends money.
 *
 * There is no share surface here on purpose. Hole comments are owner-only, and
 * the summary is written from those comments — so a shared summary would carry
 * them straight back out and the privacy boundary would be decorative. Instead
 * the finished text gets a Copy button: it leaves only when a person reads it
 * and decides to paste it somewhere, which is a deliberate act rather than a
 * link quietly doing it for them.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sparkles, Copy, Check, AlertCircle, Loader2 } from "lucide-react";
import { generateSummary } from "@/lib/queryClient";
import { buildRoundFacts, SUMMARY_SYSTEM_PROMPT, type FactSheetInput } from "@/lib/roundFacts";

export interface StoredSummary {
  text: string;
  model: string;
  at: string;
  from: number;
  to: number;
  /** Holes complete at generation time, so staleness can be noticed. */
  holesAt: number;
}

export default function SummaryPanel({
  canGenerate,
  holes,
  holeLabel,
  buildInput,
  stored,
  onStore,
  holesComplete,
}: {
  canGenerate: boolean;
  holes: number;
  holeLabel: (h: number) => number;
  /** Called at generate time so the sheet reflects the latest scores. */
  buildInput: (from: number, to: number) => FactSheetInput;
  /** Last generated summary, kept on the round so it survives a reload. */
  stored?: StoredSummary | null;
  onStore?: (s: StoredSummary) => void;
  /** Holes every player has posted, for the stale check. */
  holesComplete: number;
  /** How many holes carry a note, for the nudge below. */
  noteCount?: number;
}) {
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(holes);
  // Seeded from the round so reopening the page shows the last summary rather
  // than an empty panel and a button that costs money to press again.
  const [text, setText] = useState(stored?.text ?? "");
  const [meta, setMeta] = useState<{ model: string; at: string; from: number; to: number } | null>(
    stored ? { model: stored.model, at: stored.at, from: stored.from, to: stored.to } : null
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);

  /**
   * A summary describes the round as it stood when it was written. Keep
   * scoring and it quietly stops being true, which matters most mid-round —
   * exactly when this feature is used. Rather than silently refreshing (which
   * would spend money without being asked) or silently not (which would leave
   * a confident, wrong account on screen), it says so.
   */
  const stale = !!stored && holesComplete > stored.holesAt;

  if (!canGenerate) return null;

  const holeOptions = Array.from({ length: holes }, (_, i) => i + 1);

  async function run() {
    setBusy(true);
    setErr("");
    try {
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      const facts = buildRoundFacts(buildInput(lo, hi));
      const res = await generateSummary(facts, SUMMARY_SYSTEM_PROMPT);
      setText(res.text);
      setMeta({ model: res.model, at: res.generatedAt, from: lo, to: hi });
      onStore?.({
        text: res.text, model: res.model, at: res.generatedAt,
        from: lo, to: hi, holesAt: holesComplete,
      });
    } catch (e: any) {
      // The backend's message is the useful part — "No API key set", "HTTP 429"
      // — so it is shown rather than replaced with something reassuring.
      setErr(String(e?.message || e || "Generation failed"));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("Couldn't copy — select the text and copy it manually.");
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <Sparkles className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Round summary
        </h2>
      </div>

      <div className="px-4 pb-3 space-y-3">
        <div className="flex items-end gap-2">
          <label className="flex-1 min-w-0">
            <span className="block text-[10px] text-muted-foreground mb-1">From hole</span>
            <select
              value={from}
              onChange={e => setFrom(Number(e.target.value))}
              className="w-full h-9 rounded-lg border border-border bg-background px-2 text-sm"
            >
              {holeOptions.map(h => (
                <option key={h} value={h}>{holeLabel(h)}</option>
              ))}
            </select>
          </label>
          <label className="flex-1 min-w-0">
            <span className="block text-[10px] text-muted-foreground mb-1">To hole</span>
            <select
              value={to}
              onChange={e => setTo(Number(e.target.value))}
              className="w-full h-9 rounded-lg border border-border bg-background px-2 text-sm"
            >
              {holeOptions.map(h => (
                <option key={h} value={h}>{holeLabel(h)}</option>
              ))}
            </select>
          </label>
          <Button onClick={run} disabled={busy} className="h-9 shrink-0">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" />
                  : text ? "Regenerate" : "Generate"}
          </Button>
        </div>

        <p className="text-[10px] text-muted-foreground/70 leading-snug">
          Set both to the same hole for one hole on its own. Written from the
          scores and your hole notes — holes without a note stay factual.
        </p>

        {/*
          The scores give it what happened; only a note gives it why. A round
          with none produces an accurate but flat recital, and the difference
          is worth saying once rather than leaving the user to conclude the
          feature is dull.
        */}
        {holesComplete >= 3 && (noteCount ?? 0) === 0 && (
          <p className="text-[10px] text-muted-foreground/70 leading-snug flex gap-1.5">
            <AlertCircle className="h-3 w-3 shrink-0 mt-px" />
            <span>
              No hole notes yet. The scores say what happened; a note is the
              only way it learns why — a chip-in, a lost ball, a gimme.
            </span>
          </p>
        )}

        {err && (
          <div className="flex gap-1.5 rounded-lg bg-destructive/10 px-2.5 py-2">
            <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-px" />
            <p className="text-[11px] text-destructive leading-snug break-words">{err}</p>
          </div>
        )}

        {busy && !text && (
          <p className="text-xs text-muted-foreground">
            Writing it up — this takes a few seconds.
          </p>
        )}

        {stale && text && !busy && (
          <p className="text-[10px] text-muted-foreground/80 leading-snug flex gap-1.5">
            <AlertCircle className="h-3 w-3 shrink-0 mt-px" />
            <span>
              Holes have been scored since this was written. Regenerate to
              include them.
            </span>
          </p>
        )}

        {text && (
          <div className="space-y-2">
            <div className="rounded-lg bg-muted/30 px-3 py-2.5">
              {/* Paragraphs rather than one block: the model is asked for a few
                  short ones and they should read as such. */}
              {text.split(/\n{2,}/).map((para, i) => (
                <p key={i} className="text-sm leading-relaxed whitespace-pre-wrap mb-2 last:mb-0">
                  {para}
                </p>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={copy}
                className="inline-flex items-center gap-1.5 text-[11px] font-medium
                           text-muted-foreground hover:text-foreground transition-colors"
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy text"}
              </button>
              {meta && (
                <span className="text-[10px] text-muted-foreground/60 ml-auto truncate">
                  holes {holeLabel(meta.from)}–{holeLabel(meta.to)} · {meta.model}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
