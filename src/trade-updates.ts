/**
 * Parse Invo's POST /dex/trade response into increase / reduce / close events.
 *
 * Unlike the feed, /dex/trade reports every change to a trade, including the
 * decreases (partial closes) that are never posted to the feed. Shape, as seen live:
 *   { success, data: [ { investmentBaseShortId, updates: [
 *       { investmentId, updatedAt, updateType: 'increase' | 'decrease' | 'close' | 'tp' | 'sl',
 *         details: { positionSizeBefore, positionSizeAfter, positionSizeChange }   // increase/decrease
 *                | { closePrice, reasonClosed }                                    // close
 *                | { priceTarget } | { stopLoss } } ] } ] }
 * positionSize is the trader's position as a fraction of their portfolio, so
 * after / before is the ratio to scale our own position by.
 */

export type TradeUpdateEvent =
  | {
      kind: 'signal';
      id: string;
      action: 'increase' | 'reduce' | 'close';
      traderBaseShortId: string;
      updatedAt: string | null;
      ratio: number | null;            // positionSizeAfter / positionSizeBefore
      sizeBefore: number | null;
      sizeAfter: number | null;
      closePrice: number | null;
      reasonClosed: string | null;
    }
  | { kind: 'ignore'; id: string }      // TP / SL edits
  | { kind: 'unknown'; id: string; traderBaseShortId: string; updateType: string };

export function parseTradeUpdates(response: any): TradeUpdateEvent[] {
  const events: TradeUpdateEvent[] = [];
  for (const trade of response?.data ?? []) {
    const bsid: string = trade.investmentBaseShortId;
    for (const u of trade.updates ?? []) {
      const id: string = u.investmentId ?? `${bsid}_${u.updatedAt}_${u.updateType}`;
      const d = u.details ?? {};
      const type = String(u.updateType ?? '');

      if (type === 'tp' || type === 'sl') {
        events.push({ kind: 'ignore', id });
        continue;
      }
      if (type === 'increase' || type === 'decrease') {
        const before = Number(d.positionSizeBefore);
        const after = Number(d.positionSizeAfter);
        const ok = Number.isFinite(before) && Number.isFinite(after) && before > 0 && after >= 0;
        events.push({
          kind: 'signal',
          id,
          action: type === 'increase' ? 'increase' : 'reduce',
          traderBaseShortId: bsid,
          updatedAt: u.updatedAt ?? null,
          ratio: ok ? after / before : null,
          sizeBefore: ok ? before : null,
          sizeAfter: ok ? after : null,
          closePrice: null,
          reasonClosed: null,
        });
        continue;
      }
      if (type === 'close') {
        events.push({
          kind: 'signal',
          id,
          action: 'close',
          traderBaseShortId: bsid,
          updatedAt: u.updatedAt ?? null,
          ratio: 0,
          sizeBefore: null,
          sizeAfter: 0,
          closePrice: d.closePrice != null ? Number(d.closePrice) : null,
          reasonClosed: d.reasonClosed ?? null,
        });
        continue;
      }
      events.push({ kind: 'unknown', id, traderBaseShortId: bsid, updateType: type });
    }
  }
  return events;
}
