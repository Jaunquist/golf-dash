/**
 * The flag that replaces the generic pin beside a course.
 *
 * Renders the emoji where the platform has one. Windows has no flag glyphs, so
 * Chrome there falls back to the two letters — handled explicitly as a small
 * monospace badge rather than left to the browser's tofu, so it still looks
 * deliberate. A course with no country keeps the neutral pin.
 */

import { Flag } from "lucide-react";
import { flagEmoji, countryName, normalizeCountry } from "@/lib/countries";

export default function CountryFlag({
  code,
  size = 16,
  showCode = false,
}: { code?: string | null; size?: number; showCode?: boolean }) {
  const cc = normalizeCountry(code);

  if (!cc) {
    return (
      <Flag
        size={size}
        className="text-muted-foreground/50 shrink-0"
        aria-label="No country set"
      />
    );
  }

  const emoji = flagEmoji(cc);
  const label = countryName(cc);

  return (
    <span className="inline-flex items-center gap-1 shrink-0" title={label}>
      {emoji ? (
        <span
          role="img"
          aria-label={label}
          // Flag glyphs sit small in most fonts; nudge up to match the icons
          // they stand in for
          style={{ fontSize: size * 1.15, lineHeight: 1 }}
          className="select-none"
        >
          {emoji}
        </span>
      ) : (
        <span
          aria-label={label}
          style={{ fontSize: size * 0.62 }}
          className="font-mono font-bold tracking-tight px-1 py-0.5 rounded
                     bg-muted text-muted-foreground leading-none"
        >
          {cc}
        </span>
      )}
      {showCode && (
        <span className="text-[10px] text-muted-foreground tabular">{cc}</span>
      )}
    </span>
  );
}
