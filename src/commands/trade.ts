import { randomUUID } from 'crypto';
import { validateEnv, INVO_TOKEN, INVO_REFRESH_TOKEN, HL_AGENT_KEY, WALLET_ADDRESS } from '../env.js';
import * as invo from '../invo-client.js';
import * as hl from '../hl-client.js';
import { existingPositionRefusal } from '../position-guard.js';
import { LEDGER_FILE, loadLedger, recordOpenFill, sameSize, saveLedger, type Ledger } from '../ledger.js';

validateEnv();
if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);

const SLIPPAGE = 0.02;        // must match the slippage passed to placeMarketOrder
const MIN_NOTIONAL_USD = 10;  // Hyperliquid rejects orders below $10
const MARGIN_BUFFER = 1.02;   // headroom for fees and price movement

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Round down to the coin's allowed decimals (never round up into a bigger order). */
function roundDown(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.floor(value * f + 1e-9) / f;
}

/** Find the Invo-issued baseShortId anywhere in Invo's response, if it sent one. */
function findBaseShortId(obj: any): string | null {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.baseShortId === 'string') return obj.baseShortId;
  for (const v of Object.values(obj)) {
    const found = findBaseShortId(v);
    if (found) return found;
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  // --add: add to a position this agent opened (for copying an "increase").
  // Without it, any coin that already has an open position is refused.
  const addMode = argv.includes('--add');
  // --source=<baseShortId>: the copied trader's trade (signal.mimicMeta.baseShortId),
  // saved in positions.json so later increase/close signals can be matched to it.
  const sourceArg = argv.find(a => a.startsWith('--source='));
  const traderBaseShortId = sourceArg ? sourceArg.slice('--source='.length) || null : null;
  const unknownFlag = argv.find(a => a.startsWith('--') && a !== '--add' && !a.startsWith('--source='));
  if (unknownFlag) fail(`Unknown option ${unknownFlag}`);
  const [coin, side, sizeStr, leverageStr, mimicMetaJson] = argv.filter(a => !a.startsWith('--'));

  if (!coin || !side || !sizeStr) {
    fail('Usage: trade <coin> <long|short> <size> [leverage] [mimicMetaJson] [--add] [--source=<traderBaseShortId>]');
  }

  // Read positions.json before anything else, so a damaged file stops us before trading.
  let ledger: Ledger;
  try {
    ledger = loadLedger();
  } catch (e: any) {
    fail(`Cannot read ${LEDGER_FILE}: ${e.message}. Fix or restore it before trading.`);
  }

  // --- Validate everything before touching the exchange ---

  // Only an exact "long" or "short" is accepted (anything else used to become a short).
  if (side !== 'long' && side !== 'short') {
    fail(`Invalid side "${side}": must be exactly "long" or "short"`);
  }
  const isBuy = side === 'long';

  // Leverage must be a whole number (no "5x", "2.5" or junk).
  const leverageInput = leverageStr ?? '1';
  if (!/^\d+$/.test(leverageInput) || parseInt(leverageInput, 10) < 1) {
    fail(`Invalid leverage "${leverageInput}": must be a whole number of at least 1`);
  }
  const leverage = parseInt(leverageInput, 10);

  const requestedSize = Number(sizeStr);
  if (!Number.isFinite(requestedSize) || requestedSize <= 0) {
    fail(`Invalid size "${sizeStr}": must be a positive number of ${coin} (coin units, not USD)`);
  }

  let mimicMeta: any;
  if (mimicMetaJson) {
    try {
      mimicMeta = JSON.parse(mimicMetaJson);
    } catch {
      fail('Invalid mimicMetaJson: not valid JSON');
    }
  }

  await hl.connect(HL_AGENT_KEY, WALLET_ADDRESS);

  const meta = await hl.getMeta();
  const assetIndex = meta.universe.findIndex(a => a.name === coin);
  if (assetIndex < 0) fail(`Unknown coin: ${coin}`);
  const asset = meta.universe[assetIndex];

  if (leverage > asset.maxLeverage) {
    fail(`Leverage ${leverage}x exceeds ${coin}'s maximum of ${asset.maxLeverage}x`);
  }

  // Round size down to the decimals Hyperliquid accepts for this coin.
  const size = roundDown(requestedSize, asset.szDecimals);
  if (size <= 0) {
    fail(`Size ${sizeStr} rounds to 0 at ${coin}'s ${asset.szDecimals} decimals`);
  }
  const sizeWire = size.toFixed(asset.szDecimals);

  const mids = await hl.getAllMids();
  const mid = parseFloat(mids[coin]);
  if (!mid) fail(`No mid price for ${coin}`);
  const worstPx = isBuy ? mid * (1 + SLIPPAGE) : mid * (1 - SLIPPAGE);

  const notional = size * mid;
  if (notional < MIN_NOTIONAL_USD) {
    fail(`Order is $${notional.toFixed(2)} (${sizeWire} ${coin} at $${mid}); Hyperliquid's minimum is $${MIN_NOTIONAL_USD}`);
  }

  // Margin check. Only the part of the order that adds exposure needs new margin:
  // an order against an existing opposite position first reduces it.
  const account = await hl.getAccountState(WALLET_ADDRESS);
  const existing = account.positions.find((p: any) => p.coin === coin);
  const qtyBefore: string = existing ? existing.szi : '0';
  const sziBefore = parseFloat(qtyBefore);

  // Never touch a position that's already open (e.g. the user's own manual trade)
  // unless explicitly adding to it, and even then only in the same direction.
  const refusal = existingPositionRefusal(coin, side, sziBefore, addMode);
  if (refusal) fail(refusal);

  // --add is only for positions this agent opened (recorded in positions.json).
  if (addMode) {
    const mine = ledger.open[coin];
    if (!mine) {
      fail(`Refusing --add: the open ${coin} position is not one this agent opened (not in ${LEDGER_FILE})`);
    }
    if (mine.side !== side) {
      fail(`Refusing --add: this agent's ${coin} position is ${mine.side}, not ${side}`);
    }
    if (!sameSize(mine.size, sziBefore)) {
      fail(
        `Refusing --add: ${coin} on the exchange is ${Math.abs(sziBefore)}, but this agent opened ${mine.size}. ` +
        `Someone else changed it; check with the user`,
      );
    }
  }

  const sziAfter = sziBefore + (isBuy ? size : -size);
  const sameDirection = sziBefore !== 0 && Math.sign(sziAfter) === Math.sign(sziBefore);
  const addedExposure = Math.max(0, Math.abs(sziAfter) - (sameDirection ? Math.abs(sziBefore) : 0));
  const marginNeeded = (addedExposure * worstPx / leverage) * MARGIN_BUFFER;
  if (marginNeeded > account.withdrawable) {
    fail(
      `Not enough margin: ${sizeWire} ${coin} at ${leverage}x needs about $${marginNeeded.toFixed(2)}, ` +
      `but only $${account.withdrawable.toFixed(2)} is available`,
    );
  }

  // --- Exchange actions start here ---

  // Throws if Hyperliquid rejects the change, so no order goes out at the old leverage.
  await hl.setLeverage(coin, leverage);

  const nonceMs = Date.now();
  const orderResult = await hl.placeMarketOrder(coin, isBuy, sizeWire, SLIPPAGE);

  // Report what actually happened instead of always "filled".
  const outcome = hl.parseOrderOutcome(orderResult);
  if (outcome.kind !== 'filled') {
    console.log(JSON.stringify({
      status: outcome.kind === 'resting' ? 'not_filled' : 'rejected',
      coin,
      side,
      size: sizeWire,
      leverage,
      reason: outcome.kind === 'error' ? outcome.error : 'IOC order did not fill',
      hlResult: orderResult,
    }));
    process.exitCode = 1;
    return;
  }

  const status = outcome.filledSz < size ? 'partially_filled' : 'filled';
  const clientTxId = randomUUID();
  const realMimicMeta = mimicMeta ?? null; // only the caller's values identify the trader

  // Record the fill in positions.json FIRST, before any further network call that
  // could fail (e.g. a rate limit), so a filled position is never left unrecorded.
  // A failure here doesn't undo the trade, so it is reported loudly, not thrown.
  let ledgerError: string | null = null;
  try {
    recordOpenFill(ledger, {
      coin,
      side,
      leverage,
      add: addMode,
      fill: { at: new Date().toISOString(), size: outcome.filledSz, px: outcome.avgPx, clientTxId },
      source: {
        traderBaseShortId,
        portfolioId: realMimicMeta?.portfolioId ?? null,
        creatorInvoUserId: realMimicMeta?.creatorInvoUserId ?? null,
      },
      invoPositionRecordId: null,
    });
    saveLedger(ledger);
  } catch (e: any) {
    ledgerError = `Position is open but was NOT saved to ${LEDGER_FILE}: ${e.message}`;
    process.exitCode = 1;
  }

  // Read the position back (best-effort; if that fails, work it out from the fill).
  let qtyAfter: string;
  try {
    const posAfter = await hl.getPositions(WALLET_ADDRESS);
    const updated = posAfter.find((p: any) => p.coin === coin);
    qtyAfter = updated ? updated.szi : '0';
  } catch {
    qtyAfter = (sziBefore + (isBuy ? outcome.filledSz : -outcome.filledSz)).toFixed(asset.szDecimals);
  }
  if (!mimicMeta) {
    mimicMeta = {
      portfolioId: randomUUID(),
      creatorInvoUserId: randomUUID(),
      initialSourcePaperUpdateId: randomUUID(),
      sourcePaperTradeBaseId: randomUUID(),
    };
  }

  // Record on Invo (non-fatal if it fails — position is open on HL regardless)
  let invoResult: any = null;
  try {
    invoResult = await invo.recordOpen({
      clientTxId,
      coin,
      assetIndex,
      entry: {
        side,
        marginMode: 'isolated',
        leverage,
        tpPx: null,
        slPx: null,
      },
      submission: {
        hlOrder: orderResult,
        nonceMs,
        hlResponse: orderResult,
      },
      summary: {
        qtyBefore,
        qtyAfter,
        intendedLeverage: leverage,
      },
      mimicMeta,
    });
  } catch (e: any) {
    invoResult = { error: e.message };
  }

  // The old locally generated id was never sent to Invo, so Invo couldn't know it.
  // Use the id Invo returns; if it returns none, this is null and close.ts should be
  // run without one (Invo then detects the close on its own).
  const baseShortId = findBaseShortId(invoResult);

  // Add Invo's record id to the saved position (best-effort).
  const invoRecordId = invoResult?.data?.positionRecordId ?? null;
  if (!ledgerError && invoRecordId && !ledger.open[coin].invoPositionRecordId) {
    try {
      ledger.open[coin].invoPositionRecordId = invoRecordId;
      saveLedger(ledger);
    } catch { /* the position itself is already recorded */ }
  }

  console.log(JSON.stringify({
    status,
    ledgerError,
    coin,
    side,
    requestedSize: sizeStr,
    size: sizeWire,
    filledSize: outcome.filledSz,
    avgPx: outcome.avgPx,
    leverage,
    baseShortId,
    clientTxId,
    qtyBefore,
    qtyAfter,
    hlResult: orderResult,
    invoResult,
  }));
}

// Exit once output is flushed: the Hyperliquid SDK leaves connections open that
// would otherwise keep the process running after it has finished.
main()
  .then(() => process.stdout.write("", () => process.exit()))
  .catch(e => { console.error(e.message); process.exit(1); });
