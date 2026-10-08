import { lazy, Suspense } from "react";
import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { useOfflineToast } from "@/hooks/use-offline-toast";
import SyncStatus from "@/components/SyncStatus";
import RouteFallback from "@/components/RouteFallback";

/**
 * Routes load on demand.
 *
 * Every visitor used to download the whole app in one chunk — dashboard,
 * charts, course editor, round setup, Google sign-in. Someone opening a shared
 * scorecard needs almost none of that but paid for all of it before anything
 * appeared. Splitting here means a shared link fetches the scorecard and little
 * else.
 */
const Dashboard       = lazy(() => import("@/pages/Dashboard"));
const NewRound        = lazy(() => import("@/pages/NewRound"));
const Scorecard       = lazy(() => import("@/pages/Scorecard"));
const Courses         = lazy(() => import("@/pages/Courses"));
const SharedScorecard = lazy(() => import("@/pages/SharedScorecard"));
const NotFound        = lazy(() => import("@/pages/not-found"));

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
