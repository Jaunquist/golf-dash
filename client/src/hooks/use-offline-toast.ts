import { useEffect, useRef } from "react";
import { useToast } from "@/hooks/use-toast";

/**
 * Shows a toast when the user goes offline, and a recovery toast when back online.
 * Also registers the Vite PWA virtual module to handle SW updates.
 */
export function useOfflineToast() {
  const { toast } = useToast();
  const wasOffline = useRef(false);

  useEffect(() => {
    function handleOffline() {
      wasOffline.current = true;
      toast({
        title: "You're offline",
        description: "Scores and data from your last session are still available.",
        duration: 6000,
      });
    }

    function handleOnline() {
      if (wasOffline.current) {
        wasOffline.current = false;
        toast({
          title: "Back online",
          description: "Changes will sync automatically.",
          duration: 4000,
        });
      }
    }

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, [toast]);
}
