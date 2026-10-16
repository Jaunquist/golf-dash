/**
 * Countries, stored as ISO 3166-1 alpha-2 codes.
 *
 * The code rather than the display name, because it sorts predictably, survives
 * a change of label, and turns into a flag with arithmetic instead of a lookup
 * table or an image request.
 *
 * The list is golf destinations rather than all 195 — a dropdown you scroll
 * past 180 irrelevant entries in is worse than a short one plus a search box.
 * Add a row here if you end up playing somewhere that is missing.
 */

export interface Country { code: string; name: string }

export const COUNTRIES: Country[] = [
  { code: "PH", name: "Philippines" },
  { code: "JP", name: "Japan" },
  { code: "KR", name: "South Korea" },
  { code: "TH", name: "Thailand" },
  { code: "VN", name: "Vietnam" },
  { code: "SG", name: "Singapore" },
  { code: "MY", name: "Malaysia" },
  { code: "ID", name: "Indonesia" },
  { code: "TW", name: "Taiwan" },
  { code: "HK", name: "Hong Kong" },
  { code: "CN", name: "China" },
  { code: "IN", name: "India" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "AU", name: "Australia" },
  { code: "NZ", name: "New Zealand" },
  { code: "US", name: "United States" },
  { code: "CA", name: "Canada" },
  { code: "MX", name: "Mexico" },
  { code: "GB", name: "United Kingdom" },
  { code: "IE", name: "Ireland" },
  { code: "ES", name: "Spain" },
  { code: "PT", name: "Portugal" },
  { code: "FR", name: "France" },
  { code: "IT", name: "Italy" },
  { code: "DE", name: "Germany" },
  { code: "NL", name: "Netherlands" },
  { code: "SE", name: "Sweden" },
  { code: "ZA", name: "South Africa" },
  { code: "MA", name: "Morocco" },
  { code: "BR", name: "Brazil" },
  { code: "AR", name: "Argentina" },
];

const BY_CODE: Record<string, Country> = {};
COUNTRIES.forEach(c => { BY_CODE[c.code] = c; });

export function normalizeCountry(raw: unknown): string {
  const v = String(raw ?? "").trim().toUpperCase();
  if (!v) return "";
  if (BY_CODE[v]) return v;
  // Tolerate a full name typed or pasted into the sheet by hand
  const match = COUNTRIES.find(c => c.name.toUpperCase() === v);
  return match ? match.code : (v.length === 2 ? v : "");
}

export function countryName(code: string): string {
  const v = normalizeCountry(code);
  return BY_CODE[v]?.name ?? v;
}

/**
 * Turn "JP" into 🇯🇵.
 *
 * A flag emoji is two regional indicator symbols, which sit 0x1F1E6 above
 * 'A'. No image request, no asset to ship, and it works offline.
 *
 * Caveat: Windows does not ship flag glyphs, so Chrome on Windows renders the
 * two letters instead. That degrades to something still readable, which is why
 * this is preferred over bundling an icon set.
 */
export function flagEmoji(code: string): string {
  const v = normalizeCountry(code);
  if (v.length !== 2 || !/^[A-Z]{2}$/.test(v)) return "";
  return String.fromCodePoint(
    ...[...v].map(ch => 0x1f1e6 + ch.charCodeAt(0) - 65)
  );
}
