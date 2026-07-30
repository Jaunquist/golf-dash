import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import Dashboard from "@/pages/Dashboard";
import NewRound from "@/pages/NewRound";
import Scorecard from "@/pages/Scorecard";
import Courses from "@/pages/Courses";
import SharedScorecard from "@/pages/SharedScorecard";
import NotFound from "@/pages/not-found";
import { useOfflineToast } from "@/hooks/use-offline-toast";

function AppInner() {
  useOfflineToast();
  return (
    <Router hook={useHashLocation}>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/new-round" component={NewRound} />
        <Route path="/round/:id" component={Scorecard} />
        <Route path="/courses" component={Courses} />
        <Route path="/shared/:id" component={SharedScorecard} />
        <Route component={NotFound} />
      </Switch>
    </Router>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppInner />
      <Toaster />
    </QueryClientProvider>
  );
}
