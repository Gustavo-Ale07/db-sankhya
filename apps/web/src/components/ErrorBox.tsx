import { describeError } from '../api/errors';

export function ErrorBox({ error, className = '' }: { error: unknown; className?: string }) {
  if (!error) return null;
  const e = describeError(error);
  return (
    <div
      role="alert"
      className={`rounded border border-danger/40 bg-danger/10 px-3 py-2 text-danger ${className}`}
    >
      <div className="font-semibold">
        {e.title} <span className="font-mono text-xs opacity-80">[{e.code}]</span>
      </div>
      {e.detail && <div className="mt-0.5 text-xs text-fg/80">{e.detail}</div>}
      {e.requestId && (
        <div className="mt-0.5 text-[11px] text-muted">request id: {e.requestId}</div>
      )}
    </div>
  );
}
