import type { ConnectionEnvironment } from '../api/types';

/** Exact banner texts. Never abbreviated and never hidden. */
export const ENVIRONMENT_LABEL: Record<ConnectionEnvironment, string> = {
  PRODUCTION: 'PRODUÇÃO',
  HOMOLOGATION: 'HOMOLOGAÇÃO',
  SANDBOX: 'SANDBOX',
};

interface Props {
  environment: ConnectionEnvironment;
  connectionName?: string;
}

/** Always-visible strip naming the environment of the selected connection. */
export function EnvironmentBanner({ environment, connectionName }: Props) {
  return (
    <div
      role="note"
      aria-label="Ambiente da conexão"
      data-testid="environment-banner"
      data-environment={environment}
      className={`env-banner env-banner-${environment} flex items-center justify-center gap-2 px-3 py-0.5 text-xs font-bold tracking-wide`}
    >
      <span data-testid="environment-label">{ENVIRONMENT_LABEL[environment]}</span>
      {connectionName && (
        <span className="font-normal" data-testid="environment-connection">
          · {connectionName}
        </span>
      )}
    </div>
  );
}
