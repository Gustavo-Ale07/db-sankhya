import type { Value } from '../api/types';

/** Text shown in a grid cell. Data is always rendered as text, never as HTML. */
export function cellText(v: Value | undefined): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

export type SortDir = 'asc' | 'desc';

export function compareValues(a: Value | undefined, b: Value | undefined): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an || bn) return an === bn ? 0 : an ? 1 : -1; // NULLs last
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), 'pt-BR', { numeric: true, sensitivity: 'base' });
}

export function sortRows(rows: Value[][], col: number, dir: SortDir): Value[][] {
  const indexed = rows.map((r, i) => [r, i] as const);
  indexed.sort((x, y) => {
    const c = compareValues(x[0][col], y[0][col]);
    return (dir === 'asc' ? c : -c) || x[1] - y[1];
  });
  return indexed.map(([r]) => r);
}

function csvField(v: Value | undefined): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
  // Neutralise spreadsheet formula injection (CSV injection); real numbers stay untouched.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Value[][]): string {
  const lines = [columns.map((c) => csvField(c)).join(',')];
  for (const r of rows) lines.push(columns.map((_, i) => csvField(r[i])).join(','));
  return lines.join('\r\n');
}

export function toJsonRecords(columns: string[], rows: Value[][]): Record<string, Value>[] {
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null])));
}

/** Tab-separated text for pasting into spreadsheets. */
export function toTsv(columns: string[], rows: Value[][], header = true): string {
  const flat = (s: string) => s.replace(/[\t\r\n]+/g, ' ');
  // Pasted into a spreadsheet, a leading = + - @ would run as a formula: neutralise it like the
  // CSV export does (strings only; real numbers stay untouched).
  const clean = (v: Value | undefined) => {
    if (v === null || v === undefined) return '';
    const raw = cellText(v);
    return typeof v === 'string' && /^[=+\-@\t\r]/.test(raw) ? `'${flat(raw)}` : flat(raw);
  };
  const lines = rows.map((r) => columns.map((_, i) => clean(r[i])).join('\t'));
  return (header ? [columns.map(clean).join('\t'), ...lines] : lines).join('\n');
}

export function downloadText(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
}

export function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? 'null';
  } catch {
    return String(v);
  }
}

export function timestampForFile(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}
