import { lazy, Suspense, type ComponentType } from "react";
import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { useOfflineToast } from "@/hooks/use-offline-toast";
import SyncStatus from "@/components/SyncStatus";
import RouteFallback from "@/components/RouteFallback";

const RELOADED_KEY = "golf-dash-chunk-reload";

/**
 * lazy(), but survives a deploy that happened while the app was open.
 *
 * Split chunks are written with a content hash — Scorecard-CsVjJx1x.js — and a
 * new build replaces the whole folder, so yesterday's filenames stop existing.
 * A tab still holding the old index.html then asks for a chunk that is gone and
 * dies with "Failed to fetch dynamically imported module", which looks to the
 * user like the app is simply broken.
 *
 * Reloading fetches the current index.html and the hashes it actually refers
 * to, which fixes it every time. The sessionStorage flag makes that at most one
 * reload per session, so a genuinely missing chunk or a dead network surfaces
 * as an error instead of an infinite refresh loop.
 */
function lazyRoute(load: () => Promise<{ default: ComponentType<any> }>) {
  return lazy(() =>
    load().catch(err => {
      let already = "1";
      try { already = sessionStorage.getItem(RELOADED_KEY) ?? ""; } catch { /* blocked */ }
      if (!already) {
        try { sessionStorage.setItem(RELOADED_KEY, "1"); } catch { /* blocked */ }
        window.location.reload();
        // Never resolves; the reload takes over before React renders anything
        return new Promise<never>(() => {});
      }
      throw err;
    })
  );
}

// A load that works clears the flag, so the next deploy gets its own retry
if (typeof window !== "undefined") {
  window.addEventListener("load", () => {
    try { sessionStorage.removeItem(RELOADED_KEY); } catch { /* blocked */ }
  });
}

/**
 * Routes load on demand.
 *
 * Every visitor used to download the whole app in one chunk — dashboard,
 * charts, course editor, round setup, Google sign-in. Someone opening a shared
 * scorecard needs almost none of that but paid for all of it before anything
 * appeared. Splitting here means a shared link fetches the scorecard and little
 * else.
 */
const Dashboard       = lazyRoute(() => import("@/pages/Dashboard"));
const NewRound        = lazyRoute(() => import("@/pages/NewRound"));
const Scorecard       = lazyRoute(() => import("@/pages/Scorecard"));
const Courses         = lazyRoute(() => import("@/pages/Courses"));
const SharedScorecard = lazyRoute(() => import("@/pages/SharedScorecard"));
const NotFound        = lazyRoute(() => import("@/pages/not-found"));

function AppInner() {
  useOfflineToast();
  return (
    <Router hook={useHashLocation}>
      <Switch>
        <Route path="/">
          <Suspense fallback={<RouteFallback kind="dashboard" />}><Dashboard /></Suspense>
        </Route>
        <Route path="/new-round">
          <Suspense fallback={<RouteFallback />}><NewRound /></Suspense>
        </Route>
        <Route path="/round/:id">
          <Suspense fallback={<RouteFallback kind="scorecard" />}><Scorecard /></Suspense>
        </Route>
        <Route path="/courses">
          <Suspense fallback={<RouteFallback />}><Courses /></Suspense>
        </Route>
        <Route path="/shared/:id">
          <Suspense fallback={<RouteFallback kind="scorecard" />}><SharedScorecard /></Suspense>
        </Route>
        <Route>
          <Suspense fallback={<RouteFallback />}><NotFound /></Suspense>
        </Route>
      </Switch>
    </Router>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppInner />
      <SyncStatus />
      <Toaster />
    </QueryClientProvider>
  );
}
