import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { resolve } from 'path';

/**
 * positions.json: the positions this agent opened, so they survive restarts and
 * context loss. trade.ts writes it on every fill, close.ts on every close, and
 * positions.ts compares it with what is actually open on Hyperliquid.
 */
export const LEDGER_FILE = resolve(process.env.POSITIONS_FILE ?? 'positions.json');

export interface Fill {
  at: string;
  size: number;
  px: number;
  clientTxId: string;
}

export interface LedgerPosition {
  coin: string;
  side: 'long' | 'short';
  size: number;      // total filled size we hold, in coin units
  avgPx: number;     // size-weighted average entry
  leverage: number;
  openedAt: string;
  updatedAt: string;
  source: {
    traderBaseShortId: string | null; // the copied trader's trade (signal.mimicMeta.baseShortId)
    portfolioId: string | null;
    creatorInvoUserId: string | null;
  };
  invoPositionRecordId: string | null;
  fills: Fill[];
}

export interface ClosedPosition extends LedgerPosition {
  closedAt: string;
  exitPx: number | null;
  closeNote: string;
}

export interface Ledger {
  open: Record<string, LedgerPosition>;
  closed: ClosedPosition[];
}

export function loadLedger(): Ledger {
  if (!existsSync(LEDGER_FILE)) return { open: {}, closed: [] };
  const data = JSON.parse(readFileSync(LEDGER_FILE, 'utf8'));
  return { open: data.open ?? {}, closed: data.closed ?? [] };
}

export function saveLedger(ledger: Ledger) {
  const tmp = `${LEDGER_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  renameSync(tmp, LEDGER_FILE); // atomic, so a crash mid-write can't corrupt it
}

/** Sizes are compared with a small tolerance for floating-point noise. */
export function sameSize(a: number, b: number): boolean {
  return Math.abs(Math.abs(a) - Math.abs(b)) < 1e-9;
}

export function recordOpenFill(
  ledger: Ledger,
  args: {
    coin: string;
    side: 'long' | 'short';
    leverage: number;
    fill: Fill;
    source: LedgerPosition['source'];
    invoPositionRecordId: string | null;
    add: boolean;
  },
) {
  const existing = ledger.open[args.coin];
  if (args.add && existing) {
    const newSize = existing.size + args.fill.size;
    existing.avgPx = (existing.avgPx * existing.size + args.fill.px * args.fill.size) / newSize;
    existing.size = newSize;
    existing.leverage = args.leverage;
    existing.updatedAt = args.fill.at;
    existing.fills.push(args.fill);
    return;
  }
  // A stale entry (its position is no longer open on the exchange) is archived first.
  if (existing) {
    ledger.closed.push({ ...existing, closedAt: args.fill.at, exitPx: null, closeNote: 'missing_on_exchange' });
  }
  ledger.open[args.coin] = {
    coin: args.coin,
    side: args.side,
    size: args.fill.size,
    avgPx: args.fill.px,
    leverage: args.leverage,
    openedAt: args.fill.at,
    updatedAt: args.fill.at,
    source: args.source,
    invoPositionRecordId: args.invoPositionRecordId,
    fills: [args.fill],
  };
}

export function recordClose(ledger: Ledger, coin: string, exitPx: number | null, note: string, at: string) {
  const pos = ledger.open[coin];
  if (!pos) return;
  ledger.closed.push({ ...pos, closedAt: at, exitPx, closeNote: note });
  delete ledger.open[coin];
}
