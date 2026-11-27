/**
 * Decide whether trade.ts may place an order given the position already open in
 * that coin. Returns a refusal message, or null if the order may go ahead.
 *
 * - No --add: only allowed when there is no open position in the coin, so an
 *   existing position (e.g. the user's own manual trade) is never changed.
 * - --add: only allowed when a position is open in the SAME direction, so it can
 *   grow a copied position but never reduce or flip one.
 */
export function existingPositionRefusal(
  coin: string,
  side: 'long' | 'short',
  sziBefore: number,
  addMode: boolean,
): string | null {
  const isBuy = side === 'long';
  const openSide = sziBefore > 0 ? 'long' : 'short';

  if (!addMode) {
    if (sziBefore === 0) return null;
    return (
      `Refusing: there is already an open ${openSide} of ${Math.abs(sziBefore)} ${coin}. ` +
      `trade.ts won't change an existing position. To add to a position this agent copied, pass --add`
    );
  }

  if (sziBefore === 0) return `Refusing --add: there is no open ${coin} position to add to`;
  if ((sziBefore > 0) !== isBuy) {
    return `Refusing --add: the open ${coin} position is ${openSide}, so a ${side} would reduce or flip it instead of adding`;
  }
  return null;
}
