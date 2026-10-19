import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ResultColumn, Value } from '../api/types';
import { cellText, sortRows, toTsv } from '../lib/format';
import type { SortDir } from '../lib/format';

const ROW_H = 24;
const NUM_W = 52;
const MIN_W = 48;

interface Props {
  columns: ResultColumn[];
  rows: Value[][];
  /** Changes when a new result arrives (resets sort / selection / widths). */
  resultKey: string;
}

function initialWidth(col: ResultColumn, rows: Value[][], index: number): number {
  let max = col.name.length + 2;
  for (let i = 0; i < Math.min(rows.length, 50); i++) {
    const len = cellText(rows[i]?.[index]).length;
    if (len > max) max = len;
  }
  return Math.max(MIN_W, Math.min(360, max * 7.2 + 16));
}

export function ResultGrid({ columns, rows, resultKey }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState<{ col: number; dir: SortDir } | null>(null);
  const [widths, setWidths] = useState<number[]>([]);
  const [sel, setSel] = useState<{ row: number; col: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    setSort(null);
    setSel(null);
    setWidths(columns.map((c, i) => initialWidth(c, rows, i)));
    // Only when a new result arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultKey]);

  const view = useMemo(() => (sort ? sortRows(rows, sort.col, sort.dir) : rows), [rows, sort]);

  const virtualizer = useVirtualizer({
    count: view.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  const colWidths = columns.map((c, i) => widths[i] ?? initialWidth(c, rows, i));
  const totalWidth = NUM_W + colWidths.reduce((a, b) => a + b, 0);
  const template = `${NUM_W}px ${colWidths.map((w) => `${w}px`).join(' ')}`;

  function toggleSort(col: number) {
    setSort((s) =>
      !s || s.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null,
    );
  }

  function startResize(e: ReactPointerEvent, col: number) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidths[col] ?? 100;
    const move = (ev: PointerEvent) => {
      const w = Math.max(MIN_W, startW + ev.clientX - startX);
      setWidths((ws) => {
        const next = [...ws];
        next[col] = w;
        return next;
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied('falha ao copiar');
    }
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (!sel) return;
    const names = columns.map((c) => c.name);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      const row = view[sel.row];
      if (!row) return;
      if (e.shiftKey) void copy(toTsv(names, [row], false), 'linha copiada');
      else void copy(cellText(row[sel.col]), 'célula copiada');
      return;
    }
    const moves: Record<string, [number, number]> = {
      ArrowDown: [1, 0],
      ArrowUp: [-1, 0],
      ArrowRight: [0, 1],
      ArrowLeft: [0, -1],
    };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      const row = Math.max(0, Math.min(view.length - 1, sel.row + m[0]));
      const col = Math.max(0, Math.min(columns.length - 1, sel.col + m[1]));
      setSel({ row, col });
      virtualizer.scrollToIndex(row);
    }
  }

  if (columns.length === 0) {
    return <div className="p-3 text-xs text-muted">A instrução não retornou colunas.</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-2 py-0.5 text-[11px] text-muted">
        <span>
          {sel
            ? `Linha ${sel.row + 1}, coluna ${columns[sel.col]?.name ?? ''} · Ctrl+C copia a célula, Ctrl+Shift+C a linha`
            : 'Clique numa célula para selecionar. Clique no cabeçalho para ordenar.'}
        </span>
        {copied && (
          <span role="status" className="text-ok">
            {copied}
          </span>
        )}
      </div>
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-auto font-mono text-xs outline-none"
        tabIndex={0}
        onKeyDown={onKeyDown}
        role="grid"
        aria-rowcount={view.length + 1}
        aria-colcount={columns.length}
        aria-label="Resultado da consulta"
        data-testid="result-grid"
      >
        <div style={{ width: totalWidth, minWidth: '100%' }}>
          <div
            className="sticky top-0 z-10 grid border-b border-line bg-panel2 font-sans font-semibold"
            style={{ gridTemplateColumns: template }}
            role="row"
            aria-rowindex={1}
          >
            <div
              className="border-r border-line px-1 py-1 text-right text-muted"
              role="columnheader"
            >
              #
            </div>
            {columns.map((c, i) => (
              <div
                key={`${c.name}-${i}`}
                role="columnheader"
                aria-sort={
                  sort?.col === i ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
                }
                className="relative flex items-center border-r border-line"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1 text-left hover:bg-hover"
                  onClick={() => toggleSort(i)}
                  title={`${c.name} (${c.type}) — ordenar`}
                >
                  <span className="truncate">{c.name}</span>
                  <span className="text-[10px] font-normal text-muted">{c.type}</span>
                  {sort?.col === i && <span aria-hidden>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                </button>
                <span
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-accent/40"
                  onPointerDown={(e) => startResize(e, i)}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Redimensionar coluna ${c.name}`}
                />
              </div>
            ))}
          </div>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vr) => {
              const row = view[vr.index]!;
              return (
                <div
                  key={vr.key}
                  role="row"
                  aria-rowindex={vr.index + 2}
                  className={`absolute left-0 grid w-full ${vr.index % 2 ? 'bg-panel2' : 'bg-panel'}`}
                  style={{
                    gridTemplateColumns: template,
                    height: ROW_H,
                    transform: `translateY(${vr.start}px)`,
                  }}
                >
                  <div className="border-r border-line px-1 text-right leading-6 text-muted">
                    {vr.index + 1}
                  </div>
                  {columns.map((c, ci) => {
                    const v = row[ci];
                    const selected = sel?.row === vr.index && sel.col === ci;
                    return (
                      <div
                        key={ci}
                        role="gridcell"
                        aria-selected={selected}
                        title={cellText(v)}
                        onClick={() => setSel({ row: vr.index, col: ci })}
                        className={`truncate border-r border-line px-2 leading-6 ${
                          selected ? 'bg-selected outline outline-1 outline-accent' : ''
                        } ${v === null || v === undefined ? 'text-muted italic' : ''} ${
                          typeof v === 'number' ? 'text-right' : ''
                        }`}
                      >
                        {cellText(v)}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
