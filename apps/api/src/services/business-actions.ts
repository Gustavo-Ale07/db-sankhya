/**
 * Typed business actions (Task 11.3): the only gateway services, besides `DatasetSP.save`, the
 * API may call to change data. Nothing outside this registry can be called: there is no generic
 * "call any service" path.
 *
 * Each action creates, changes or removes one row of one entity (`incluirNota` also creates the
 * items of the new note). It runs through the same plan lifecycle as a SQL write
 * (MutationService): PolicyEngine with the action's entities, preview of the real row,
 * confirmation, re-authorization, kill switches, one non-idempotent call, read-back and audit.
 *
 * Every request body below follows the official gateway documentation (developer.sankhya.com.br,
 * the page in `contract`) and nothing else; where that page is ambiguous the choice is noted at
 * the field. They were exercised against the gateway mock only: an action is enabled on a live
 * connection only through BUSINESS_ACTIONS_ENABLED, after it was tested in HOMOLOGATION.
 * A service whose contract could not be confirmed is listed in ACTION_STUBS and cannot run.
 */
import { z } from 'zod';
import type { Permission } from '@dbx/shared';
import type { GatewayModule } from '@dbx/sankhya-client';

export type ActionValue = string | number | null;

/**
 * update: changes an existing row, read back by its key. create: the gateway generates the key,
 * taken from its answer. delete: removes an existing row; verified when it is gone.
 */
export type ActionKind = 'update' | 'create' | 'delete';

/** The own permission of an action: one per registered action. */
export type ActionPermission = Extract<Permission, `SANKHYA.ACTION.${string}`>;

/** The permission every action also needs, besides its own. */
export const BUSINESS_ACTION_PERMISSION =
  'SANKHYA.BUSINESS_ACTION.EXECUTE' as const satisfies Permission;

/** Shown with every action: none of them has run against a real gateway yet. */
export const ACTION_WARNING = 'validado só no mock; testar em HOMOLOGAÇÃO antes de produção';

/** Rows of a child entity the action creates with its row (the items of a new note). */
export interface ActionChildren<I> {
  /** The table (catalog name) of the child rows; its key is the parent's key plus one column. */
  entity: string;
  /** The values each child row must hold after the action, in the order they were sent. */
  rows(input: I): Record<string, ActionValue>[];
}

export interface BusinessAction<I extends Record<string, unknown> = Record<string, unknown>> {
  /** The gateway service name, also the action id in the URL (`/api/actions/:id`). */
  id: string;
  module: GatewayModule;
  /** The action's own permission; BUSINESS_ACTION_PERMISSION is needed as well. */
  permission: ActionPermission;
  /** The table (catalog name) of the row the action creates, changes or removes. */
  entity: string;
  /**
   * The table (catalog name) of the row the action works under, when it is not `entity` (the
   * note of an item): the policy covers it too, and the row is read before any call.
   */
  parent?: string;
  description: string;
  /** The official documentation page the request body follows. */
  contract: string;
  input: z.ZodType<I>;
  kind(input: I): ActionKind;
  /**
   * Primary key of the row: complete for update and delete; for create, the part the input
   * already fixes (the note of a new item), the rest comes from the gateway's answer.
   */
  key(input: I): Record<string, number | string>;
  /** Columns read for the preview, besides the key. */
  columns: string[];
  /** Values the row must hold after the action, read back to verify (empty for delete). */
  effect(input: I): Record<string, ActionValue>;
  /** Gateway request body, as in `contract`. */
  requestBody(input: I): unknown;
  /**
   * Every column the request body sends or sets, by table (catalog name): the policy decides on
   * all of them. A delete removes the whole row and is decided on every column instead.
   */
  writes(input: I): Record<string, string[]>;
  /** create: the generated key in the gateway's `responseBody`, or undefined when absent. */
  createdKey?(responseBody: unknown): Record<string, number> | undefined;
  /** create: the child rows created with the row. */
  children?: ActionChildren<I>;
}

/** A service the registry knows of but cannot run: its contract is not confirmed. */
export interface ActionStub {
  id: string;
  module: GatewayModule;
  contract: string;
  /** Why it is not executable. */
  reason: string;
}

const DOCS = 'https://developer.sankhya.com.br/reference';

/** A gateway field value: `{ "$": "text" }`. */
const v = (value: string | number) => ({ $: String(value) });

/** `{ pk: { NAME: { $: "1" } } }` → `{ NAME: 1 }` for the names given; undefined unless all are. */
function pkOf(responseBody: unknown, names: string[]): Record<string, number> | undefined {
  const pk = (responseBody as { pk?: unknown } | null | undefined)?.pk;
  if (typeof pk !== 'object' || pk === null) return undefined;
  const out: Record<string, number> = {};
  for (const name of names) {
    const raw = (pk as Record<string, unknown>)[name];
    const text = typeof raw === 'object' && raw !== null ? (raw as { $?: unknown }).$ : raw;
    const n = typeof text === 'string' || typeof text === 'number' ? Number(text) : NaN;
    if (!Number.isInteger(n) || n <= 0) return undefined;
    out[name] = n;
  }
  return out;
}

const nunota = z.number().int().positive();
const sequencia = z.number().int().positive();
const codvol = z.string().min(1).max(6);
const money = z.number().nonnegative().max(1e12);
const quantity = z.number().positive().max(1e9);
const percent = z.number().min(0).max(100);
/** dd/mm/yyyy, as the documented examples send DTNEG. */
const date = z.string().regex(/^(0[1-9]|[12]\d|3[01])\/(0[1-9]|1[0-2])\/\d{4}$/);

// ---------------------------------------------------------------------- CACSP.cancelarNota
const cancelarNotaInput = z
  .object({
    nunota,
    justificativa: z.string().min(15).max(255),
  })
  .strict();

type CancelarNotaInput = z.infer<typeof cancelarNotaInput>;

const cancelarNota: BusinessAction<CancelarNotaInput> = {
  id: 'CACSP.cancelarNota',
  module: 'mgecom',
  permission: 'SANKHYA.ACTION.CANCELAR_NOTA',
  entity: 'TGFCAB',
  description: 'Cancels one note (TGFCAB) with a justification. Cannot be undone.',
  contract: `${DOCS}/post_cancelamovimento`,
  input: cancelarNotaInput,
  kind: () => 'update',
  key: (i) => ({ NUNOTA: i.nunota }),
  columns: ['STATUSNOTA'],
  // The mock marks a cancelled header with STATUSNOTA = 'C'; a real gateway may differ (the row
  // may be moved elsewhere), which the read-back then reports as FAILED, never as VERIFIED.
  effect: () => ({ STATUSNOTA: 'C' }),
  // The documented `validarProcessosWmsEmAndamento` flag is not described there: not sent.
  requestBody: (i) => ({
    notasCanceladas: { nunota: [v(i.nunota)], justificativa: i.justificativa },
  }),
  writes: () => ({ TGFCAB: ['NUNOTA', 'STATUSNOTA'] }),
};

// ---------------------------------------------------------------------- CACSP.incluirNota
const notaItem = z
  .object({
    codprod: z.number().int().positive(),
    qtdneg: quantity,
    codlocalorig: z.number().int().nonnegative(),
    codvol,
    /** Required when informarPreco is true, as the contract says. */
    vlrunit: money.optional(),
    percdesc: percent.optional(),
  })
  .strict();

const incluirNotaInput = z
  .object({
    codparc: z.number().int().positive(),
    dtneg: date,
    codtipoper: z.number().int().positive(),
    codtipvenda: z.number().int().nonnegative(),
    codvend: z.number().int().nonnegative(),
    codemp: z.number().int().positive(),
    tipmov: z.string().length(1),
    /** INFORMARPRECO: the items carry their price (VLRUNIT, PERCDESC). */
    informarPreco: z.boolean(),
    itens: z.array(notaItem).min(1).max(50),
  })
  .strict()
  .superRefine((i, ctx) => {
    if (!i.informarPreco) return;
    i.itens.forEach((item, n) => {
      for (const field of ['vlrunit', 'percdesc'] as const) {
        if (item[field] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['itens', n, field],
            message: `${field} is required when informarPreco is true`,
          });
        }
      }
    });
  });

type IncluirNotaInput = z.infer<typeof incluirNotaInput>;

const incluirNota: BusinessAction<IncluirNotaInput> = {
  // The page is titled "IncluirNota"; its URL example and body use `incluirNota`.
  id: 'CACSP.incluirNota',
  module: 'mgecom',
  permission: 'SANKHYA.ACTION.INCLUIR_NOTA',
  entity: 'TGFCAB',
  description: 'Creates one note (TGFCAB) with its items (TGFITE).',
  contract: `${DOCS}/post_incluimovimentos`,
  input: incluirNotaInput,
  kind: () => 'create',
  key: () => ({}),
  columns: [],
  effect: (i) => ({ CODPARC: i.codparc, TIPMOV: i.tipmov }),
  requestBody: (i) => ({
    nota: {
      cabecalho: {
        NUNOTA: {},
        CODPARC: v(i.codparc),
        DTNEG: v(i.dtneg),
        CODTIPOPER: v(i.codtipoper),
        CODTIPVENDA: v(i.codtipvenda),
        CODVEND: v(i.codvend),
        CODEMP: v(i.codemp),
        TIPMOV: v(i.tipmov),
      },
      itens: {
        INFORMARPRECO: i.informarPreco ? 'True' : 'False',
        item: i.itens.map((item) => ({
          NUNOTA: {},
          IGNOREDESCPROMOQTD: v('True'),
          CODPROD: v(item.codprod),
          QTDNEG: v(item.qtdneg),
          CODLOCALORIG: v(item.codlocalorig),
          CODVOL: v(item.codvol),
          ...(i.informarPreco && item.percdesc !== undefined ? { PERCDESC: v(item.percdesc) } : {}),
          ...(i.informarPreco && item.vlrunit !== undefined ? { VLRUNIT: v(item.vlrunit) } : {}),
        })),
      },
    },
  }),
  writes: (i) => ({
    TGFCAB: [
      'NUNOTA',
      'CODPARC',
      'DTNEG',
      'CODTIPOPER',
      'CODTIPVENDA',
      'CODVEND',
      'CODEMP',
      'TIPMOV',
    ],
    TGFITE: [
      'NUNOTA',
      'SEQUENCIA',
      'CODPROD',
      'QTDNEG',
      'CODLOCALORIG',
      'CODVOL',
      ...(i.informarPreco ? ['VLRUNIT', 'PERCDESC'] : []),
    ],
  }),
  createdKey: (body) => pkOf(body, ['NUNOTA']),
  children: {
    entity: 'TGFITE',
    // Without informarPreco the gateway prices the item itself: the price is not checked.
    rows: (i) =>
      i.itens.map((item) => ({
        CODPROD: item.codprod,
        QTDNEG: item.qtdneg,
        ...(i.informarPreco && item.vlrunit !== undefined ? { VLRUNIT: item.vlrunit } : {}),
      })),
  },
};

// ---------------------------------------------------------------------- CACSP.incluirAlterarItemNota
const itemNotaInput = z
  .object({
    nunota,
    /** Absent: a new item (SEQUENCIA ""); present: changes that item. */
    sequencia: sequencia.optional(),
    codprod: z.number().int().positive(),
    qtdneg: quantity,
    vlrunit: money,
    codvol,
    /** Listed as required by the contract but missing from its example: sent when given. */
    codlocalorig: z.number().int().nonnegative().optional(),
    vlrdesc: money.optional(),
    percdesc: percent.optional(),
  })
  .strict();

type ItemNotaInput = z.infer<typeof itemNotaInput>;

/** VLRTOT as the contract defines it, QTDNEG × VLRUNIT, rounded to cents. */
const total = (i: { qtdneg: number; vlrunit: number }) =>
  Math.round(i.qtdneg * i.vlrunit * 100) / 100;

const incluirAlterarItemNota: BusinessAction<ItemNotaInput> = {
  id: 'CACSP.incluirAlterarItemNota',
  module: 'mgecom',
  permission: 'SANKHYA.ACTION.INCLUIR_ALTERAR_ITEM_NOTA',
  entity: 'TGFITE',
  // The item belongs to a note, and the ERP recomputes the note's totals.
  parent: 'TGFCAB',
  description:
    'Adds an item to a note (TGFITE), or changes one by its sequence. The TOP must allow it.',
  contract: `${DOCS}/post_incaltitemmovimento`,
  input: itemNotaInput,
  kind: (i) => (i.sequencia === undefined ? 'create' : 'update'),
  key: (i): Record<string, number> =>
    i.sequencia === undefined ? { NUNOTA: i.nunota } : { NUNOTA: i.nunota, SEQUENCIA: i.sequencia },
  columns: ['CODPROD', 'QTDNEG', 'VLRUNIT'],
  // VLRTOT is sent but not checked: the gateway may recompute it (discounts).
  effect: (i) => ({ CODPROD: i.codprod, QTDNEG: i.qtdneg, VLRUNIT: i.vlrunit }),
  requestBody: (i) => ({
    nota: {
      NUNOTA: String(i.nunota),
      itens: {
        item: {
          NUNOTA: v(i.nunota),
          SEQUENCIA: v(i.sequencia ?? ''),
          CODPROD: v(i.codprod),
          QTDNEG: v(i.qtdneg),
          VLRUNIT: v(i.vlrunit),
          VLRTOT: v(total(i)),
          CODVOL: v(i.codvol),
          ...(i.codlocalorig !== undefined ? { CODLOCALORIG: v(i.codlocalorig) } : {}),
          ...(i.vlrdesc !== undefined ? { VLRDESC: v(i.vlrdesc) } : {}),
          ...(i.percdesc !== undefined ? { PERCDESC: v(i.percdesc) } : {}),
        },
      },
    },
  }),
  writes: (i) => ({
    TGFCAB: ['NUNOTA', 'VLRNOTA'],
    TGFITE: [
      'NUNOTA',
      'SEQUENCIA',
      'CODPROD',
      'QTDNEG',
      'VLRUNIT',
      'VLRTOT',
      'CODVOL',
      ...(i.codlocalorig !== undefined ? ['CODLOCALORIG'] : []),
      ...(i.vlrdesc !== undefined ? ['VLRDESC'] : []),
      ...(i.percdesc !== undefined ? ['PERCDESC'] : []),
    ],
  }),
  createdKey: (body) => pkOf(body, ['NUNOTA', 'SEQUENCIA']),
};

// ---------------------------------------------------------------------- CACSP.excluirItemNota
const excluirItemNotaInput = z.object({ nunota, sequencia }).strict();

type ExcluirItemNotaInput = z.infer<typeof excluirItemNotaInput>;

const excluirItemNota: BusinessAction<ExcluirItemNotaInput> = {
  id: 'CACSP.excluirItemNota',
  module: 'mgecom',
  permission: 'SANKHYA.ACTION.EXCLUIR_ITEM_NOTA',
  entity: 'TGFITE',
  parent: 'TGFCAB',
  description: 'Removes one item (TGFITE) of a note by its sequence.',
  contract: `${DOCS}/post_excluiitemmovimento`,
  input: excluirItemNotaInput,
  kind: () => 'delete',
  key: (i) => ({ NUNOTA: i.nunota, SEQUENCIA: i.sequencia }),
  columns: ['CODPROD', 'QTDNEG', 'VLRUNIT', 'VLRTOT'],
  effect: () => ({}),
  requestBody: (i) => ({
    nota: { itens: { item: { NUNOTA: v(i.nunota), SEQUENCIA: v(i.sequencia) } } },
  }),
  // The whole item goes (decided on every column, see resolveAction); the note's totals change.
  writes: () => ({ TGFCAB: ['NUNOTA', 'VLRNOTA'], TGFITE: ['NUNOTA', 'SEQUENCIA'] }),
};

/** Known services that stay disabled: their contract could not be confirmed. */
export const ACTION_STUBS: readonly ActionStub[] = [
  {
    id: 'SelecaoDocumentoSP.faturar',
    module: 'mgecom',
    contract: `${DOCS}/post_faturamovimento`,
    reason:
      'The documentation does not say which of its fields are required: not executable until ' +
      'the contract is confirmed.',
  },
];

/** The stub of a known but disabled service, or undefined. */
export function findStub(id: string): ActionStub | undefined {
  return ACTION_STUBS.find((s) => s.id === id);
}

const REGISTRY: ReadonlyMap<string, BusinessAction> = new Map(
  [cancelarNota, incluirNota, incluirAlterarItemNota, excluirItemNota]
    .map((a) => a as unknown as BusinessAction)
    .map((a) => [a.id, a]),
);

/** The registered action, or undefined (an exact, case-sensitive id match). */
export function findAction(id: string): BusinessAction | undefined {
  return REGISTRY.get(id);
}

export function listActions(): BusinessAction[] {
  return [...REGISTRY.values()];
}

/**
 * Only mock connections run every registered action. Any other mode (live, or one added later)
 * runs only the actions listed in BUSINESS_ACTIONS_ENABLED, by exact id (fail closed).
 */
export function actionEnabled(
  action: BusinessAction,
  mode: string,
  enabled: readonly string[],
): boolean {
  return mode === 'mock' || enabled.includes(action.id);
}

/** Every table the action writes: its entity, then the entity of its child rows. */
export function actionEntities(action: BusinessAction): string[] {
  const all = [action.entity, action.children?.entity, action.parent];
  return [...new Set(all.filter((e): e is string => e !== undefined))];
}

/** A word for the plan summary and the strong phrase: `CACSP.cancelarNota` → `CACSP_CANCELARNOTA`. */
export function actionWord(action: BusinessAction): string {
  return action.id.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

/** Key-order independent JSON of a validated input. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

const STATEMENT = /^ACTION ([A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*) (\{[\s\S]*\})$/;

/**
 * The statement a plan stores for an action (its `sql`, hashed into the plan): the action id and
 * the canonical JSON of the validated input. It is never sent anywhere.
 */
export function actionStatement(action: BusinessAction, input: Record<string, unknown>): string {
  return `ACTION ${action.id} ${canonicalJson(input)}`;
}

/**
 * Parses a stored action statement back, validating the input again. Undefined for anything that
 * is not exactly a statement of a registered action with a valid input (fail closed).
 */
export function parseActionStatement(
  sql: string,
): { action: BusinessAction; input: Record<string, unknown> } | undefined {
  const m = STATEMENT.exec(sql);
  if (!m) return undefined;
  const action = findAction(m[1]!);
  if (!action) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(m[2]!);
  } catch {
    return undefined;
  }
  const parsed = action.input.safeParse(raw);
  if (!parsed.success) return undefined;
  if (actionStatement(action, parsed.data) !== sql) return undefined;
  return { action, input: parsed.data };
}
