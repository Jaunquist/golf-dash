/**
 * localStorage persistence for rounds data.
 * Hydrates the React Query cache instantly on page load so rounds
 * are visible even while the cold backend sandbox is waking up.
 */

const ROUNDS_KEY = "gd_rounds_v1";
const JUSTIN_ROUNDS_KEY = "gd_justin_rounds_v1";

// ── Rounds list ──────────────────────────────────────────────────────────────

export function saveRoundsList(data: unknown) {
  try {
    localStorage.setItem(ROUNDS_KEY, JSON.stringify(data));
  } catch {}
}

export function loadRoundsList(): unknown | null {
  try {
    const raw = localStorage.getItem(ROUNDS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── Justin round details ─────────────────────────────────────────────────────

export function saveJustinRounds(data: unknown) {
  try {
    localStorage.setItem(JUSTIN_ROUNDS_KEY, JSON.stringify(data));
  } catch {}
}

export function loadJustinRounds(): unknown | null {
  try {
    const raw = localStorage.getItem(JUSTIN_ROUNDS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── Remove a single round from both caches (called on delete) ────────────────

export function removeRoundFromCache(id: number) {
  try {
    const rounds = loadRoundsList();
    if (Array.isArray(rounds)) {
      saveRoundsList(rounds.filter((r: any) => r.id !== id));
    }
    const justin = loadJustinRounds();
    if (Array.isArray(justin)) {
      saveJustinRounds(justin.filter((d: any) => d.round?.id !== id));
    }
  } catch {}
}
