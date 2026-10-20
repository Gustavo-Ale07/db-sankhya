/**
 * VERIFY stage of the mutation lifecycle (Task 11.2b). After the writes, every target is read
 * back by its primary key and compared field by field with the value the plan meant to write.
 * The labels are honest: VERIFIED only when every step ran and every target matched.
 */
import type { CriteriaParamType, SankhyaClient } from '@dbx/sankhya-client';

export type VerificationLabel = 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'UNVERIFIED' | 'FAILED';
export type StepOutcome = 'ok' | 'error' | 'not_attempted' | 'unknown';

export interface ExecutionStep {
  key: Record<string, unknown>;
  outcome: StepOutcome;
  errorCode?: string;
  /** true: read back and every field matched; false: a mismatch or a missing row; absent: not read. */
  verified?: boolean;
  /** The row before the change, restricted to the `expected` fields; null for an INSERT. */
  before?: Record<string, unknown> | null;
  /** What the plan meant to write: the fields it set, with their intended values. */
  expected?: Record<string, unknown>;
  /**
   * The same fields as the server read them back after the write. Only ever from the real
   * read-back (never copied from `expected`); absent when the row could not be read or is gone.
   */
  observed?: Record<string, unknown>;
}

export interface ExecutionReport {
  status: 'success' | 'partial' | 'failed';
  verification: VerificationLabel;
  steps: ExecutionStep[];
}

/** Keys per loadRecords call: small enough for any gateway page and criteria length. */
const VERIFY_CHUNK = 20;
/** Pages read per chunk at most; more means the criteria matched unexpected rows. */
const MAX_PAGES = 5;
const NUMERIC = /^-?\d+(\.\d+)?$/;
const EPSILON = 1e-9;

/** A gateway cell as a comparable scalar: `{}` (an empty element) and undefined are null. */
function cell(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return null;
  return v;
}

/**
 * Whether the value read back equals the value that was written. Gateways return every value as
 * text, so a number is compared numerically (relative tolerance for decimals) and anything else
 * as text. null only matches null.
 */
export function valuesMatch(expected: unknown, actual: unknown): boolean {
  const e = cell(expected);
  const a = cell(actual);
  if (e === null || a === null) return e === null && a === null;
  if (typeof e === 'number') {
    const text = typeof a === 'number' ? String(a) : typeof a === 'string' ? a.trim() : '';
    if (!NUMERIC.test(text) && typeof a !== 'number') return false;
    const n = Number(text);
    return Math.abs(n - e) <= EPSILON * Math.max(1, Math.abs(e), Math.abs(n));
  }
  if (typeof e === 'boolean')
    return String(a) === (e ? 'true' : 'false') || String(a) === (e ? 'S' : 'N');
  return String(e) === String(a);
}

function paramType(v: unknown): CriteriaParamType {
  if (typeof v === 'number') return Number.isInteger(v) ? 'I' : 'F';
  return 'S';
}

const keySig = (pk: string[], row: Record<string, unknown>) =>
  JSON.stringify(pk.map((k) => String(cell(row[k]))));

export interface VerifyTarget {
  key: Record<string, unknown>;
  /** The fields the write set, with the value each must hold now. */
  expected: Record<string, unknown>;
}

/** The read-back of one target. */
export interface VerifyResult {
  /** true: every field matched; false: a mismatch or the row is gone; absent: not read. */
  verified?: boolean;
  /** The row as read, restricted to the keys of `expected`; absent unless the row was read. */
  observed?: Record<string, unknown>;
}

/**
 * Reads the targets back with `loadRecords` (idempotent) and returns, per target, `verified`
 * true (every field matched), false (a mismatch, or the row is gone) or absent (it could not be
 * read: a failed read never counts as verified), plus the `observed` values of exactly the
 * expected fields when the row was read. Targets without a complete key are never verified.
 */
export async function verifyByKey(
  client: Pick<SankhyaClient, 'loadRecords'>,
  input: { entityName: string; pk: string[]; targets: VerifyTarget[] },
): Promise<VerifyResult[]> {
  const { entityName, pk, targets } = input;
  const out: VerifyResult[] = targets.map(() => ({}));
  const readable = targets
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => pk.length > 0 && pk.every((k) => cell(t.key[k]) !== null));
  for (let start = 0; start < readable.length; start += VERIFY_CHUNK) {
    const chunk = readable.slice(start, start + VERIFY_CHUNK);
    const fields = [...new Set([...pk, ...chunk.flatMap(({ t }) => Object.keys(t.expected))])];
    const expression = chunk
      .map(() => `(${pk.map((k) => `this.${k} = ?`).join(' AND ')})`)
      .join(' OR ');
    const parameters = chunk.flatMap(({ t }) =>
      pk.map((k) => {
        const v = t.key[k];
        return { value: typeof v === 'number' ? v : String(v), type: paramType(v) };
      }),
    );
    const rows = new Map<string, Record<string, unknown>>();
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await client.loadRecords({
          rootEntity: entityName,
          fields,
          criteria: { expression, parameters },
          offsetPage: page,
        });
        for (const r of res.records) rows.set(keySig(pk, r), r);
        if (!res.hasMore) break;
        if (page === MAX_PAGES - 1) throw new Error('verification read did not end');
      }
    } catch {
      continue; // These targets stay unverified.
    }
    for (const { t, i } of chunk) {
      const row = rows.get(keySig(pk, t.key));
      if (row === undefined) {
        out[i] = { verified: false };
        continue;
      }
      out[i] = {
        verified: Object.entries(t.expected).every(([field, value]) =>
          valuesMatch(value, row[field]),
        ),
        observed: Object.fromEntries(
          Object.keys(t.expected).map((field) => [field, cell(row[field])]),
        ),
      };
    }
  }
  return out;
}

/**
 * The report label from the steps: FAILED when any read-back mismatched; VERIFIED only when every
 * step ran (`ok`) and every one was read back and matched; PARTIALLY_VERIFIED when some were;
 * UNVERIFIED when none could be confirmed.
 */
export function labelOf(steps: ExecutionStep[]): VerificationLabel {
  if (steps.some((s) => s.verified === false)) return 'FAILED';
  const verified = steps.filter((s) => s.verified === true).length;
  if (steps.length > 0 && verified === steps.length && steps.every((s) => s.outcome === 'ok'))
    return 'VERIFIED';
  return verified > 0 ? 'PARTIALLY_VERIFIED' : 'UNVERIFIED';
}

/** success: every step ok; partial: some ok; failed: none. */
export function statusOf(steps: ExecutionStep[]): ExecutionReport['status'] {
  const ok = steps.filter((s) => s.outcome === 'ok').length;
  if (steps.length > 0 && ok === steps.length) return 'success';
  return ok > 0 ? 'partial' : 'failed';
}
