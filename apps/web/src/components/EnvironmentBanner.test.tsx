import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ConnectionEnvironment } from '../api/types';
import { EnvironmentBanner } from './EnvironmentBanner';

afterEach(cleanup);

describe('EnvironmentBanner', () => {
  const cases: [ConnectionEnvironment, string][] = [
    ['PRODUCTION', 'PRODUÇÃO'],
    ['HOMOLOGATION', 'HOMOLOGAÇÃO'],
    ['SANDBOX', 'SANDBOX'],
  ];
  it.each(cases)('shows the exact text for %s with its own colour class', (env, text) => {
    render(<EnvironmentBanner environment={env} connectionName="Principal" />);
    expect(screen.getByTestId('environment-label').textContent).toBe(text);
    const banner = screen.getByTestId('environment-banner');
    expect(banner.className).toContain(`env-banner-${env}`);
    expect(banner.textContent).toContain('Principal');
  });
});
