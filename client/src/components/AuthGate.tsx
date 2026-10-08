import { useEffect, useRef, useState } from "react";
import { onAuthChange, signInWithGoogle, signOut, canEdit, publicEndpoint,
  setEndpoint, type Session } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { LogOut } from "lucide-react";

const CLIENT_ID =
  "667310518129-f9p6e6rerc9efnpmciob1km16hn5lthv.apps.googleusercontent.com";

declare global {
  interface Window { google?: any }
}

/**
 * Renders Google's own sign-in button.
 *
 * The button has to be drawn by Google's library — a hand-rolled one cannot
 * produce an ID token. We wait for the script, then hand Google a container
 * to render into and a callback that receives the credential.
 */
function GoogleButton({ onDone }: { onDone?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    let cancelled = false;

    const start = () => {
      if (cancelled || !box.current || !window.google?.accounts?.id) return;

      window.google.accounts.id.initialize({
        client_id: CLIENT_ID,
        callback: async (resp: { credential?: string }) => {
          if (!resp?.credential) return;
          setBusy(true);
          setErr(null);
          try {
            const s = await signInWithGoogle(resp.credential);
            toast({ title: "Signed in", description: s.email });
            onDone?.();
          } catch (e: any) {
            setErr(String(e?.message || e));
          } finally {
            setBusy(false);
          }
        },
      });

      window.google.accounts.id.renderButton(box.current, {
        type: "standard",
        theme: "outline",
        size: "large",
        text: "signin_with",
        shape: "pill",
        logo_alignment: "left",
      });
    };

    // The script tag is in index.html but may not have finished loading
    if (window.google?.accounts?.id) start();
    else {
      const t = setInterval(() => {
        if (window.google?.accounts?.id) { clearInterval(t); start(); }
      }, 150);
      setTimeout(() => clearInterval(t), 10_000);
      return () => { cancelled = true; clearInterval(t); };
    }

    return () => { cancelled = true; };
  }, [onDone, toast]);

  return (
    <div className="space-y-2 flex flex-col items-center">
      <div ref={box} className={busy ? "opacity-50 pointer-events-none" : ""} />
      {busy && <p className="text-xs text-muted-foreground">Checking with Google…</p>}
      {err && <p className="text-xs text-destructive max-w-xs">{err}</p>}
      {err && /backend|endpoint/i.test(err) && <EndpointFallback />}
    </div>
  );
}

/**
 * Shown when the build has no endpoint baked in. Without this the sign-in
 * screen is a dead end — the button works but has nowhere to send the token.
 */
function EndpointFallback() {
  const [url, setUrl] = useState("");
  return (
    <div className="mt-3 w-full max-w-xs space-y-2 text-left">
      <label className="text-[11px] text-muted-foreground block">
        Paste your Apps Script Web App URL (ends in /exec)
      </label>
      <input
        value={url}
        onChange={e => setUrl(e.target.value)}
        placeholder="https://script.google.com/macros/s/…/exec"
        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
      />
      <button
        onClick={() => { if (url.trim()) { setEndpoint(url); location.reload(); } }}
        disabled={!url.trim()}
        className="w-full rounded-md bg-primary text-primary-foreground text-xs py-1.5 disabled:opacity-40"
      >
        Save and retry
      </button>
    </div>
  );
}

/**
 * Wraps content that requires sign-in. Used on the dashboard; scorecards stay
 * readable without it.
 */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => onAuthChange(s => { setSession(s); setReady(true); }), []);

  if (!ready) return null;
  if (session || canEdit()) return <>{children}</>;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 text-center gap-5">
      <svg viewBox="0 0 32 32" width="48" height="48" fill="none" aria-hidden>
        <circle cx="16" cy="16" r="15" stroke="currentColor" strokeWidth="2"
                className="text-primary" />
        <path d="M16 8v12M16 8l-5 8M16 8l5 8" stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round" strokeLinejoin="round" className="text-primary" />
        <circle cx="16" cy="24" r="2" fill="currentColor" className="text-accent" />
      </svg>

      <div>
        <h1 className="font-display font-bold text-xl">Golf Dash</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-xs">
          Sign in to see your rounds and handicap. Shared scorecards open
          without signing in.
        </p>
      </div>

      <GoogleButton />

      {!publicEndpoint() && (
        <div className="w-full flex justify-center">
          <EndpointFallback />
        </div>
      )}
    </div>
  );
}

/**
 * A compact sign-in control for pages that are readable while signed out.
 * Shows a sign-out button once authenticated.
 */
export function SignInButton({ compact = false }: { compact?: boolean }) {
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => onAuthChange(setSession), []);

  if (session) {
    if (compact) return null;
    return (
      <button
        onClick={() => signOut()}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        title={session.email}
      >
        <LogOut size={13} /> Sign out
      </button>
    );
  }

  return <GoogleButton />;
}

/** Banner for a scorecard being viewed without edit rights. */
export function ReadOnlyBar() {
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => onAuthChange(setSession), []);
  if (session || canEdit()) return null;

  return (
    <div className="sticky top-14 z-10 bg-accent/10 border-b border-accent/30
                    px-4 py-2 flex items-center justify-between gap-3 flex-wrap">
      <p className="text-xs text-muted-foreground">
        Viewing only — sign in to edit scores.
      </p>
      <GoogleButton />
    </div>
  );
}
