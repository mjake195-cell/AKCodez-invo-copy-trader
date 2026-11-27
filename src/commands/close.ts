import { randomUUID } from 'crypto';
import { validateEnv, INVO_TOKEN, INVO_REFRESH_TOKEN, HL_AGENT_KEY, WALLET_ADDRESS } from '../env.js';
import * as invo from '../invo-client.js';
import * as hl from '../hl-client.js';
import { LEDGER_FILE, loadLedger, recordClose, sameSize, saveLedger, type Ledger } from '../ledger.js';

validateEnv();
if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);

async function currentSzi(coin: string): Promise<string> {
  const positions = await hl.getPositions(WALLET_ADDRESS);
  const pos = positions.find((p: any) => p.coin === coin);
  return pos ? pos.szi : '0';
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function saveOrReport(ledger: Ledger): string | null {
  try {
    saveLedger(ledger);
    return null;
  } catch (e: any) {
    process.exitCode = 1;
    return `Could not update ${LEDGER_FILE}: ${e.message}`;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  // --force: close a position this agent did not open, or whose size someone else
  // changed. Only when the user explicitly asks for it.
  const force = argv.includes('--force');
  const unknownFlag = argv.find(a => a.startsWith('--') && a !== '--force');
  if (unknownFlag) fail(`Unknown option ${unknownFlag}`);
  const [coin, baseShortId] = argv.filter(a => !a.startsWith('--'));

  if (!coin) fail('Usage: close <coin> [baseShortId] [--force]');

  let ledger: Ledger;
  try {
    ledger = loadLedger();
  } catch (e: any) {
    fail(`Cannot read ${LEDGER_FILE}: ${e.message}. Fix or restore it first.`);
  }
  const mine = ledger.open[coin];

  await hl.connect(HL_AGENT_KEY, WALLET_ADDRESS);

  // Current position
  const qtyBefore = await currentSzi(coin);
  if (parseFloat(qtyBefore) === 0) {
    if (mine) {
      // We recorded it, but it's gone: liquidated, or closed outside this agent.
      recordClose(ledger, coin, null, 'missing_on_exchange', new Date().toISOString());
      const ledgerError = saveOrReport(ledger);
      console.log(JSON.stringify({
        status: 'already_closed',
        coin,
        reason: `No open ${coin} position on the exchange, though this agent opened ${mine.size}. ` +
          `It was probably liquidated or closed outside this agent; removed from ${LEDGER_FILE}`,
        ledgerError,
      }));
      process.exitCode = 1;
      return;
    }
    throw new Error(`No open position for ${coin}`);
  }

  // Only close what this agent opened, unchanged.
  if (!force) {
    if (!mine) {
      fail(
        `Refusing: the open ${coin} position (${qtyBefore}) is not one this agent opened ` +
        `(not in ${LEDGER_FILE}). It may be the user's own trade. Use --force only if the user asks`,
      );
    }
    if (!sameSize(mine.size, parseFloat(qtyBefore)) || (parseFloat(qtyBefore) > 0) !== (mine.side === 'long')) {
      fail(
        `Refusing: ${coin} on the exchange is ${qtyBefore}, but this agent opened a ${mine.side} of ${mine.size}. ` +
        `Someone else changed it, and closing would close their part too. Use --force only if the user asks`,
      );
    }
  }

  // Resolve asset index
  const meta = await hl.getMeta();
  const assetIndex = meta.universe.findIndex(a => a.name === coin);
  if (assetIndex < 0) throw new Error(`Unknown coin: ${coin}`);

  // Close on HL
  const nonceMs = Date.now();
  const closeResult = await hl.closePosition(coin, WALLET_ADDRESS);

  // Report what actually happened instead of always "closed".
  const outcome = hl.parseOrderOutcome(closeResult);
  if (outcome.kind !== 'filled') {
    console.log(JSON.stringify({
      status: outcome.kind === 'resting' ? 'not_filled' : 'rejected',
      coin,
      qtyBefore,
      qtyAfter: qtyBefore,
      reason: outcome.kind === 'error' ? outcome.error : 'IOC order did not fill',
      hlResult: closeResult,
    }));
    process.exitCode = 1;
    return;
  }

  // Read the position back. If it still shows the old size, give Hyperliquid a
  // moment to update and read it once more.
  // If reading it back fails (e.g. a rate limit), work it out from the fill instead,
  // so positions.json is still updated.
  const before = parseFloat(qtyBefore);
  let qtyAfter: string;
  try {
    qtyAfter = await currentSzi(coin);
    if (qtyAfter === qtyBefore) {
      await new Promise(r => setTimeout(r, 1000));
      qtyAfter = await currentSzi(coin);
    }
  } catch {
    const remaining = before - Math.sign(before) * outcome.filledSz;
    qtyAfter = Math.abs(remaining) < 1e-9 ? '0' : String(remaining);
  }
  const after = parseFloat(qtyAfter);

  let status: 'closed' | 'partially_closed' | 'flipped';
  if (after === 0) status = 'closed';
  else if (Math.sign(after) === Math.sign(before)) status = 'partially_closed';
  else status = 'flipped'; // the position changed between reading it and closing it

  // Record on Invo (best-effort — Invo auto-detects HL closes). Only a full close is
  // recorded, so Invo never shows a position as closed while part of it is still open.
  let invoResult: any = null;
  if (baseShortId && status === 'closed') {
    try {
      invoResult = await invo.recordClose({
        clientTxId: randomUUID(),
        baseShortId,
        assetIndex,
        submission: {
          hlOrder: closeResult,
          nonceMs,
          hlResponse: closeResult,
        },
        summary: {
          qtyBefore,
          qtyAfter,
        },
      });
    } catch (e: any) {
      invoResult = { error: e.message };
    }
  }

  // Keep positions.json in step with what's left on the exchange.
  const now = new Date().toISOString();
  if (status === 'closed' || status === 'flipped') {
    recordClose(ledger, coin, outcome.avgPx, status === 'closed' ? (force && !mine ? 'forced' : 'closed') : 'flipped', now);
  } else if (mine) {
    mine.size = Math.abs(after);
    mine.updatedAt = now;
  }
  const ledgerError = saveOrReport(ledger);

  console.log(JSON.stringify({
    status,
    ledgerError,
    coin,
    qtyBefore,
    qtyAfter,
    filledSize: outcome.filledSz,
    avgPx: outcome.avgPx,
    hlResult: closeResult,
    invoResult,
  }));

  // Anything other than a full close needs attention.
  if (status !== 'closed') process.exitCode = 1;
}

// Exit once output is flushed: the Hyperliquid SDK leaves connections open that
// would otherwise keep the process running after it has finished.
main()
  .then(() => process.stdout.write("", () => process.exit()))
  .catch(e => { console.error(e.message); process.exit(1); });
