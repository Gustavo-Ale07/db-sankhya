import { describe, expect, it } from 'vitest';
import { cellText, formatDuration, sortRows, toCsv, toJsonRecords, toTsv } from './format';

describe('cellText', () => {
  it('renders NULL and booleans as text', () => {
    expect(cellText(null)).toBe('NULL');
    expect(cellText(undefined)).toBe('NULL');
    expect(cellText(true)).toBe('true');
    expect(cellText(12.5)).toBe('12.5');
  });
});

describe('sortRows', () => {
  const rows = [
    ['b', 2],
    [null, 1],
    ['a', 3],
    ['B', 4],
  ];
  it('sorts ascending with NULLs last and is stable', () => {
    expect(sortRows(rows, 0, 'asc').map((r) => r[1])).toEqual([3, 2, 4, 1]);
  });
  it('sorts numbers numerically in descending order', () => {
    expect(sortRows(rows, 1, 'desc').map((r) => r[1])).toEqual([4, 3, 2, 1]);
  });
  it('does not mutate the input', () => {
    const copy = JSON.stringify(rows);
    sortRows(rows, 0, 'desc');
    expect(JSON.stringify(rows)).toBe(copy);
  });
});

describe('toCsv', () => {
  it('quotes separators, quotes and new lines', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'say "hi"\nok']])).toBe('a,b\r\n"x,y","say ""hi""\nok"');
  });
  it('neutralises formula injection in strings', () => {
    const csv = toCsv(['v'], [['=HYPERLINK("http://x")'], ['+1'], ['-2+3'], ['@SUM(A1)']]);
    expect(csv.split('\r\n').slice(1)).toEqual([
      `"'=HYPERLINK(""http://x"")"`,
      "'+1",
      "'-2+3",
      "'@SUM(A1)",
    ]);
  });
  it('keeps negative numbers and NULLs intact', () => {
    expect(toCsv(['n', 'z'], [[-5, null]])).toBe('n,z\r\n-5,');
  });
});

describe('toJsonRecords / toTsv', () => {
  it('maps rows to records', () => {
    expect(toJsonRecords(['a', 'b'], [[1, null]])).toEqual([{ a: 1, b: null }]);
  });
  it('flattens tabs and new lines', () => {
    expect(toTsv(['a', 'b'], [['x\ty', 'l1\nl2']])).toBe('a\tb\nx y\tl1 l2');
    expect(toTsv(['a'], [[null]], false)).toBe('');
  });
  it('neutralises formula injection when pasted into a spreadsheet', () => {
    expect(toTsv(['a'], [['=1+1']], false).startsWith("'")).toBe(true);
    const text = toTsv(['v'], [['=1+1'], ['+1'], ['-2'], ['@A1'], ['\t=1'], [-5]], false);
    expect(text.split('\n')).toEqual(["'=1+1", "'+1", "'-2", "'@A1", "' =1", '-5']);
    expect(toTsv(['=h'], [['ok']])).toBe("'=h\nok");
  });
});

describe('formatDuration', () => {
  it('formats ms and seconds', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(42.4)).toBe('42 ms');
    expect(formatDuration(1500)).toBe('1.50 s');
    expect(formatDuration(12_340)).toBe('12.3 s');
  });
});
