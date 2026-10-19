import { useMemo, useState } from 'react';
import { prettyJson } from '../lib/format';

const MAX_CHARS = 2_000_000;

export function JsonView({
  value,
  emptyText = 'Nada para mostrar.',
  testId,
}: {
  value: unknown;
  emptyText?: string;
  testId?: string;
}) {
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => (value === undefined ? '' : prettyJson(value)), [value]);
  if (value === undefined || value === null) {
    return <div className="p-3 text-xs text-muted">{emptyText}</div>;
  }
  const shown =
    text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n… (truncado na tela)` : text;
  return (
    <div className="relative h-full min-h-0">
      <button
        type="button"
        className="btn absolute top-2 right-4 z-10"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? 'Copiado' : 'Copiar'}
      </button>
      <pre
        className="h-full overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre"
        data-testid={testId}
      >
        {shown}
      </pre>
    </div>
  );
}
