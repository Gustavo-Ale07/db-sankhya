import type { PGlite } from '@electric-sql/pglite';
import { addDays, createRandom, fakeCnpj, fakeEan, pad, type Random } from './random';

/**
 * Fictitious demo dataset for the mock gateway. Table and column names follow the Sankhya
 * naming style so the explorer looks familiar, but every row is invented: company names come
 * from word lists, e-mails use `@demo.example`, CNPJs have deliberately wrong check digits.
 *
 * The dictionary tables (TDDTAB, TDDCAM, TDDINS) describe the demo tables. Their column set is a
 * plausible subset; the real dictionary differs between versions (audit §3.5).
 */

/** Data dictionary field types used by the mock: integer, string, float, date, date-time. */
export type MockFieldType = 'I' | 'S' | 'F' | 'D' | 'H';

export interface MockColumn {
  name: string;
  type: MockFieldType;
  description: string;
  size?: number;
}

export interface MockTable {
  /** Physical table name. */
  table: string;
  /** Entity (instance) name used by loadRecords and DatasetSP.save. */
  entity: string;
  description: string;
  columns: MockColumn[];
  /** Primary key columns. Single integer keys are generated on insert as max + 1. */
  pk: string[];
}

const col = (name: string, type: MockFieldType, description: string, size?: number): MockColumn =>
  size === undefined ? { name, type, description } : { name, type, description, size };

export const MOCK_TABLES: readonly MockTable[] = [
  {
    table: 'TSICID',
    entity: 'Cidade',
    description: 'Cidades (demo)',
    pk: ['CODCID'],
    columns: [
      col('CODCID', 'I', 'Código da cidade'),
      col('NOMECID', 'S', 'Nome da cidade', 60),
      col('UF', 'S', 'UF', 2),
    ],
  },
  {
    table: 'TGFPAR',
    entity: 'Parceiro',
    description: 'Parceiros (demo)',
    pk: ['CODPARC'],
    columns: [
      col('CODPARC', 'I', 'Código do parceiro'),
      col('NOMEPARC', 'S', 'Nome do parceiro', 100),
      col('RAZAOSOCIAL', 'S', 'Razão social', 100),
      col('CGC_CPF', 'S', 'CNPJ/CPF', 20),
      col('EMAIL', 'S', 'E-mail', 80),
      col('CODCID', 'I', 'Cidade'),
      col('CLIENTE', 'S', 'É cliente', 1),
      col('FORNECEDOR', 'S', 'É fornecedor', 1),
      col('ATIVO', 'S', 'Ativo', 1),
      col('DTCAD', 'D', 'Data de cadastro'),
    ],
  },
  {
    table: 'TGFPRO',
    entity: 'Produto',
    description: 'Produtos (demo)',
    pk: ['CODPROD'],
    columns: [
      col('CODPROD', 'I', 'Código do produto'),
      col('DESCRPROD', 'S', 'Descrição', 100),
      col('REFERENCIA', 'S', 'Referência (EAN)', 20),
      col('CODVOL', 'S', 'Unidade', 4),
      col('VLRVENDA', 'F', 'Preço de venda'),
      col('ATIVO', 'S', 'Ativo', 1),
    ],
  },
  {
    table: 'TGFCAB',
    entity: 'CabecalhoNota',
    description: 'Cabeçalho de notas (demo)',
    pk: ['NUNOTA'],
    columns: [
      col('NUNOTA', 'I', 'Número único'),
      col('NUMNOTA', 'I', 'Número da nota'),
      col('CODPARC', 'I', 'Parceiro'),
      col('DTNEG', 'D', 'Data de negociação'),
      col('TIPMOV', 'S', 'Tipo de movimento', 1),
      col('VLRNOTA', 'F', 'Valor da nota'),
      col('STATUSNOTA', 'S', 'Status', 1),
    ],
  },
  {
    table: 'TGFITE',
    entity: 'ItemNota',
    description: 'Itens de notas (demo)',
    pk: ['NUNOTA', 'SEQUENCIA'],
    columns: [
      col('NUNOTA', 'I', 'Número único'),
      col('SEQUENCIA', 'I', 'Sequência'),
      col('CODPROD', 'I', 'Produto'),
      col('QTDNEG', 'F', 'Quantidade'),
      col('VLRUNIT', 'F', 'Valor unitário'),
      col('VLRTOT', 'F', 'Valor total'),
    ],
  },
  {
    table: 'TGFEST',
    entity: 'Estoque',
    description: 'Estoque (demo)',
    pk: ['CODEMP', 'CODPROD', 'CODLOCAL'],
    columns: [
      col('CODEMP', 'I', 'Empresa'),
      col('CODPROD', 'I', 'Produto'),
      col('CODLOCAL', 'I', 'Local'),
      col('ESTOQUE', 'F', 'Quantidade em estoque'),
    ],
  },
  {
    table: 'AD_EXEMPLO',
    entity: 'AD_EXEMPLO',
    description: 'Tabela personalizada de exemplo (demo)',
    pk: ['ID'],
    columns: [
      col('ID', 'I', 'Identificador'),
      col('DESCRICAO', 'S', 'Descrição', 100),
      col('VALOR', 'F', 'Valor'),
      col('CRIADOEM', 'D', 'Criado em'),
    ],
  },
];

const DICTIONARY_DDL = `
CREATE TABLE TDDTAB (NOMETAB varchar(30) PRIMARY KEY, DESCRTAB varchar(100));
CREATE TABLE TDDCAM (NUCAMPO integer PRIMARY KEY, NOMETAB varchar(30) NOT NULL,
  NOMECAMPO varchar(30) NOT NULL, DESCRCAMPO varchar(100), TIPCAMPO varchar(1), TAMANHO integer,
  ORDEM integer);
CREATE TABLE TDDINS (NOMEINSTANCIA varchar(60) PRIMARY KEY, NOMETAB varchar(30) NOT NULL,
  DESCRINSTANCIA varchar(100));
`;

/**
 * Oracle-shaped catalog views and the two session functions the metadata queries use, built over
 * Postgres' information_schema so the mock answers the same SQL a real Oracle or SQL Server
 * gateway would (INFORMATION_SCHEMA itself already exists in Postgres). Mock-only.
 */
const CATALOG_DDL = `
CREATE FUNCTION sys_context(ns text, name text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$ SELECT 'PUBLIC'::text $$;
CREATE FUNCTION schema_name() RETURNS text
  LANGUAGE sql IMMUTABLE AS $$ SELECT 'public'::text $$;
CREATE VIEW ALL_CONSTRAINTS AS
  SELECT upper(constraint_schema::text) AS owner, upper(constraint_name::text) AS constraint_name,
    CASE constraint_type WHEN 'PRIMARY KEY' THEN 'P' WHEN 'FOREIGN KEY' THEN 'R'
      WHEN 'UNIQUE' THEN 'U' ELSE 'C' END AS constraint_type,
    upper(table_name::text) AS table_name
  FROM information_schema.table_constraints WHERE table_schema = 'public';
CREATE VIEW ALL_CONS_COLUMNS AS
  SELECT upper(constraint_schema::text) AS owner, upper(constraint_name::text) AS constraint_name,
    upper(table_name::text) AS table_name, upper(column_name::text) AS column_name,
    ordinal_position AS position
  FROM information_schema.key_column_usage WHERE table_schema = 'public';
`;

const PG_TYPE: Record<MockFieldType, string> = {
  I: 'integer',
  S: 'varchar',
  F: 'numeric(14,2)',
  D: 'date',
  H: 'timestamp',
};

export function findTableByEntity(entity: string): MockTable | undefined {
  return MOCK_TABLES.find((t) => t.entity === entity);
}

function ddl(t: MockTable): string {
  const cols = t.columns.map((c) => {
    const type = c.type === 'S' ? `varchar(${c.size ?? 100})` : PG_TYPE[c.type];
    return `${c.name} ${type}`;
  });
  return `CREATE TABLE ${t.table} (${cols.join(', ')}, PRIMARY KEY (${t.pk.join(', ')}));`;
}

const PREFIXES = ['Alfa', 'Boreal', 'Cobalto', 'Delta', 'Estrela', 'Fênix', 'Granito', 'Horizonte'];
const CORES = ['Azul', 'Verde', 'Prata', 'Rubi', 'Âmbar', 'Jade'];
const KINDS = ['Comércio', 'Distribuidora', 'Indústria', 'Serviços', 'Atacado'];
const CITY_A = ['Vila', 'Porto', 'Campo', 'Serra', 'Vale', 'Monte'];
const CITY_B = ['Aurora', 'Sereno', 'Claro', 'Alegre', 'Dourado', 'Novo'];
const UFS = ['SP', 'MG', 'PR', 'SC', 'RS', 'GO'];
const PRODUCT_A = ['Parafuso', 'Arruela', 'Cabo', 'Painel', 'Conector', 'Filtro', 'Válvula'];
const PRODUCT_B = ['M6', 'M8', 'Inox', 'Reforçado', 'Compacto', 'Industrial'];
const UNITS = ['UN', 'CX', 'KG', 'MT'];

const BASE_DATE = new Date(Date.UTC(2025, 0, 2));

const iso = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;

/** Creates the dictionary and demo tables in `db` and fills them deterministically from `seed`. */
export async function seedMockDataset(db: PGlite, seed: number): Promise<void> {
  const rand = createRandom(seed);
  await db.exec(DICTIONARY_DDL + MOCK_TABLES.map(ddl).join('\n') + CATALOG_DDL);

  let nucampo = 1;
  const tddtab: unknown[][] = [];
  const tddcam: unknown[][] = [];
  const tddins: unknown[][] = [];
  for (const t of MOCK_TABLES) {
    tddtab.push([t.table, t.description]);
    tddins.push([t.entity, t.table, t.description]);
    t.columns.forEach((c, i) => {
      tddcam.push([nucampo++, t.table, c.name, c.description, c.type, c.size ?? null, i + 1]);
    });
  }
  await insertRows(db, 'TDDTAB', ['NOMETAB', 'DESCRTAB'], tddtab);
  await insertRows(db, 'TDDINS', ['NOMEINSTANCIA', 'NOMETAB', 'DESCRINSTANCIA'], tddins);
  await insertRows(
    db,
    'TDDCAM',
    ['NUCAMPO', 'NOMETAB', 'NOMECAMPO', 'DESCRCAMPO', 'TIPCAMPO', 'TAMANHO', 'ORDEM'],
    tddcam,
  );

  const cities = Array.from({ length: 12 }, (_, i) => [
    i + 1,
    `${rand.pick(CITY_A)} ${rand.pick(CITY_B)}`,
    rand.pick(UFS),
  ]);
  await insertRows(db, 'TSICID', ['CODCID', 'NOMECID', 'UF'], cities);

  const partners = Array.from({ length: 60 }, (_, i) => partner(rand, i + 1, cities.length));
  await insertRows(db, 'TGFPAR', columnNames('TGFPAR'), partners);

  const products = Array.from({ length: 80 }, (_, i) => [
    i + 1,
    `${rand.pick(PRODUCT_A)} ${rand.pick(PRODUCT_B)} ${pad(i + 1, 3)}`,
    fakeEan(rand),
    rand.pick(UNITS),
    rand.money(2, 900),
    rand.chance(0.9) ? 'S' : 'N',
  ]);
  await insertRows(db, 'TGFPRO', columnNames('TGFPRO'), products);

  const headers: unknown[][] = [];
  const items: unknown[][] = [];
  for (let n = 1; n <= 120; n++) {
    const lines = rand.int(1, 4);
    let total = 0;
    for (let s = 1; s <= lines; s++) {
      const qty = rand.int(1, 20);
      const unit = rand.money(2, 500);
      const line = Math.round(qty * unit * 100) / 100;
      total += line;
      items.push([n, s, rand.int(1, products.length), qty, unit, line]);
    }
    headers.push([
      n,
      1000 + n,
      rand.int(1, partners.length),
      iso(addDays(BASE_DATE, rand.int(0, 540))),
      rand.pick(['V', 'C', 'P']),
      Math.round(total * 100) / 100,
      rand.pick(['L', 'L', 'L', 'A', 'P']),
    ]);
  }
  await insertRows(db, 'TGFCAB', columnNames('TGFCAB'), headers);
  await insertRows(db, 'TGFITE', columnNames('TGFITE'), items);

  const stock: unknown[][] = [];
  for (let p = 1; p <= products.length; p++) {
    stock.push([1, p, 101, rand.int(0, 500)]);
    if (rand.chance(0.3)) stock.push([1, p, 102, rand.int(0, 120)]);
  }
  await insertRows(db, 'TGFEST', columnNames('TGFEST'), stock);

  const examples = Array.from({ length: 10 }, (_, i) => [
    i + 1,
    `Registro de exemplo ${i + 1}`,
    rand.money(1, 1000),
    iso(addDays(BASE_DATE, i * 7)),
  ]);
  await insertRows(db, 'AD_EXEMPLO', columnNames('AD_EXEMPLO'), examples);
}

function partner(rand: Random, id: number, cityCount: number): unknown[] {
  const name = `${rand.pick(PREFIXES)} ${rand.pick(CORES)} ${rand.pick(KINDS)}`;
  const slug = name
    .normalize('NFD')
    .replace(/[^A-Za-z ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '.');
  const isClient = rand.chance(0.75);
  return [
    id,
    `${name} ${pad(id, 3)}`,
    `${name} Ltda (Demo)`,
    fakeCnpj(rand),
    `contato.${slug}.${pad(id, 3)}@demo.example`,
    rand.int(1, cityCount),
    isClient ? 'S' : 'N',
    isClient ? (rand.chance(0.2) ? 'S' : 'N') : 'S',
    rand.chance(0.9) ? 'S' : 'N',
    iso(addDays(BASE_DATE, -rand.int(0, 900))),
  ];
}

function columnNames(table: string): string[] {
  const t = MOCK_TABLES.find((x) => x.table === table);
  if (!t) throw new Error(`Unknown mock table ${table}`);
  return t.columns.map((c) => c.name);
}

async function insertRows(db: PGlite, table: string, columns: string[], rows: unknown[][]) {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const marks = row.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    return `(${marks.join(', ')})`;
  });
  await db.query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`,
    params,
  );
}
