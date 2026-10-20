import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ApiError } from '../api/client';
import { ErrorBox } from './ErrorBox';

afterEach(cleanup);

describe('ErrorBox', () => {
  it('shows the capability label of a refusal verbatim next to the code', () => {
    render(
      <ErrorBox
        error={
          new ApiError(422, {
            code: 'OPERATION_NOT_SUPPORTED',
            message: 'DELETE is not supported',
            details: { capability: 'UNSUPPORTED' },
          })
        }
      />,
    );
    const alert = screen.getByRole('alert');
    expect(screen.getByTestId('capability-badge').textContent).toBe('UNSUPPORTED');
    expect(alert.textContent).toContain('[OPERATION_NOT_SUPPORTED]');
    expect(alert.textContent).toContain('DELETE is not supported');
  });

  it('shows no capability badge when the refusal carries none', () => {
    render(
      <ErrorBox
        error={
          new ApiError(403, { code: 'FORBIDDEN', message: 'denied', details: { capability: 1 } })
        }
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('[FORBIDDEN]');
    expect(screen.queryByTestId('capability-badge')).toBeNull();
  });
});
