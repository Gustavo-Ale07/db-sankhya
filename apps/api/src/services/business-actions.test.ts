import { describe, expect, it } from 'vitest';
import {
  actionEnabled,
  actionStatement,
  findAction,
  parseActionStatement,
} from './business-actions';

const action = findAction('CACSP.cancelarNota')!;

describe('actionEnabled', () => {
  it('runs every registered action on a mock connection', () => {
    expect(actionEnabled(action, 'mock', [])).toBe(true);
  });

  it('runs an action on a live connection only when its exact id is listed', () => {
    expect(actionEnabled(action, 'live', [])).toBe(false);
    expect(actionEnabled(action, 'live', ['cacsp.cancelarnota'])).toBe(false);
    expect(actionEnabled(action, 'live', ['OTHER.action'])).toBe(false);
    expect(actionEnabled(action, 'live', ['CACSP.cancelarNota'])).toBe(true);
  });

  it('fails closed for any mode other than mock', () => {
    for (const mode of ['sandbox', 'replica', '', 'MOCK']) {
      expect(actionEnabled(action, mode, [])).toBe(false);
    }
    expect(actionEnabled(action, 'sandbox', ['CACSP.cancelarNota'])).toBe(true);
  });
});

describe('action statements', () => {
  it('round-trips a validated input and refuses anything else', () => {
    const input = { nunota: 7, justificativa: 'Nota emitida em duplicidade' };
    const sql = actionStatement(action, input);
    expect(parseActionStatement(sql)).toEqual({ action, input });
    expect(parseActionStatement(sql.replace('"nunota":7', '"nunota":-7'))).toBeUndefined();
    expect(parseActionStatement(sql.replace('cancelarNota', 'outraAcao'))).toBeUndefined();
    expect(parseActionStatement(`${sql} `)).toBeUndefined();
  });
});
