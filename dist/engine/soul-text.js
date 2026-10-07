/**
 * Soul text helpers shared by the soul writer (soul.ts) and the context
 * injector (graph-context.ts). Kept dependency-free so either side can import
 * it without a cycle.
 *
 * Why (2026-10-07): a seeded Tier-0 soul row is one string holding a whole
 * section. The rows were joined with "; ", which entries also contain, and
 * the injector cut each row at its character cap. With 20 entries in a
 * section, only the first entry ever reached the model, every turn, for
 * months. The separator below cannot occur inside an entry, and
 * windowSoulText rotates whole entries through the cap so every entry
 * surfaces over a session.
 */
/** Separator between entries inside a seeded Tier-0 soul row. */
export const SOUL_ENTRY_SEPARATOR = " ‖ ";
/** Text of one soul entry for the revision ledger and the injector. */
export function soulEntryText(entry) {
    if (typeof entry === "string")
        return entry;
    if (entry && typeof entry === "object") {
        const o = entry;
        if (typeof o.value === "string")
            return o.value; // earned_values
        if (typeof o.dimension === "string")
            return o.dimension; // emotional_dimensions
    }
    return JSON.stringify(entry);
}
/** Rows seeded before the separator existed were joined with "; ". Entries
 *  start with a capital letter and the clauses inside an entry almost never
 *  do, so this recovers entry boundaries well enough to rotate legacy rows
 *  until the next evolution re-seeds them. */
const LEGACY_SPLIT = /; (?=[A-Z])/;
/** Split a seeded soul row into its label ("Working style: ") and entries. */
export function splitSoulRow(text) {
    const idx = text.indexOf(": ");
    const label = idx >= 0 ? text.slice(0, idx + 2) : "";
    const body = idx >= 0 ? text.slice(idx + 2) : text;
    const entries = body.includes(SOUL_ENTRY_SEPARATOR)
        ? body.split(SOUL_ENTRY_SEPARATOR)
        : body.split(LEGACY_SPLIT);
    return { label, entries: entries.map(e => e.trim()).filter(Boolean) };
}
/**
 * Render a soul row within `cap` characters by showing whole entries, starting
 * at a position chosen by `seed` and wrapping, so successive renders with
 * different seeds walk the whole section. A single entry longer than the cap
 * is cut, as before. Rows with one entry render as plain truncation.
 */
export function windowSoulText(text, cap, seed) {
    if (text.length <= cap)
        return text;
    const { label, entries } = splitSoulRow(text);
    const n = entries.length;
    if (n <= 1)
        return text.slice(0, cap) + "...";
    const start = ((Math.floor(seed) % n) + n) % n;
    const picked = [];
    let used = label.length;
    for (let k = 0; k < n; k++) {
        const i = (start + k) % n;
        const marker = `(${i + 1}/${n}) `;
        const piece = marker + entries[i];
        const sep = picked.length ? SOUL_ENTRY_SEPARATOR.length : 0;
        if (used + sep + piece.length <= cap) {
            picked.push({ i, t: piece });
            used += sep + piece.length;
            continue;
        }
        if (picked.length === 0) {
            // The first entry alone does not fit: cut it, but keep its marker.
            picked.push({ i, t: piece.slice(0, Math.max(0, cap - label.length - 3)) + "..." });
        }
        break;
    }
    return label + picked.map(p => p.t).join(SOUL_ENTRY_SEPARATOR);
}
