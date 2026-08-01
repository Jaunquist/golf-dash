import { useEffect, useState } from "react";
import { Check, CloudOff, RefreshCw, CloudUpload } from "lucide-react";
import { onSyncChange, flush, isConfigured } from "@/lib/queryClient";

/**
 * Floating sync indicator.
 *
 * Writes land in IndexedDB first and upload in the background, so without this
 * there is no way to tell whether a round has actually reached the Sheet.
 * Tapping it forces a sync rather than waiting on the 60s retry.
 *
 * Stays out of the way when everything is synced: fades to a small tick, then
 * hides. Only becomes prominent when something is genuinely pending.
 */
export default function SyncStatus() {
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine);
  const [busy, setBusy] = useState(false);
  const [justCleared, setJustCleared] = useState(false);

  useEffect(() => onSyncChange(setPending), []);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // Show a brief confirmation when the queue empties, then fade out
  useEffect(() => {
    if (pending === 0 && busy) {
      setJustCleared(true);
      const t = setTimeout(() => setJustCleared(false), 2500);
      return () => clearTimeout(t);
    }
  }, [pending, busy]);

  useEffect(() => {
    if (pending > 0) setBusy(true);
  }, [pending]);

  async function retry() {
    if (!online) return;
    setBusy(true);
    await flush();
  }

  if (!isConfigured()) return null;
  if (pending === 0 && !justCleared) return null;

  const synced = pending === 0;

  return (
    <button
      type="button"
      onClick={retry}
      disabled={synced || !online}
      aria-live="polite"
      className={[
        "fixed bottom-4 right-4 z-50 flex items-center gap-2",
        "rounded-full px-3.5 py-2 text-xs font-medium shadow-lg",
        "transition-all duration-300",
        synced
          ? "bg-emerald-600 text-white"
          : !online
            ? "bg-slate-700 text-white"
            : "bg-amber-500 text-white active:scale-95",
      ].join(" ")}
      title={
        synced ? "All rounds saved to your sheet"
        : !online ? "Offline — scores are safe on this device"
        : "Tap to sync now"
      }
    >
      {synced ? (
        <><Check size={14} /> Saved</>
      ) : !online ? (
        <><CloudOff size={14} /> {pending} waiting · offline</>
      ) : (
        <>
          <CloudUpload size={14} />
          {pending} to sync
          <RefreshCw size={12} className="opacity-70" />
        </>
      )}
    </button>
  );
}