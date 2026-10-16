/**
 * Admin-only strip on the dashboard: who is waiting for access, and whether
 * the Sheets backend is still coping.
 *
 * The quotas Apps Script publishes are not the thing that will bite first — at
 * this group size they are nowhere near. Lock contention and save latency are.
 * Those are what this watches, with a stated threshold so the decision to move
 * off Sheets is a number rather than a feeling.
 */

import { useQuery } from "@tanstack/react-query";
import { adminUsage, isAdmin } from "@/lib/queryClient";
import { ChevronDown, ShieldCheck, AlertTriangle } from "lucide-react";
import { useState } from "react";

interface Usage {
  days: number;
  writes: number;
  errors: number;
  lockTimeouts: number;
  saveP50: number | null;
  saveP95: number | null;
  playerRows: number;
  roundRows: number;
  accounts: { approved: number; pending: number; blocked: number };
  pendingUsers: { email: string; name: string }[];
  byUser: { email: string; writes: number; errors: number; last: string }[];
}

/** The thresholds from the sizing conversation, in one place. */
const LIMITS = {
  saveP95Ms: 3000,     // saves slower than this feel laggy on course wifi
  lockTimeouts: 1,     // any at all means real write contention
  accounts: 10,        // beyond this, Sheets stops being the easy answer
};

function Row({ label, value, warn, note }: {
  label: string; value: string; warn?: boolean; note?: string;
}) {
  return (
    <div className="flex items-baseline gap-2 py-1">
      <span className="text-[11px] text-muted-foreground flex-1">{label}</span>
      <span className={`text-xs font-bold tabular ${
        warn ? "text-orange-500 dark:text-orange-400" : ""
      }`}>
        {value}
      </span>
      {note && <span className="text-[9px] text-muted-foreground/60 w-20 text-right">{note}</span>}
    </div>
  );
}

export default function AdminPanel() {
  const [open, setOpen] = useState(false);

  // Hook order has to stay stable, so the query is declared before the
  // early return and simply disabled for non-admins
  const admin = isAdmin();
  const { data, isLoading } = useQuery<Usage>({
    queryKey: ["/api/usage"],
    enabled: admin && open,
    queryFn: () => adminUsage(),
  });

  if (!admin) return null;

  const pending = data?.accounts.pending ?? 0;
  const overLimit =
    !!data && (
      (data.saveP95 ?? 0) > LIMITS.saveP95Ms ||
      data.lockTimeouts >= LIMITS.lockTimeouts ||
      data.accounts.approved > LIMITS.accounts
    );

  return (
    <section className="rounded-xl border border-border bg-card">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left"
      >
        <ShieldCheck size={14} className="text-primary shrink-0" />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Admin
        </span>
        {pending > 0 && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-accent text-accent-foreground">
            {pending} waiting
          </span>
        )}
        {overLimit && <AlertTriangle size={13} className="text-orange-500" />}
        <ChevronDown size={14}
          className={`ml-auto text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>

      {open && (
        <div className="px-4 pb-3.5 space-y-3 border-t border-border pt-3">
          {isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}

          {data && (
            <>
              {data.pendingUsers.length > 0 && (
                <div className="rounded-lg bg-accent/10 border border-accent/30 px-3 py-2">
                  <p className="text-[11px] font-semibold mb-1">Waiting for approval</p>
                  {data.pendingUsers.map(u => (
                    <p key={u.email} className="text-[10px] text-muted-foreground">
                      {u.name} · {u.email}
                    </p>
                  ))}
                  <p className="text-[9px] text-muted-foreground/70 mt-1.5 leading-snug">
                    Approve in Apps Script: <code>approveUser("email")</code>, or set
                    status to <code>approved</code> in the Users tab.
                  </p>
                </div>
              )}

              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-0.5">
                  Last {data.days} days
                </p>
                <Row label="Writes" value={String(data.writes)} />
                <Row label="Errors" value={String(data.errors)} warn={data.errors > 0} />
                <Row label="Lock timeouts" value={String(data.lockTimeouts)}
                     warn={data.lockTimeouts >= LIMITS.lockTimeouts}
                     note={`limit ${LIMITS.lockTimeouts}`} />
                <Row label="Save p50" value={data.saveP50 != null ? `${data.saveP50}ms` : "—"} />
                <Row label="Save p95" value={data.saveP95 != null ? `${data.saveP95}ms` : "—"}
                     warn={(data.saveP95 ?? 0) > LIMITS.saveP95Ms}
                     note={`limit ${LIMITS.saveP95Ms}ms`} />
              </div>

              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-0.5">
                  Size
                </p>
                <Row label="Accounts" value={String(data.accounts.approved)}
                     warn={data.accounts.approved > LIMITS.accounts}
                     note={`limit ${LIMITS.accounts}`} />
                <Row label="Rounds" value={String(data.roundRows)} />
                <Row label="Player rows" value={String(data.playerRows)} />
              </div>

              {data.byUser.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-0.5">
                    By account
                  </p>
                  {data.byUser.slice(0, 8).map(u => (
                    <Row key={u.email}
                         label={u.email.split("@")[0]}
                         value={`${u.writes}`}
                         note={u.last ? u.last.slice(0, 10) : ""} />
                  ))}
                </div>
              )}

              <p className={`text-[10px] leading-snug ${
                overLimit ? "text-orange-500 dark:text-orange-400" : "text-muted-foreground/70"
              }`}>
                {overLimit
                  ? "One of the thresholds is crossed — worth revisiting whether Sheets is still the right backend."
                  : "Comfortably inside the limits. Nothing to do."}
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
