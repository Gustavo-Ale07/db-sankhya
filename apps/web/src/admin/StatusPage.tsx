import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../api/client';
import type { SystemStatus } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { rolesLabel } from '../app/session';
import { formatDuration } from '../lib/format';

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded border border-line bg-panel">
      <h2 className="border-b border-line px-3 py-1.5 text-xs font-semibold">{title}</h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 px-3 py-2 text-xs">
        {children}
      </dl>
    </section>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

const flag = (on: boolean, onText = 'sim', offText = 'não') => (
  <span className={on ? 'text-warn' : 'text-ok'}>{on ? onText : offText}</span>
);

function uptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h ${m}min` : h ? `${h}h ${m}min` : `${m}min`;
}

export function StatusPage() {
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => api.get<SystemStatus>('/api/status'),
    refetchInterval: 30_000,
  });
  const s = status.data;

  return (
    <div className="mx-auto max-w-5xl space-y-3 p-4" data-testid="status-page">
      <div className="flex items-center gap-2">
        <h1 className="mr-auto text-base font-semibold">Status do sistema</h1>
      </div>
      <ErrorBox error={status.error} />
      {s && (
        <div className="grid gap-3 md:grid-cols-2">
          <Card title="Aplicação">
            <Row k="Versão" v={s.version} />
            <Row k="Commit" v={<code>{s.commit.slice(0, 12)}</code>} />
            <Row k="Ambiente" v={s.environment} />
            <Row k="Uptime" v={uptime(s.uptimeSeconds)} />
            <Row k="Seus papéis" v={rolesLabel(s.roles)} />
          </Card>
          <Card title="Banco de dados">
            <Row
              k="Status"
              v={
                <span className={s.database.status === 'ok' ? 'text-ok' : 'text-danger'}>
                  {s.database.status}
                </span>
              }
            />
            <Row k="Tipo" v={s.database.kind} />
          </Card>
          <Card title="Sankhya">
            <Row
              k="Modo"
              v={
                <span className="badge" data-testid="status-sankhya-mode">
                  {s.sankhya.mode === 'mock' ? 'MOCK (dados fictícios)' : 'LIVE'}
                </span>
              }
            />
            <Row
              k="Estado"
              v={
                <span className={s.sankhya.state === 'READY' ? 'text-ok' : 'text-warn'}>
                  {s.sankhya.state === 'READY' ? 'pronto' : 'não configurado'}
                </span>
              }
            />
            <Row k="Conexões prontas" v={s.sankhya.readyConnections} />
          </Card>
          <Card title="Escritas">
            <Row k="Disponíveis" v={flag(s.writes.available)} />
            <Row k="SAFE_MODE" v={flag(!s.writes.safeMode, 'desligado', 'ligado')} />
            <Row k="GLOBAL_WRITE_ENABLED" v={flag(s.writes.globalWriteEnabled)} />
            <Row k="WRITE_TO_SANKHYA" v={flag(s.writes.writeToSankhya)} />
          </Card>
          <Card title="Limites">
            <Row k="Máx. linhas" v={s.limits.maxRows} />
            <Row k="Timeout por chamada" v={formatDuration(s.limits.timeoutMs)} />
          </Card>
        </div>
      )}
    </div>
  );
}
