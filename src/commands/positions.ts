import 'dotenv/config';
import * as hl from '../hl-client.js';
import { LEDGER_FILE, loadLedger, sameSize } from '../ledger.js';

/**
 * Read-only: compare positions.json (what this agent opened) with what is actually
 * open on Hyperliquid. Run it at startup and before acting on increase/close signals.
 */
async function main() {
  const wallet = process.env.WALLET_ADDRESS ?? '';
  if (!wallet) {
    console.error('Missing WALLET_ADDRESS in .env');
    process.exit(1);
  }

  const ledger = loadLedger();
  const account = await hl.getAccountState(wallet);
  const onExchange = new Map<string, any>(account.positions.map((p: any) => [p.coin, p]));

  const agentPositions = Object.values(ledger.open).map(mine => {
    const pos = onExchange.get(mine.coin);
    const szi = pos ? parseFloat(pos.szi) : 0;
    let state: 'ok' | 'missing_on_exchange' | 'size_mismatch' | 'side_mismatch';
    if (!pos) state = 'missing_on_exchange';
    else if ((szi > 0) !== (mine.side === 'long')) state = 'side_mismatch';
    else if (!sameSize(mine.size, szi)) state = 'size_mismatch';
    else state = 'ok';
    return {
      coin: mine.coin,
      state,
      side: mine.side,
      size: mine.size,
      sizeOnExchange: pos ? pos.szi : '0',
      avgPx: mine.avgPx,
      leverage: mine.leverage,
      unrealizedPnl: pos ? parseFloat(pos.unrealizedPnl) : null,
      openedAt: mine.openedAt,
      traderBaseShortId: mine.source.traderBaseShortId,
      portfolioId: mine.source.portfolioId,
    };
  });

  // Open on the exchange but not opened by this agent: the user's own trades.
  const notAgents = account.positions
    .filter((p: any) => !ledger.open[p.coin])
    .map((p: any) => ({ coin: p.coin, size: p.szi, entryPx: p.entryPx }));

  console.log(JSON.stringify({
    ledgerFile: LEDGER_FILE,
    available: account.withdrawable,
    agentPositions,
    notAgentsPositions: notAgents,
    problems: agentPositions.filter(p => p.state !== 'ok').length,
  }, null, 2));
}

main().catch(e => { console.error(e.message); process.exit(1); });
