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
export declare const SOUL_ENTRY_SEPARATOR = " \u2016 ";
/** Text of one soul entry for the revision ledger and the injector. */
export declare function soulEntryText(entry: unknown): string;
/** Split a seeded soul row into its label ("Working style: ") and entries. */
export declare function splitSoulRow(text: string): {
    label: string;
    entries: string[];
};
/**
 * Render a soul row within `cap` characters by showing whole entries, starting
 * at a position chosen by `seed` and wrapping, so successive renders with
 * different seeds walk the whole section. A single entry longer than the cap
 * is cut, as before. Rows with one entry render as plain truncation.
 */
export declare function windowSoulText(text: string, cap: number, seed: number): string;
