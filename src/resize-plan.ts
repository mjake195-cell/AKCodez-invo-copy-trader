/**
 * Work out how to scale our position by the same ratio the trader scaled theirs
 * (ratio = trader's positionSizeAfter / positionSizeBefore from /dex/trade).
 * Sizes are rounded DOWN to the coin's decimals, so we never trade more than asked.
 */
export type ResizePlan =
  | { action: 'add' | 'reduce'; size: number; sizeWire: string; notionalUsd: number; targetSize: number }
  | { action: 'none'; reason: string };

export function planResize(args: {
  ourSize: number;       // what we hold now (positions.json)
  ratio: number;         // trader's after / before
  szDecimals: number;
  price: number;
  minNotionalUsd: number;
}): ResizePlan {
  const { ourSize, ratio, szDecimals, price, minNotionalUsd } = args;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return { action: 'none', reason: `Invalid ratio ${ratio}: use close.ts for a full close` };
  }
  if (!(ourSize > 0)) return { action: 'none', reason: 'No position to resize' };

  const f = 10 ** szDecimals;
  const delta = ourSize * (ratio - 1);
  const size = Math.floor(Math.abs(delta) * f + 1e-9) / f;
  const action = delta > 0 ? 'add' : 'reduce';
  const targetSize = ourSize * ratio;

  if (size <= 0) {
    return { action: 'none', reason: `Change of ${Math.abs(delta)} rounds to 0 at ${szDecimals} decimals` };
  }
  if (action === 'reduce' && size >= ourSize) {
    return { action: 'none', reason: 'Reduce would close the whole position: use close.ts' };
  }
  const notionalUsd = size * price;
  if (notionalUsd < minNotionalUsd) {
    return {
      action: 'none',
      reason: `The ${action} would be ${size.toFixed(szDecimals)} ($${notionalUsd.toFixed(2)}), ` +
        `under Hyperliquid's $${minNotionalUsd} minimum order. Position left unchanged`,
    };
  }
  return { action, size, sizeWire: size.toFixed(szDecimals), notionalUsd, targetSize };
}
