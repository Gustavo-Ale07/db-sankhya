import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { ErrorBox } from '../components/ErrorBox';
import { describeMaterialize, isScratchTableName, sourceToSql } from './scratchLogic';
import type { MaterializeResult } from './scratchLogic';

interface ScratchTable {
  name: string;
  rows: number;
}
interface ScratchResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  command: string;
  truncated: boolean;
}

interface Props {
  /** Selected Sankhya connection (source of the materialize). */
  connectionId?: string | undefined;
  connectionName?: string | undefined;
}

const cell = (v: unknown): string =>
  v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);

export function ScratchPage({ connectionId, connectionName }: Props) {
  const qc = useQueryClient();
  const tables = useQuery({
    queryKey: ['scratch-tables'],
    queryFn: () => api.get<{ tables: ScratchTable[] }>('/api/scratch/tables'),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['scratch-tables'] });

  const [sql, setSql] = useState('');
  const exec = useMutation({
    mutationFn: (text: string) => api.post<ScratchResult>('/api/scratch/exec', { sql: text }),
    onSettled: refresh,
  });

  const [source, setSource] = useState('');
  const [into, setInto] = useState('tmp_');
  const [replace, setReplace] = useState(false);
  const materialize = useMutation({
    mutationFn: (body: { sql: string; into: string; replace: boolean }) =>
      api.post<MaterializeResult>('/api/scratch/materialize', {
        sql: body.sql,
        into: body.into,
        ...(body.replace ? { replace: true } : {}),
        ...(connectionId ? { connectionId } : {}),
      }),
    onSettled: refresh,
  });
  const sourceSql = sourceToSql(source);
  const nameOk = isScratchTableName(into);
  const canMaterialize = Boolean(sourceSql) && nameOk && Boolean(connectionId);

  return (
    <div className="grid gap-4 p-3 text-xs lg:grid-cols-2" data-testid="scratch-page">
      <section className="space-y-2" aria-label="Tabelas scratch">
        <h2 className="text-sm font-semibold">Tabelas scratch (tmp_*)</h2>
        <p
          className="rounded border border-accent/60 bg-accent/10 px-3 py-2"
          role="note"
          data-testid="scratch-editor-hint"
        >
          O caminho principal agora é o Editor SQL: lá as tabelas tmp_* aparecem no grupo
          Temporárias, e CREATE/ALTER/DROP/INSERT/UPDATE/DELETE passam pela prévia com confirmação.
          Esta página fica para cópias avançadas e diagnóstico.
        </p>
        <p className="text-muted">
          Área de trabalho privada. Somente tabelas tmp_* são aceitas; limites e permissões são
          aplicados pelo servidor.
        </p>
        {tables.isError && <ErrorBox error={tables.error} />}
        <table className="w-full border border-line" data-testid="scratch-tables">
          <thead>
            <tr className="bg-panel2 text-left">
              <th className="px-2 py-1">Tabela</th>
              <th className="px-2 py-1">Linhas</th>
              <th className="px-2 py-1" />
            </tr>
          </thead>
          <tbody>
            {tables.data?.tables.map((t) => (
              <tr key={t.name} className="border-t border-line">
                <td className="px-2 py-1 font-mono">{t.name}</td>
                <td className="px-2 py-1">{t.rows}</td>
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setSql(`SELECT * FROM ${t.name} LIMIT 100`)}
                  >
                    Consultar
                  </button>
                </td>
              </tr>
            ))}
            {tables.data?.tables.length === 0 && (
              <tr>
                <td colSpan={3} className="px-2 py-2 text-muted">
                  Nenhuma tabela scratch.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <h2 className="pt-2 text-sm font-semibold">SQL no scratch</h2>
        <textarea
          className="input h-24 w-full font-mono"
          aria-label="SQL do scratch"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          placeholder="SELECT * FROM tmp_exemplo"
          data-testid="scratch-sql"
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!sql.trim() || exec.isPending}
          onClick={() => exec.mutate(sql.trim().replace(/;\s*$/, ''))}
          data-testid="scratch-run"
        >
          ▶ Executar no scratch
        </button>
        {exec.isError && <ErrorBox error={exec.error} />}
        {exec.data && (
          <div data-testid="scratch-result" className="space-y-1">
            <div role="status" className="text-muted">
              {exec.data.command}: {exec.data.rowCount} linha(s)
              {exec.data.truncated ? ' — truncado' : ''}
            </div>
            {exec.data.columns.length > 0 && (
              <div className="max-h-64 overflow-auto border border-line">
                <table className="w-full">
                  <thead>
                    <tr className="bg-panel2 text-left">
                      {exec.data.columns.map((c) => (
                        <th key={c} className="px-2 py-1">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {exec.data.rows.map((r, i) => (
                      <tr key={i} className="border-t border-line">
                        {r.map((v, j) => (
                          <td key={j} className="px-2 py-1 font-mono">
                            {cell(v)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="space-y-2" aria-label="Materializar">
        <h2 className="text-sm font-semibold">Materializar do Sankhya</h2>
        <p className="text-muted">
          Copia o resultado de um SELECT (ou de uma tabela) da conexão{' '}
          <strong>{connectionName ?? 'não selecionada'}</strong> para uma tabela tmp_*.
        </p>
        <label className="block space-y-1">
          <span className="font-medium">Origem (SELECT ou nome da tabela)</span>
          <textarea
            className="input h-24 w-full font-mono"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="SELECT CODPARC, NOMEPARC FROM TGFPAR"
            data-testid="materialize-source"
          />
        </label>
        <label className="block space-y-1">
          <span className="font-medium">Tabela de destino</span>
          <input
            className="input w-full font-mono"
            value={into}
            maxLength={64}
            onChange={(e) => setInto(e.target.value)}
            aria-invalid={!nameOk}
            data-testid="materialize-into"
          />
        </label>
        {!nameOk && (
          <p className="text-warn">Use o formato tmp_nome (minúsculas, números e _; até 64).</p>
        )}
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={replace}
            onChange={(e) => setReplace(e.target.checked)}
            data-testid="materialize-replace"
          />
          Substituir se a tabela já existir
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canMaterialize || materialize.isPending}
          title={connectionId ? undefined : 'Selecione uma conexão'}
          onClick={() => sourceSql && materialize.mutate({ sql: sourceSql, into, replace })}
          data-testid="materialize-run"
        >
          Materializar
        </button>
        {materialize.isError && <ErrorBox error={materialize.error} />}
        {materialize.data && (
          <div role="status" className="text-ok" data-testid="materialize-result">
            {describeMaterialize(materialize.data)}
          </div>
        )}
      </section>
    </div>
  );
}
