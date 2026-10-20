import { ApiError } from '../api/client';
import { describeError } from '../api/errors';

/** The capability label a refusal carries (UNSUPPORTED etc.), shown verbatim. */
function capabilityOf(error: unknown): string | undefined {
  const value = error instanceof ApiError ? error.details?.capability : undefined;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function ErrorBox({ error, className = '' }: { error: unknown; className?: string }) {
  if (!error) return null;
  const e = describeError(error);
  const capability = capabilityOf(error);
  return (
    <div
      role="alert"
      className={`rounded border border-danger/40 bg-danger/10 px-3 py-2 text-danger ${className}`}
    >
      <div className="font-semibold">
        {capability && (
          <span className="badge mr-1.5 font-semibold" data-testid="capability-badge">
            {capability}
          </span>
        )}
        {e.title} <span className="font-mono text-xs opacity-80">[{e.code}]</span>
      </div>
      {e.detail && <div className="mt-0.5 text-xs text-fg/80">{e.detail}</div>}
      {e.requestId && (
        <div className="mt-0.5 text-[11px] text-muted">request id: {e.requestId}</div>
      )}
    </div>
  );
}
