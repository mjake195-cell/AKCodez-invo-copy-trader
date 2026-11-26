import { randomUUID } from 'crypto';
import { validateEnv, INVO_TOKEN, INVO_REFRESH_TOKEN, HL_AGENT_KEY, WALLET_ADDRESS } from '../env.js';
import * as invo from '../invo-client.js';
import * as hl from '../hl-client.js';

validateEnv();
if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);

async function currentSzi(coin: string): Promise<string> {
  const positions = await hl.getPositions(WALLET_ADDRESS);
  const pos = positions.find((p: any) => p.coin === coin);
  return pos ? pos.szi : '0';
}

async function main() {
  const [coin, baseShortId] = process.argv.slice(2);

  if (!coin) {
    console.error('Usage: close <coin> [baseShortId]');
    process.exit(1);
  }

  await hl.connect(HL_AGENT_KEY, WALLET_ADDRESS);

  // Current position
  const qtyBefore = await currentSzi(coin);
  if (parseFloat(qtyBefore) === 0) throw new Error(`No open position for ${coin}`);

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
  let qtyAfter = await currentSzi(coin);
  if (qtyAfter === qtyBefore) {
    await new Promise(r => setTimeout(r, 1000));
    qtyAfter = await currentSzi(coin);
  }
  const before = parseFloat(qtyBefore);
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

  console.log(JSON.stringify({
    status,
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
