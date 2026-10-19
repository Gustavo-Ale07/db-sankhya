import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { describeError, translateCode } from '../api/errors';
import { loadTabs, newTab, saveTabs } from '../explorer/tabs';
import { passwordProblems } from './password';

describe('passwordProblems', () => {
  it('mirrors the server policy', () => {
    expect(passwordProblems('short')).toHaveLength(2);
    expect(passwordProblems('alllowercaseletters')).toHaveLength(1);
    expect(passwordProblems('Fictional-Pass-2024')).toEqual([]);
    expect(passwordProblems('lowercase1234')).toHaveLength(1);
    expect(passwordProblems('lowercase1234!')).toEqual([]);
  });
});

describe('errors', () => {
  it('translates known codes to pt-BR and keeps the server message as detail', () => {
    const e = new ApiError(400, {
      code: 'READ_ONLY_MODE',
      message: 'Writes are disabled (SAFE_MODE=true)',
      requestId: 'req-1',
    });
    const d = describeError(e);
    expect(d.code).toBe('READ_ONLY_MODE');
    expect(d.title).not.toBe('Erro inesperado.');
    expect(d.detail).toContain('SAFE_MODE');
    expect(d.requestId).toBe('req-1');
  });
  it('falls back for unknown codes and non-API errors', () => {
    expect(translateCode('NOPE')).toBe('Erro inesperado.');
    expect(describeError(new Error('boom'))).toMatchObject({ code: 'UNKNOWN', detail: 'boom' });
  });
});

describe('editor tabs', () => {
  beforeEach(() => localStorage.clear());

  it('starts with a welcome tab', () => {
    const { tabs, activeId } = loadTabs('u1');
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.sql).toContain('FROM TGFPAR');
    expect(activeId).toBe(tabs[0]!.id);
  });

  it('round-trips through localStorage per user', () => {
    const a = newTab([], 'SELECT 1');
    const b = newTab([a], 'SELECT 2');
    expect(b.title).toBe('Consulta 2');
    saveTabs('u1', [a, b], b.id);
    expect(loadTabs('u1')).toEqual({ tabs: [a, b], activeId: b.id });
    expect(loadTabs('u2').tabs[0]!.sql).toContain('FROM TGFPAR');
  });

  it('ignores corrupt storage and invalid entries', () => {
    localStorage.setItem('dbx.tabs.u1', '{not json');
    expect(loadTabs('u1').tabs).toHaveLength(1);
    localStorage.setItem(
      'dbx.tabs.u1',
      JSON.stringify({ tabs: [{ id: 1 }, { id: 'x', title: 't', sql: 's' }], activeId: 'zzz' }),
    );
    expect(loadTabs('u1')).toEqual({ tabs: [{ id: 'x', title: 't', sql: 's' }], activeId: 'x' });
  });
});
