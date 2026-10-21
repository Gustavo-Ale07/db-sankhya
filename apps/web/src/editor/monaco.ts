// Lean, self-hosted Monaco: core editor + contributions + the SQL grammar only.
// Nothing is loaded from a CDN (CSP: script-src 'self').
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/sql/register';
import EditorWorker from 'monaco-editor/editor/editor.worker.start?worker';
import { loader } from '@monaco-editor/react';
import type { CatalogTable } from '../api/types';
import type { SuggestionKind } from '../lib/completion';
import { suggest, withTablesOf } from '../lib/completion';

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker };
  }
}

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

loader.config({ monaco: monaco as unknown as Parameters<typeof loader.config>[0]['monaco'] });

export type Monaco = typeof monaco;
export { monaco };

type TableLoader = (name: string) => Promise<CatalogTable>;

let schemaRef: CatalogTable[] = [];
let loaderRef: TableLoader | undefined;
let registered = false;
/** Complete tables, per loader: a new connection (a new loader) starts empty. */
const loadedBy = new WeakMap<TableLoader, Map<string, Promise<CatalogTable>>>();

function cached(load: TableLoader): TableLoader {
  let byName = loadedBy.get(load);
  if (!byName) loadedBy.set(load, (byName = new Map()));
  const known = byName;
  return (name) => {
    let table = known.get(name);
    if (!table) {
      table = load(name);
      known.set(name, table);
      // A failed read is tried again on the next suggestion.
      table.catch(() => known.delete(name));
    }
    return table;
  };
}

/**
 * Feeds the autocomplete with the current schema; registers the provider once. With `loadTable`
 * (a dictionary cut at the gateway row cap), the columns of the tables a statement names are
 * read in full before they are suggested.
 */
export function setCompletionSchema(tables: CatalogTable[], loadTable?: TableLoader): void {
  schemaRef = tables;
  loaderRef = loadTable;
  if (registered) return;
  registered = true;
  const kinds: Record<SuggestionKind, monaco.languages.CompletionItemKind> = {
    table: monaco.languages.CompletionItemKind.Struct,
    column: monaco.languages.CompletionItemKind.Field,
    keyword: monaco.languages.CompletionItemKind.Keyword,
    function: monaco.languages.CompletionItemKind.Function,
    alias: monaco.languages.CompletionItemKind.Variable,
  };
  const order: Record<SuggestionKind, string> = {
    column: '1',
    alias: '2',
    table: '3',
    function: '4',
    keyword: '5',
  };
  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' '],
    async provideCompletionItems(model, position) {
      const full = model.getValue();
      const offset = model.getOffsetAt(position);
      const before = full.slice(0, offset);
      const stmtStart = before.lastIndexOf(';') + 1;
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );
      const schema = schemaRef;
      const load = loaderRef;
      const tables = load ? await withTablesOf(full, schema, cached(load)) : schema;
      // The connection changed while its tables were read: nothing from the old one.
      if (schema !== schemaRef || load !== loaderRef) return { suggestions: [] };
      const items = suggest(before.slice(stmtStart), full, tables);
      return {
        suggestions: items.map((s) => ({
          label: { label: s.label, description: s.detail },
          kind: kinds[s.kind],
          insertText: s.insertText,
          documentation: s.documentation,
          sortText: `${order[s.kind]}${s.label}`,
          range,
        })),
      };
    },
  });
}

export function defineThemes(): void {
  monaco.editor.defineTheme('dbx-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#ffffff' },
  });
  monaco.editor.defineTheme('dbx-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#1b1f24' },
  });
}
