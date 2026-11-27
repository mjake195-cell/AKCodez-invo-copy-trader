import 'dotenv/config';
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import * as hl from '../hl-client.js';
import { LEDGER_FILE, loadLedger, saveLedger } from '../ledger.js';
import { planResize } from '../resize-plan.js';

/**
 * resize <coin> <ratio> [--dry-run]
 *
 * Copy a trader's increase or reduce: scale the position this agent opened in
 * <coin> by <ratio> (the signal's ratio = trader's position after / before).
 * An increase runs trade.ts --add; a reduce runs close.ts --size=…, so every
 * safety check in those commands still applies. --dry-run only prints the plan.
 */
const MIN_NOTIONAL_USD = 10;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  // --update=<updateId>: the signal's updateId. Each one is applied at most once,
  // so a retry or a repeated signal can never double an increase or a reduce.
  const updateArg = argv.find(a => a.startsWith('--update='));
  const updateId = updateArg ? updateArg.slice('--update='.length) || null : null;
  const unknownFlag = argv.find(a => a.startsWith('--') && a !== '--dry-run' && !a.startsWith('--update='));
  if (unknownFlag) fail(`Unknown option ${unknownFlag}`);
  const [coin, ratioStr] = argv.filter(a => !a.startsWith('--'));
  if (!coin || !ratioStr) {
    fail('Usage: resize <coin> <ratio> [--update=<updateId>] [--dry-run]   (ratio = trader position after / before)');
  }
  const ratio = Number(ratioStr);

  let mine;
  try {
    mine = loadLedger().open[coin];
  } catch (e: any) {
    fail(`Cannot read ${LEDGER_FILE}: ${e.message}. Fix or restore it first.`);
  }
  if (!mine) fail(`Refusing: no ${coin} position opened by this agent in ${LEDGER_FILE}`);
  if (updateId && (mine.appliedUpdates ?? []).includes(updateId)) {
    fail(`Refusing: update ${updateId} was already applied to ${coin}. Not resizing again`);
  }

  const meta = await hl.getMeta();
  const asset = meta.universe.find(a => a.name === coin);
  if (!asset) fail(`Unknown coin: ${coin}`);
  const price = parseFloat((await hl.getAllMids())[coin]);
  if (!price) fail(`No mid price for ${coin}`);

  const plan = planResize({ ourSize: mine.size, ratio, szDecimals: asset.szDecimals, price, minNotionalUsd: MIN_NOTIONAL_USD });
  console.log(JSON.stringify({
    type: 'resize_plan',
    coin,
    side: mine.side,
    ratio,
    currentSize: mine.size,
    price,
    dryRun,
    ...plan,
  }));

  if (dryRun) return;
  // Nothing tradeable (e.g. under the $10 minimum): count the update as handled,
  // so it isn't retried, and leave the position as it is.
  if (plan.action === 'none') {
    markApplied(coin, updateId);
    return;
  }

  // Hand off to the command that does it, with all its checks.
  const dir = dirname(process.argv[1]);
  const childArgs = plan.action === 'add'
    ? [join(dir, 'trade.ts'), coin, mine.side, plan.sizeWire, String(mine.leverage), '--add']
    : [join(dir, 'close.ts'), coin, `--size=${plan.sizeWire}`];
  const child = spawnSync('npx', ['tsx', ...childArgs], { stdio: 'inherit', env: process.env });
  process.exitCode = child.status ?? 1;
  // Record the update once an order went out (even a partial fill), so a retry
  // can't add or reduce a second time. A plain refusal (nothing traded) isn't recorded.
  if (child.status === 0 || tradedSomething(coin, mine.size)) markApplied(coin, updateId);
}

/** Did the position size change (the child traded, even if it then reported a problem)? */
function tradedSomething(coin: string, sizeBefore: number): boolean {
  try {
    const now = loadLedger().open[coin];
    return !now || Math.abs(now.size - sizeBefore) > 1e-12;
  } catch {
    return true; // can't tell: safer to treat it as applied than to risk a repeat
  }
}

function markApplied(coin: string, updateId: string | null) {
  if (!updateId) return;
  try {
    const ledger = loadLedger(); // re-read: the child command has updated it
    const pos = ledger.open[coin];
    if (!pos) return;
    pos.appliedUpdates = [...(pos.appliedUpdates ?? []), updateId];
    saveLedger(ledger);
  } catch (e: any) {
    console.error(`Warning: could not record update ${updateId} in ${LEDGER_FILE}: ${e.message}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => process.stdout.write('', () => process.exit()))
  .catch(e => { console.error(e.message); process.exit(1); });
