import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { validateEnv, INVO_TOKEN, INVO_REFRESH_TOKEN } from '../env.js';
import * as invo from '../invo-client.js';
import { classify } from '../feed-classify.js';
import { parseTradeUpdates } from '../trade-updates.js';
import { loadLedger } from '../ledger.js';

/**
 * The copied trades this agent holds, from positions.json: which trader trade
 * each came from, and since when (only updates after we copied it matter).
 */
function heldTrades() {
  const entries: { baseShortId: string; mimicStartedAt: string }[] = [];
  const coinBySource = new Map<string, string>();
  try {
    for (const p of Object.values(loadLedger().open)) {
      if (!p.source.traderBaseShortId) continue;
      entries.push({ baseShortId: p.source.traderBaseShortId, mimicStartedAt: p.openedAt });
      coinBySource.set(p.source.traderBaseShortId, p.coin);
    }
  } catch (e: any) {
    return { entries, coinBySource, error: `Cannot read positions.json: ${e.message}` };
  }
  return { entries, coinBySource, error: null as string | null };
}

validateEnv();
if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);

interface WatchEntry {
  baseShortId: string;
  mimicStartedAt: string;
}

const POLL_INTERVAL = 5_000;
// Give up after this many failed polls in a row (~1 minute), so a dead login or
// network never leaves --wait-for-signal hanging forever.
const MAX_CONSECUTIVE_FAILURES = 12;
// How many seen ids to remember on disk (the feed only returns the newest 20).
const MAX_REMEMBERED = 2000;

// Seen posts/updates are kept on disk so a restart only skips what was already
// reported, instead of silently dropping everything posted while it was down.
const STATE_FILE = resolve(process.env.MONITOR_STATE_FILE ?? '.monitor-state.json');

interface State {
  seenPosts: string[];
  seenUpdates: string[];
  seenEvents: string[]; // "<baseShortId>:open" / "<baseShortId>:close" already reported
}

function loadState(): State | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return {
      seenPosts: Array.isArray(s.seenPosts) ? s.seenPosts : [],
      seenUpdates: Array.isArray(s.seenUpdates) ? s.seenUpdates : [],
      seenEvents: Array.isArray(s.seenEvents) ? s.seenEvents : [],
    };
  } catch {
    console.error(JSON.stringify({ type: 'error', source: 'state', message: `Unreadable ${STATE_FILE}; starting fresh` }));
    return null;
  }
}

function saveState(seenPosts: Set<string>, seenUpdates: Set<string>, seenEvents: Set<string>) {
  const state: State = {
    seenPosts: [...seenPosts].slice(-MAX_REMEMBERED),
    seenUpdates: [...seenUpdates].slice(-MAX_REMEMBERED),
    seenEvents: [...seenEvents].slice(-MAX_REMEMBERED),
  };
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, STATE_FILE); // atomic, so a crash mid-write can't corrupt the file
}

function ageSeconds(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.round((Date.now() - t) / 1000);
}

async function main() {
  const args = process.argv.slice(2);
  const waitMode = args.includes('--wait-for-signal');
  const jsonArgs = args.filter(a => a.startsWith('['));

  if (jsonArgs.length === 0) {
    console.error('Usage: monitor [--wait-for-signal] <portfolioIds> [watchEntries]');
    console.error('  Portfolio IDs: \'["id1","id2"]\'  (only these portfolios\' trades are reported)');
    console.error('  Watch entries: \'[{"baseShortId":"x","mimicStartedAt":"..."}]\'');
    console.error('  Both:          \'["id1"]\'  \'[{"baseShortId":"x","mimicStartedAt":"..."}]\'');
    console.error('');
    console.error('Modes:');
    console.error('  default:             Run forever, print all signals as JSON lines');
    console.error('  --wait-for-signal:   Exit after first signal (for agent auto-notify)');
    console.error('');
    console.error(`Seen posts are remembered in ${STATE_FILE} (override with MONITOR_STATE_FILE).`);
    process.exit(1);
  }

  // Parse all JSON args — separate portfolio IDs (strings) from watch entries (objects)
  let portfolioIds: string[] = [];
  let watchEntries: WatchEntry[] = [];
  for (const arg of jsonArgs) {
    const arr = JSON.parse(arg);
    if (Array.isArray(arr) && arr.length > 0) {
      if (typeof arr[0] === 'string') portfolioIds = portfolioIds.concat(arr);
      else if (arr[0]?.baseShortId) watchEntries = watchEntries.concat(arr);
    }
  }

  const isWatchEntries = watchEntries.length > 0;
  // With no portfolio IDs given, every followed trader is reported (as before).
  const portfolioFilter = portfolioIds.length > 0 ? new Set(portfolioIds) : null;

  const saved = loadState();
  const seenPosts = new Set<string>(saved?.seenPosts ?? []);
  const seenUpdates = new Set<string>(saved?.seenUpdates ?? []);
  const seenEvents = new Set<string>(saved?.seenEvents ?? []);
  // Only on the very first run (no state file yet) are existing posts and updates
  // indexed silently; after that, anything unseen is reported, even after a restart.
  let indexing = saved === null;

  let pollCount = 0;
  let feedFailures = 0;
  let tradeFailures = 0;

  const giveUp = (source: string, failures: number, message: string) => {
    console.log(JSON.stringify({
      type: 'fatal',
      source,
      consecutiveFailures: failures,
      message: `Stopping: ${failures} failed ${source} polls in a row. Last error: ${message}`,
    }));
    process.exit(2);
  };

  const poll = async (): Promise<boolean> => {
    pollCount++;
    let signalFound = false;
    let feedOk = false;

    // Poll /dex/trade for the trades we copied (from positions.json, re-read every
    // poll) plus any watch entries given on the command line. This is the only
    // place a trader's partial closes show up; the feed never posts them.
    const held = heldTrades();
    // Without positions.json we can't watch the trades we hold, so stop rather than
    // silently miss their reduces and closes.
    if (held.error) giveUp('positions', 1, held.error);
    const entries = [...watchEntries, ...held.entries.filter(e => !watchEntries.some(w => w.baseShortId === e.baseShortId))];
    if (entries.length > 0) {
      try {
        const data = await invo.getTradeUpdates(entries);
        for (const ev of parseTradeUpdates(data)) {
          if (seenUpdates.has(ev.id)) continue;
          seenUpdates.add(ev.id);
          if (ev.kind === 'ignore') continue; // TP/SL edits: nothing to copy
          if (ev.kind === 'unknown') {
            console.log(JSON.stringify({
              type: 'skipped',
              poll: pollCount,
              traderBaseShortId: ev.traderBaseShortId,
              reason: `Unrecognised trade update type "${ev.updateType}"`,
            }));
            continue;
          }
          // Report each trade's close once, whether it comes from here or the feed.
          if (ev.action === 'close') {
            const eventKey = `${ev.traderBaseShortId}:close`;
            if (seenEvents.has(eventKey)) continue;
            seenEvents.add(eventKey);
          }
          console.log(JSON.stringify({
            type: 'signal',
            source: 'trade_updates',
            poll: pollCount,
            updateId: ev.id,
            postedAt: ev.updatedAt,
            ageSeconds: ageSeconds(ev.updatedAt ?? undefined),
            action: ev.action,
            coin: held.coinBySource.get(ev.traderBaseShortId) ?? null,
            traderBaseShortId: ev.traderBaseShortId,
            ratio: ev.ratio,
            traderPositionSize: { before: ev.sizeBefore, after: ev.sizeAfter },
            closePrice: ev.closePrice,
            reasonClosed: ev.reasonClosed,
          }));
          signalFound = true;
        }
        tradeFailures = 0;
      } catch (e: any) {
        tradeFailures++;
        console.error(JSON.stringify({ type: 'error', source: 'trade', consecutiveFailures: tradeFailures, message: e.message }));
        if (tradeFailures >= MAX_CONSECUTIVE_FAILURES) giveUp('trade', tradeFailures, e.message);
      }
    }

    // Poll feed for trade signals from followed traders
    try {
      const data = await invo.getFeed('following', null, 20);
      const posts = data.items ?? [];
      for (const post of posts) {
        if (seenPosts.has(post.id)) continue;
        seenPosts.add(post.id);

        // Skip non-trade posts (photos, text, etc.)
        const update = post.update;
        if (!update || !update.ticker) continue;

        // Don't report posts that already existed on the first-ever run
        if (indexing) continue;

        // Only process verified trades
        if (!update.verifiedTrade) continue;

        // Only the requested portfolios
        if (portfolioFilter && !portfolioFilter.has(update.portfolio?.id)) continue;

        // A missing direction used to be reported as "short"; skip it instead.
        if (typeof update.directionLong !== 'boolean') {
          console.log(JSON.stringify({
            type: 'skipped',
            poll: pollCount,
            postId: post.id,
            coin: update.ticker,
            reason: 'Post has no trade direction (directionLong missing)',
          }));
          continue;
        }

        const event = classify(update);
        if (event.kind === 'ignore') continue; // TP/SL/notes edits: nothing to copy
        if (event.kind === 'unknown') {
          console.log(JSON.stringify({
            type: 'skipped',
            poll: pollCount,
            postId: post.id,
            coin: update.ticker,
            reason: `Unrecognised trade change (${event.changedFields.join(', ') || 'no fields'})`,
          }));
          continue;
        }
        const action = event.kind;
        const isOpen = update.isOpen === true;

        // Trades we copied are followed through /dex/trade (above), which also sees
        // partial closes; ignore their feed posts so nothing is reported twice.
        if (held.coinBySource.has(update.baseShortId)) continue;

        // The update fields show the trade as it is NOW, not when the post was made.
        // Don't copy an open or add-on for a trade the trader has already closed
        // (this happens when a restart catches up on older posts).
        if ((action === 'open' || action === 'increase' || action === 'reduce') && !isOpen) {
          console.log(JSON.stringify({
            type: 'skipped',
            poll: pollCount,
            postId: post.id,
            coin: update.ticker,
            reason: `"${action}" post for a trade that has since closed`,
          }));
          continue;
        }

        // Report each trade's open and close only once.
        if (action === 'open' || action === 'close') {
          const eventKey = `${update.baseShortId}:${action}`;
          if (seenEvents.has(eventKey)) continue;
          seenEvents.add(eventKey);
        }

        console.log(JSON.stringify({
          type: 'signal',
          poll: pollCount,
          postId: post.id,
          postedAt: post.createdAt ?? null,
          ageSeconds: ageSeconds(post.createdAt),
          action,
          owner: {
            id: update.owner?.id ?? post.owner?.id,
            username: update.owner?.username ?? post.owner?.username,
          },
          trade: {
            coin: update.ticker,
            name: update.name,
            side: update.directionLong ? 'long' : 'short',
            leverage: update.leverage,
            entryPrice: update.entryPrice,
            closingPrice: update.closingPrice ?? null,
            entrySize: update.entrySize,
            previousEntrySize: event.previousEntrySize ?? null,
            reasonClosed: action === 'close' ? (update.reasonClosed ?? null) : null,
            isOpen,
          },
          portfolio: {
            id: update.portfolio?.id,
            title: update.portfolio?.title,
            winRate: update.portfolio?.winRate,
            closedPositions: update.portfolio?.closedPositionsCount,
            openPositions: update.portfolio?.openPositionsCount,
            pnl: update.portfolio?.plSnapshot,
          },
          mimicMeta: {
            portfolioId: update.portfolio?.id,
            creatorInvoUserId: update.owner?.id ?? post.owner?.id,
            baseId: update.baseId,
            baseShortId: update.baseShortId,
          },
        }));
        signalFound = true;
      }
      feedOk = true;
      feedFailures = 0;
    } catch (e: any) {
      feedFailures++;
      console.error(JSON.stringify({ type: 'error', source: 'feed', consecutiveFailures: feedFailures, message: e.message }));
      if (feedFailures >= MAX_CONSECUTIVE_FAILURES) giveUp('feed', feedFailures, e.message);
    }

    // Indexing ends once the feed has been read successfully
    if (indexing && feedOk) indexing = false;

    try {
      saveState(seenPosts, seenUpdates, seenEvents);
    } catch (e: any) {
      console.error(JSON.stringify({ type: 'error', source: 'state', message: `Could not save ${STATE_FILE}: ${e.message}` }));
    }

    return signalFound;
  };

  const mode = isWatchEntries && portfolioIds.length > 0 ? 'trade_poll+feed'
    : isWatchEntries ? 'trade_poll'
    : 'feed_only';
  console.log(JSON.stringify({
    type: 'started',
    mode,
    waitForSignal: waitMode,
    watchEntries: watchEntries.length,
    portfolioIds: portfolioIds.length,
    feedFilter: portfolioFilter ? 'listed portfolios only' : 'all followed traders',
    resumedFromState: saved !== null,
    heldTradesWatched: heldTrades().entries.length,
    stateFile: STATE_FILE,
  }));

  // A restart reports anything missed while it was down, so check right away.
  while (true) {
    const found = await poll();
    if (waitMode && found) process.exit(0);
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
