/**
 * Shown while a route's chunk downloads, and reused as the loading state for a
 * shared scorecard.
 *
 * It draws the shape of what is arriving rather than a spinner. On a cold
 * Apps Script call that wait can run to several seconds, and a skeleton that
 * matches the real layout reads as "loading" where a blank screen reads as
 * "broken" — particularly to someone opening the link for the first time.
 */
export default function RouteFallback({
  kind = "plain",
}: { kind?: "plain" | "scorecard" | "dashboard" }) {
  return (
    <div className="min-h-screen bg-background">
      {/* Header stand-in, so the page does not jump when the real one lands */}
      <div className="sticky top-0 z-20 bg-background/95 border-b border-border">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center gap-3">
          <Mark />
          <div className="flex-1 space-y-1.5">
            <Bar className="h-3.5 w-40" />
            <Bar className="h-2.5 w-24" />
          </div>
        </div>
      </div>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-4">
        {kind === "scorecard" && <ScorecardSkeleton />}
        {kind === "dashboard" && <DashboardSkeleton />}
        {kind === "plain" && (
          <div className="space-y-3">
            <Bar className="h-24 w-full rounded-xl" />
            <Bar className="h-24 w-full rounded-xl" />
          </div>
        )}

        <p className="text-center text-xs text-muted-foreground pt-2">
          Loading…
        </p>
      </main>
    </div>
  );
}

function Bar({ className = "" }: { className?: string }) {
  return <div className={`bg-muted/70 rounded animate-pulse ${className}`} />;
}

/** The logo, so something recognisable is on screen immediately. */
function Mark() {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" fill="none" aria-hidden
         className="shrink-0">
      <circle cx="16" cy="16" r="15" stroke="currentColor" strokeWidth="2"
              className="text-primary" />
      <path d="M16 8v12M16 8l-5 8M16 8l5 8" stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round" className="text-primary" />
      <circle cx="16" cy="24" r="2" fill="currentColor" className="text-accent" />
    </svg>
  );
}

function ScorecardSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex gap-1.5">
        <Bar className="h-7 w-16" />
        <Bar className="h-7 w-20" />
        <Bar className="h-7 w-14" />
      </div>

      {[0, 1].map(section => (
        <div key={section} className="space-y-2">
          <Bar className="h-3 w-28" />
          <div className="rounded-lg border border-border overflow-hidden">
            {/* Hole number row */}
            <div className="flex gap-px bg-muted/40 p-2">
              <Bar className="h-6 w-20 shrink-0" />
              {Array.from({ length: 9 }).map((_, i) => (
                <Bar key={i} className="h-6 flex-1" />
              ))}
            </div>
            {/* Player rows */}
            {Array.from({ length: 3 }).map((_, r) => (
              <div key={r} className="flex gap-px p-2 border-t border-border">
                <Bar className="h-8 w-20 shrink-0" />
                {Array.from({ length: 9 }).map((_, i) => (
                  <Bar key={i} className="h-8 flex-1" />
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <Bar className="h-9 w-full rounded-lg" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Bar key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      <Bar className="h-64 w-full rounded-xl" />
    </div>
  );
}
