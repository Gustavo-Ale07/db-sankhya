# HANDOFF — Rodada 2 (Prompt v2/v2.1), 22/10/2026

## Estado do git

- Branch: `fix/metadata-on-demand`; `origin/fix/metadata-on-demand` = `f356880` (gates verdes). O commit seguinte (só docs: guia de publicação + este HANDOFF) foi enviado só para o backup.
- Backup remoto atualizado a cada etapa: `backup/rodada-2-2026-10-21`.
- Nada foi enviado para `migration` ou `main`; não houve deploy nem acesso à VPS.

## PRONTO e onde foi provado

"mock" = gateway mock + PGlite (testes unitários, de integração e E2E). "base de testes" = Sankhya de testes da empresa pela API local. Produção: nunca.

| Item                                           | O que faz                                                                                                                                                                                                        | Onde foi provado                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| PKs paginadas (`8f2b0fa`)                      | Leitura global de PKs paginada por `TABLE_NAME, COLUMN_NAME`, contada, com corte silencioso detectado                                                                                                            | mock (`metadata.int.test.ts` 45/45); base de testes: **não verificado** depois da mudança |
| Selo de origem e partes do híbrido (`96f7e73`) | O grid mostra Sankhya / temporária / híbrido, a conexão e as partes copiadas                                                                                                                                     | mock (testes web)                                                                         |
| A1/A2                                          | SELECT só de `tmp_` no scratch; SELECT híbrido num passo (parte Sankhya em WITH/subconsulta)                                                                                                                     | mock (integração + E2E)                                                                   |
| A3 (`0b5da09`)                                 | `CREATE TABLE tmp_… AS SELECT` do Sankhya com prévia (colunas, tipos, contagem, aviso de corte) e "Confirmar criação"                                                                                            | mock (integração)                                                                         |
| A4 (`52662be`, `d08863a`)                      | DML/DDL de `tmp_*` pelo mesmo diálogo: dry run transacional, estrutura ANTES/DEPOIS, "N linhas serão perdidas", VERIFIED/FAILED                                                                                  | mock (integração, web, E2E)                                                               |
| A5 (`057625a`, `92e7d7c`)                      | Grupo "Temporárias (tmp_*)" no topo da árvore, com TTL, colunas e linhas, relido após cada comando; autocomplete com `tmp_*`                                                                                     | mock (integração + web + E2E)                                                             |
| A6 (`45aa551`)                                 | Página Scratch secundária ("Scratch (avançado)", depois de Status)                                                                                                                                               | mock (web + E2E)                                                                          |
| A7 (`5639a6a`)                                 | E2E `e2e/tests/editor-tmp.spec.ts`: cria do TGFPAR, insere, cruza com TGFPAR, altera, apaga com confirmação; o log de chamadas do mock (`SANKHYA_MOCK_CALL_LOG`, só nomes de serviço) só tem serviços de leitura | mock (E2E)                                                                                |
| Fase 7 (`6f28c04`)                             | `capabilities.md` (matriz comando × origem × ambiente, decisões pendentes), `sankhya.md` (respostas brutas, números do dicionário, DBEXPMAXROW), `security.md`, `troubleshooting.md`, `operations.md`            | —                                                                                         |

## Diagnóstico do SANKHYA_AUTH_ERROR (Fase 0.6), só leitura

- `DatasetSP.save` na base de testes: HTTP 200, corpo `{"serviceName":"DatasetSP.save","status":"0","pendingPrinting":"false","transactionId":"<id>","statusMessage":"Não autorizado"}`. O read-back mostrou o valor inalterado. Uma tentativa só, sem repetição e sem outro serviço de escrita.
- A mesma credencial: `DbExplorerSP.executeQuery` HTTP 200 / `status "1"`; `CRUDServiceProvider.loadRecords` em Parceiro/TGFPAR HTTP 200 / `status "1"` (50 registros).
- Em uma frase: no portal da Sankhya, o usuário/app de integração dessas credenciais da sandbox precisa receber permissão para o serviço `DatasetSP.save` (escrita na entidade da tabela `AD_*` usada); autenticação e leitura já funcionam.
- Como não houve marca, não há nada a conferir na produção.

## Guia de publicação controlada (preparado, NÃO executado)

`docs/operations.md#controlled-publication`: backup (`pre-upgrade.dump` + commit em execução `0ddc4bd`), conferir que não há migration nova desde `0ddc4bd`, build só do contêiner `app` com `GIT_COMMIT` (`docker compose build app` + `up -d --no-deps app`), switches inalterados (`SAFE_MODE=true`, `GLOBAL_WRITE_ENABLED=false`, `WRITE_TO_SANKHYA=false`, `.env` intocado), health, smoke só leitura e rollback para `0ddc4bd` sem restaurar dump.

Smoke novo: `GET /api/schema` sem `degraded` (ou anotar a lista, ex. `PK:truncated`); grupo "Temporárias (tmp\_\*)" no topo da árvore; `CREATE TABLE tmp_smoke AS SELECT` pequeno mostra a prévia. **Atenção:** com `GLOBAL_WRITE_ENABLED=false` o "Confirmar criação" fica desabilitado (`execution.available=false`; o execute responderia `READ_ONLY_MODE`). Confirmar de verdade exige `GLOBAL_WRITE_ENABLED=true` — **decisão pendente do usuário**, fora do upgrade (mesmo assim nada iria ao Sankhya com `WRITE_TO_SANKHYA=false`).

## Liberação da escrita na sandbox (checklist entregue ao usuário, não verificado)

Portal (app da sandbox): o app/credencial está vinculado ao ambiente de testes e tem autorização para `DatasetSP.save` (ou, se o portal só autoriza os serviços da lista oficial, `CRUDServiceProvider.saveRecord`). ERP de testes: usuário de integração ativo, grupo com Incluir/Alterar na tela/entidade da tabela `AD_*` da marca, sem restrição a só consulta. Nenhuma nova tentativa de escrita até o usuário confirmar.

## PENDENTE

- **Fase 0.6 / Trilha B (B0–B3): não verificado.** Espera o usuário dizer que a escrita na sandbox foi liberada. Então: refazer a marca (uma linha, uma coluna de `AD_*`, base de testes), o usuário confere a produção, reverter, e só então a sondagem B0 em `AD_DBX_PROBE`, um comando por vez.
- **Decisões pendentes** (todas fail-closed hoje, detalhadas em `docs/capabilities.md#pending-decisions`): DDL nativa; registro no dicionário oficial; `DatasetSP.save` × `saveRecord`; retenção de planos; `POST /api/scratch/exec` sem diálogo na página Scratch.
- Conferir na base de testes, só leitura, se o catálogo deixou de vir `PK:truncated` depois da paginação de PKs.

## Gates (Fase 8)

Rodados em 22/10/2026, em foreground, um por vez, no SHA anterior a este commit (só o HANDOFF mudou depois): lint 0; format:check 0 nos arquivos versionados (só acusa `.superpowers/`, ignorado pelo git); typecheck 0; test 0 (88 arquivos, 1826 testes); build 0; drizzle-kit check 0; e2e 0 (35/35). Depois disso: push normal em `fix/metadata-on-demand`.

## Segurança

Produção intocada: nenhuma chamada, leitura ou escrita. Na base de testes houve uma única tentativa de escrita (a marca da Fase 0.6), recusada pelo gateway e sem efeito. Credenciais só no `.env` local git-ignorado, nunca impressas.

## Retomar

1. `git status --short --branch`, `git log --oneline -8`.
2. API local: `cd apps/api && pnpm exec tsx --env-file=../../.env src/server.ts` (PGlite é single-process: não rodar `pnpm admin` com a API aberta).
3. Trilha B só com a liberação do usuário. Limites de recurso: no máximo 2 auxiliares; uma suíte pesada por vez.
