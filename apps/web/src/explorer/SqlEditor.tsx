import { useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import type { OnMount } from '@monaco-editor/react';
import { defineThemes, monaco } from '../editor/monaco';
import type { Theme } from '../app/theme';
import { statementAt } from '../lib/completion';

export interface EditorApi {
  /** Selected text, or the statement under the cursor. */
  currentSql: () => { sql: string; selection: boolean };
  insertText: (text: string) => void;
  focus: () => void;
}

interface Props {
  path: string;
  value: string;
  theme: Theme;
  onChange: (v: string) => void;
  onRun: () => void;
  onSave: () => void;
  apiRef: React.MutableRefObject<EditorApi | null>;
}

let themesDefined = false;

export function SqlEditor({ path, value, theme, onChange, onRun, onSave, apiRef }: Props) {
  const handlers = useRef({ onRun, onSave });
  useEffect(() => {
    handlers.current = { onRun, onSave };
  }, [onRun, onSave]);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  const onMount: OnMount = (editor) => {
    const ed = editor as unknown as monaco.editor.IStandaloneCodeEditor;
    editorRef.current = ed;
    const { KeyMod, KeyCode } = monaco;
    ed.addAction({
      id: 'dbx.run',
      label: 'Executar consulta',
      keybindings: [KeyMod.CtrlCmd | KeyCode.Enter, KeyCode.F5],
      run: () => handlers.current.onRun(),
    });
    ed.addAction({
      id: 'dbx.save',
      label: 'Salvar consulta',
      keybindings: [KeyMod.CtrlCmd | KeyCode.KeyS],
      run: () => handlers.current.onSave(),
    });
    apiRef.current = {
      currentSql: () => {
        const model = ed.getModel();
        const selection = ed.getSelection();
        if (!model) return { sql: '', selection: false };
        if (selection && !selection.isEmpty()) {
          return { sql: model.getValueInRange(selection).trim(), selection: true };
        }
        const pos = ed.getPosition();
        const offset = pos ? model.getOffsetAt(pos) : 0;
        return { sql: statementAt(model.getValue(), offset).sql, selection: false };
      },
      insertText: (text: string) => {
        const sel = ed.getSelection();
        if (!sel) return;
        ed.executeEdits('dbx', [{ range: sel, text, forceMoveMarkers: true }]);
        ed.focus();
      },
      focus: () => ed.focus(),
    };
    ed.focus();
  };

  useEffect(() => () => void (apiRef.current = null), [apiRef]);

  return (
    <Editor
      path={path}
      defaultLanguage="sql"
      language="sql"
      value={value}
      theme={theme === 'dark' ? 'dbx-dark' : 'dbx-light'}
      onChange={(v) => onChange(v ?? '')}
      onMount={onMount}
      beforeMount={() => {
        if (!themesDefined) {
          defineThemes();
          themesDefined = true;
        }
      }}
      loading={<div className="p-3 text-xs text-muted">Carregando editor…</div>}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        wordWrap: 'on',
        renderLineHighlight: 'line',
        quickSuggestions: { other: true, comments: false, strings: false },
        suggestOnTriggerCharacters: true,
        fixedOverflowWidgets: true,
        ariaLabel: 'Editor SQL',
      }}
    />
  );
}
