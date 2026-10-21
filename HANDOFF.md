# HANDOFF — Rodada 2 (Prompt v2/v2.1), ponto de parada 21/10/2026

## Estado do git

- Branch: `fix/metadata-on-demand`
- SHA antes deste commit de parada: `e864cd3` (o commit de parada `wip(rodada 2)` vem logo acima dele)
- Base publicada: `origin/fix/metadata-on-demand` = `7e3d408`
- Commits locais ainda não enviados para `fix/metadata-on-demand` (`git log origin/fix/metadata-on-demand..HEAD --oneline`, antes do commit de parada):
  - `e864cd3` fix(api): bound the hybrid split before parsing its subqueries
  - `3d26c95` feat(api): run tmp_ and hybrid SELECTs from the main editor in the caller's scratch
  - `ebad8a5` feat(api): create a plain scratch table for CREATE TEMPORARY TABLE
  - `86ea798` feat(sql-engine): split a hybrid read into its Sankhya parts
- Backup remoto: `backup/rodada-2-2026-10-21` (nada foi enviado para `fix/metadata-on-demand`, `migration` ou `main` nesta rodada).

## PRONTO e testado (ambiente: testes locais com mock + PGlite)

- **A1** — `POST /api/query` com um SELECT que só lê `tmp_*` roda no scratch do usuário (`source: 'scratch'`), sem chamar o gateway; a política vale (QUERY.SELECT, limite de linhas, DENY de coluna); há isolamento entre usuários.
- **A2 (API)** — SELECT híbrido (tmp_* + Sankhya) num passo só (`source: 'hybrid'`, `hybrid.parts` com tabelas, linhas e corte):
  - cada parte Sankhya roda uma vez e é materializada em tabela efêmera, que é sempre apagada (inclusive em erro, negação e cancelamento);
  - exige QUERY.SELECT + TEMP.MATERIALIZE; teto = min(SANKHYA_MAX_ROWS, MATERIALIZE_MAX_ROWS, política);
  - o que não se decompõe dá SQL_UNSUPPORTED; há limite de partes/subconsultas antes de qualquer parse (correção do review de segurança).
- **CREATE TEMPORARY TABLE** no scratch vira tabela comum do scratch.
- Arquivos de teste (verdes quando rodados nesta rodada):
  - `packages/sql-engine/src/hybrid.test.ts` (6);
  - `apps/api/src/routes/query-scratch.int.test.ts` (12);
  - `apps/api/src/services/scratch-guard.test.ts` (75).
- Regressão conferida na época: policy-enforcement + app int 101/101; sql-engine 325; `tsc` da API 0; eslint 0.
- **Gates completos NÃO foram rodados depois desses commits** (nem e2e). Não afirmar CI verde: não houve push para a branch de trabalho.

## PELA METADE

- `apps/api/src/services/metadata.ts` — leitura global de PKs paginada (escopo novo: o catálogo da base de testes veio `degraded: PK:truncated`).
  - Feito: `pkRead(dialect)`, um `PagedRead` por `TABLE_NAME, COLUMN_NAME` sobre `(pkSql) K`, com chave `TABLE.COLUMN`. Em `discover()`, usa `readPaged` com fallback para a leitura única.
  - Compila: **não verificado** (o tsc não foi rodado; o código é TypeScript plausível).
  - **Bug conhecido:** em `PK_KEY` o ponto saiu sem barra: `/^([A-Za-z0-9_$#]{1,128}).([A-Za-z0-9_$#]{1,128})$/` deve ser `\.`. Hoje ele casa com qualquer caractere, e o split da chave fica errado para nomes com `_`/`$`/`#` em certas posições.
  - Próximo passo exato: corrigir `\.`, rodar `cd apps/api && pnpm exec vitest run src/services/metadata.int.test.ts --maxWorkers=1`, depois `pnpm exec tsc --noEmit -p .`, eslint e prettier no arquivo.
  - Conferir também se a primeira página no SQL Server (`ORDER BY` sobre a derivada `K`) é aceita.
- `apps/api/src/services/metadata.int.test.ts` — testes da paginação de PK.
  - Novos: "pages the primary keys by table and column name; every key is marked" e "reports the keys as cut when a later page of them fails".
  - Ajustados: a expectativa `degraded` de dois testes existentes não inclui mais `PK:truncated`.
  - Estavam **vermelhos (4 falhas) antes da implementação**; ainda não foram rodados com a implementação.
- `apps/web/src/api/types.ts` — `QueryResult.source` e `QueryResult.hybrid` já tipados (commitado). A UI ainda **não** mostra o selo de origem nem as partes do híbrido (resto de A2/A5).
- Não iniciados:
  - A3 (CTAS no editor com preview e "Confirmar criação");
  - A4 (DDL/DML em tmp_* pelo mesmo diálogo, com BEFORE/AFTER e "N linhas serão perdidas");
  - A5 (grupo "Temporárias (tmp_*)" na árvore, autocomplete, selo no grid);
  - A6 (página Scratch secundária);
  - A7 (E2E com zero chamadas de escrita ao mock);
  - Trilha B (script de sondagem em `scripts/`, B1/B2/B3);
  - Fase 7 (docs) e Fase 8 (gates finais, revisão do diff, push).

## BLOQUEADO esperando o usuário

- **Fase 0.6 (marca na base de testes):**
  - As chamadas a `127.0.0.1:3001` foram liberadas. O caminho de escrita local foi montado só no PGlite local (`.pglite/`, git-ignorado), sem dar escrita ao ADMIN:
    - admin local `granter@example.com` (ADMIN, OPERATOR) via `pnpm admin bootstrap --force-additional`, aprovado pelo usuário;
    - usuário `probe@example.com` (OPERATOR);
    - política ALLOW criada pelo admin sem DATA.* (a segregação de funções barrou as outras combinações, como esperado), limitada a HOMOLOGATION + uma tabela AD_* pequena (nome dito na conversa) com QUERY.SELECT, DATA.PREVIEW e DATA.UPDATE.
  - Preview OK: 1 linha, BEFORE/AFTER corretos, `execution.available=true`.
  - O execute (DatasetSP.save) voltou `status: failed`, `UNVERIFIED`, `errorCode: SANKHYA_AUTH_ERROR`. O read-back mostrou o valor **inalterado**.
  - A mensagem bruta do gateway ainda não foi capturada: o log da API não a registra; consultar a auditoria (`gatewayCalls`/`errorMessage`), que deu 429 no login por rate limit.
  - Próximo passo: ler a auditoria, registrar a resposta bruta e decidir com o usuário (o app/token do sandbox pode não ter permissão para DatasetSP.save).
  - Como não houve marca, **não há nada a conferir na produção ainda**; a conferência do usuário segue pendente.
- **Trilha B (sondagem B0 em AD_DBX_PROBE):** só depois da Fase 0.6, um comando por vez.

## Números observados na base de testes (somente leitura, API local, 21/10/2026)

| Item | Valor |
| --- | --- |
| `/health/ready` | 200 |
| `/api/status` | sankhya READY live; writes available=true, productionAvailable=false |
| TDDTAB | 3271 (= tabelas do catálogo) |
| TDDCAM | 44043 (= colunas do catálogo) |
| TDDINS | 3875 |
| `degraded` | `["PK:truncated"]` |
| Primeira carga de `/api/schema` | ~6,7 s (6689 ms) |
| Dialeto | Oracle (`SELECT 1 FROM DUAL` ok; TSIVER fora do catálogo; `LIKE … ESCAPE` dá SQL_PARSE_ERROR no parser) |

A base de testes contém dados de aparência real da empresa: nunca levá-los para o repositório.

## Segurança

Produção intocada; nenhuma escrita em nenhuma base; credenciais só no .env local git-ignorado.

Ressalva factual: houve **uma tentativa** de UPDATE (a marca da Fase 0.6) na base de **testes**. O gateway a recusou (SANKHYA_AUTH_ERROR) e o read-back confirmou que nada mudou. Nenhuma chamada foi feita à produção.

## Retomar

1. `git status`, `git log --oneline -6`.
2. Corrigir `PK_KEY` e rodar `metadata.int.test.ts`.
3. API local: `cd apps/api && pnpm exec tsx --env-file=../../.env src/server.ts` (PGlite é single-process: não rodar o CLI `pnpm admin` com a API aberta).
4. Seguir A3 → A7, depois Trilha B, respeitando os limites de recurso (no máximo 2 auxiliares; uma suíte pesada por vez).
