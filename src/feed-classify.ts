// Fields whose change is only an edit to the trade's targets or text, not a trade.
const EDIT_ONLY_FIELDS = new Set(['priceTarget', 'stopLoss', 'notes', 'reasonForSelling', 'holdPercent', 'holdTimeUnit']);

export type TradeEvent =
  | { kind: 'open' | 'close'; previousEntrySize?: undefined }
  | { kind: 'increase' | 'reduce'; previousEntrySize: number | null }
  | { kind: 'ignore' }
  | { kind: 'unknown'; changedFields: string[] };

/**
 * Work out what a feed post means from `update.changes`, which holds the OLD
 * values of the fields that changed in that post (checked against the live feed):
 *   { isAdded: false }                       -> the trade was just posted (open)
 *   { isOpen: true, reasonClosed: null }     -> the trade went from open to closed
 *   { entrySize: <old>, simIncrease: true }  -> the trader added to the position
 *   { priceTarget: <old> } / { stopLoss: <old> } -> TP/SL edit, nothing to copy
 */
export function classify(update: any): TradeEvent {
  const changes = update.changes ?? {};
  const fields = Object.keys(changes);

  if ('isAdded' in changes) return { kind: 'open' };
  if (changes.isOpen === true) return { kind: 'close' };
  if ('entrySize' in changes) {
    const previous = Number(changes.entrySize);
    const previousEntrySize = Number.isFinite(previous) ? previous : null;
    if (changes.simIncrease === true) return { kind: 'increase', previousEntrySize };
    if (changes.simIncrease === false) return { kind: 'reduce', previousEntrySize };
    return { kind: 'unknown', changedFields: fields };
  }
  if (fields.length > 0 && fields.every(f => EDIT_ONLY_FIELDS.has(f))) return { kind: 'ignore' };
  return { kind: 'unknown', changedFields: fields };
}
