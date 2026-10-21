import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ResultGrid } from './ResultGrid';

afterEach(cleanup);

describe('ResultGrid header', () => {
  it('hides a type the source did not give and shows a known one', () => {
    render(
      <ResultGrid
        columns={[
          { name: 'CODVOL', type: 'unknown' },
          { name: 'TOTAL', type: 'integer' },
        ]}
        rows={[['UN', 1]]}
        resultKey="k"
      />,
    );
    const codvol = screen.getByTitle('CODVOL — ordenar');
    expect(codvol.textContent).toBe('CODVOL');
    expect(screen.getByTitle('TOTAL (integer) — ordenar').textContent).toBe('TOTALinteger');
    expect(document.body.textContent).not.toContain('unknown');
  });
});
