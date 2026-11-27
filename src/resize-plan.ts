/**
 * Work out how to scale our position along with the trader's
 * (ratio = trader's positionSizeAfter / positionSizeBefore from /dex/trade).
 *
 * The proportional change is used when it is big enough to trade. When it is
 * below Hyperliquid's minimum order, it is raised to the smallest order that is
 * accepted, so we still move with the trader, just by a larger percentage.
 * A reduce is never allowed to leave a position too small to close later
 * (closing also has to meet the minimum, because reduce-only orders can't be used).
 */
export type ResizePlan =
  | {
      action: 'add' | 'reduce';
      size: number;
      sizeWire: string;
      notionalUsd: number;
      targetSize: number;        // our size after the change
      proportionalSize: number;  // what the trader's ratio alone would give
      raisedToMinimum: boolean;  // true when size was raised to the minimum order
      ourRatio: number;          // targetSize / current size (compare with the trader's ratio)
    }
  | { action: 'none'; reason: string };

/** Smallest order value used, a little above the $10 minimum so slippage and
 *  price moves between planning and sending can't take it under. */
export const MIN_ORDER_BUFFER = 1.05;

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
  if (!(price > 0)) return { action: 'none', reason: 'No price' };
  if (Math.abs(ratio - 1) < 1e-9) return { action: 'none', reason: 'Ratio is 1: nothing to change' };

  const f = 10 ** szDecimals;
  const floorStep = (x: number) => Math.floor(x * f + 1e-9) / f;
  const ceilStep = (x: number) => Math.ceil(x * f - 1e-9) / f;

  const action = ratio > 1 ? 'add' : 'reduce';
  const proportionalSize = floorStep(Math.abs(ourSize * (ratio - 1)));
  const minOrderSize = ceilStep((minNotionalUsd * MIN_ORDER_BUFFER) / price);
  const raisedToMinimum = proportionalSize < minOrderSize;
  const size = raisedToMinimum ? minOrderSize : proportionalSize;
  const fmt = (x: number) => x.toFixed(szDecimals);

  if (action === 'reduce') {
    const remaining = ourSize - size;
    // Keep enough open to be closable later (a close is also an order subject to the minimum).
    if (remaining * price < minNotionalUsd * MIN_ORDER_BUFFER) {
      return {
        action: 'none',
        reason:
          `A reduce of ${fmt(size)} ${raisedToMinimum ? '(raised to the minimum order) ' : ''}would leave ` +
          `${fmt(Math.max(remaining, 0))} ($${(Math.max(remaining, 0) * price).toFixed(2)}), too small to close later. ` +
          `Keeping the full position until the trader closes`,
      };
    }
  }

  const targetSize = action === 'add' ? ourSize + size : ourSize - size;
  return {
    action,
    size,
    sizeWire: fmt(size),
    notionalUsd: size * price,
    targetSize,
    proportionalSize,
    raisedToMinimum,
    ourRatio: targetSize / ourSize,
  };
}
