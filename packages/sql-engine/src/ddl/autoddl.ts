/**
 * Add-on Studio AutoDDL dictionary file (`datadictionary/<TABLE>.xml`).
 *
 * Audit §3.3 fixes the elements (`<table>`, `<primaryKey>`, `<field dataType=…>`)
 * but not every attribute, so this generator uses the following documented
 * layout:
 *
 *   <?xml version="1.0" encoding="UTF-8"?>
 *   <table name="AD_X" description="…">
 *     <primaryKey>
 *       <field name="ID"/>
 *     </primaryKey>
 *     <fields>
 *       <field name="ID" description="…" dataType="INTEIRO" required="true"/>
 *       <field name="NOME" description="…" dataType="TEXTO" size="40" required="false" default="x"/>
 *     </fields>
 *   </table>
 *
 * `description` falls back to the name; `size`, `scale` and `default` are
 * omitted when absent. AutoDDL never drops or renames anything: it only states
 * the desired table. Every attribute value is XML-escaped.
 */
import { validateTableModel, type ModelOptions, type TableModel } from './model';

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** Escapes `& < > " '` for XML text and attribute content. */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}

function attrs(pairs: Array<[string, string | number | boolean | undefined]>): string {
  return pairs
    .filter((p): p is [string, string | number | boolean] => p[1] !== undefined)
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join('');
}

export function toAutoDdlXml(model: TableModel, opts: ModelOptions = {}): string {
  const m = validateTableModel(model, opts);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<table${attrs([
      ['name', m.name],
      ['description', m.description ?? m.name],
    ])}>`,
    '  <primaryKey>',
    ...m.primaryKey.map((k) => `    <field${attrs([['name', k]])}/>`),
    '  </primaryKey>',
    '  <fields>',
    ...m.fields.map(
      (f) =>
        `    <field${attrs([
          ['name', f.name],
          ['description', f.description ?? f.name],
          ['dataType', f.dataType],
          ['size', f.size],
          ['scale', f.scale],
          ['required', f.required],
          ['default', f.default],
        ])}/>`,
    ),
    '  </fields>',
    '</table>',
  ];
  return `${lines.join('\n')}\n`;
}
