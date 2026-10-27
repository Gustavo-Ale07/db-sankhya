# HANDOFF — Rodada 2 (Prompt v2/v2.1) + Rodada 3 (ações nativas), 22/10/2026

## Estado em 27/10/2026 (noite, 2) — correção: ID do registro de controle da rota server-side

- **Incidente (13:28:42Z, requestId `d627cf00-…`, planId `0f1b00e8-…`):** `CREATE TABLE AD_DBX_TESTE (ID NUMBER)` pela UI. O `DatasetSP.save` na `AD_MANIPULADADOS` funcionou, mas o save pedia só `fields: ['TEXTO']`, e o gateway devolve os valores dos campos pedidos: o retorno não trazia o `ID`. `extractRecordId` pegava "o primeiro texto" (o bloco PL/SQL) como chave; a ação 98 e o `removeRecords` foram chamados com `ID = <bloco>` e falharam (`SANKHYA_API_ERROR`). A resposta crua não foi logada (`LOG_LEVEL=info`, sem corpo).
- **Órfão provável:** um registro na `AD_MANIPULADADOS` com o TEXTO do `CREATE TABLE AD_DBX_TESTE`. Não removido por código (entidade de controle é alvo reservado); fica com o usuário.
- **Correção:** o save pede `fields: ['ID', 'TEXTO']` com valor só em `TEXTO` (continua INSERT sem pk; ID gerado pela Sankhya). `extractRecordId(results, fields, keyField)` lê a posição da coluna `ID`, exige exatamente uma linha do tamanho de `fields` e um inteiro positivo; senão `SANKHYA_BAD_RESPONSE` sem disparar a ação. Falhas de save/ação/limpeza logam `step`, `errorCode` e `gatewayMessage` (texto da Sankhya, redigido).
- **Ainda não provado na base real:** que o gateway ecoa o `ID` gerado quando ele está em `fields`. Se não ecoar, a rota para com `SANKHYA_BAD_RESPONSE` antes da ação 98 (e o novo log mostra o formato do retorno).

## Estado em 27/10/2026 (noite) — tela de Políticas oferece as ações SERVER.\*

- **Problema:** a edição de política (`PoliciesPage.tsx`) tinha uma lista fixa de ações sem `SERVER.DDL/DELETE/DML_RAW/DCL/PLSQL`, então não dava para conceder a rota server-side pela UI. O backend já as aceitava (`validatePolicyRule` valida contra `PERMISSIONS`; a rota admin não tem allowlist própria).
- **Correção:** a lista virou `POLICY_ACTION_OPTIONS` em `apps/web/src/admin/logic.ts` (o web não importa `@dbx/shared` no bundle), agora com as 5 `SERVER.*`. Um teste (`logic.test.ts`) a compara com o catálogo (`PERMISSIONS` menos as só-RBAC: `DATA.PREVIEW`, `APPROVAL.*`, `AUDIT.*`, `ADMIN.*`, `SECURITY.*`), então dessincronizar quebra o teste. Backend sem mudança.
- **Testes novos:** `AdminPages.test.tsx` (as 5 caixas aparecem e vão no POST); `mutations.int.test.ts` (regra ALLOW `SERVER.DDL`, usuário, PRODUÇÃO, todas as tabelas, salva pela rota admin → `invalid` vazio; antes dela a prévia de `CREATE TABLE AD_DBX_TESTE (ID NUMBER)` dá `FORBIDDEN` "denied by policy", depois planeja `SERVER.DDL`).
- **Políticas existentes:** não alteradas; a regra "Teste" o usuário edita pela UI.

## Estado em 27/10/2026 (tarde) — correção: o editor agora leva DDL Oracle/MERGE/GRANT/PL-SQL à prévia

- **Bug:** pela UI, `CREATE TABLE AD_DBX_TESTE (ID NUMBER)` voltava `SQL_FORBIDDEN` ("keyword CREATE is not allowed in a read"). O parser PG/T-SQL classifica DDL com tipo Oracle, `MERGE`, `GRANT` e PL/SQL como `UNKNOWN`; o `/api/query` mandava `UNKNOWN` ao gate de leitura. Além disso, `serverSqlEligible` excluía DDL sobre `AD_*`, então `DROP TABLE AD_DBX_TESTE` (reconhecido como `DROP_TABLE`) seria recusado na prévia.
- **Correção:** com `SERVER_SQL_ENABLED=true`, o `/api/query` usa `serverSqlEligible` (a mesma regra da prévia) e devolve o ponteiro para `/api/query/preview`; a UI já segue o ponteiro (não classifica SQL) e mostra EXECUÇÃO DIRETA. DDL `AD_*` passou a ser elegível; `AD_MANIPULADADOS` segue bloqueada como alvo; `/api/ddl` inalterado. Desligado, comportamento idêntico (provado rodando o teste "off" contra o código anterior).
- **Testes novos (`mutations.int.test.ts`, "/api/query routing (the editor path)"):** em PRODUÇÃO com SERVER_SQL + opt-in, `CREATE TABLE AD_DBX_TESTE (ID NUMBER)`, `DROP TABLE AD_DBX_TESTE`, `DELETE` genérico, `MERGE`, `GRANT` e `BEGIN NULL; END;` fazem ponteiro → prévia `SERVER.<cat>` com confirmação forte → execute despacha (save/ação/remove, cliente fake); `SELECT` continua leitura; `DROP TABLE AD_MANIPULADADOS` recusado; desligado, as mesmas respostas de antes. Contra o código anterior, 5 dos 6 casos "ligado" falhavam (reproduzindo o bug).
- **Prova real:** continua com o usuário, pela UI (`CREATE`/`DROP AD_DBX_TESTE`, prévia → confirmação).

## Estado em 27/10/2026 — fase 2: rota server-side completa liberada em produção

- **Código:** o gate de escopo de produção (`assertServerSqlEnvironmentScope`) deixou de restringir PRODUÇÃO a `UPDATE`. `SERVER_SQL_PRODUCTION_VERBS` passou a ser todo verbo que a rota classifica (DDL, `DELETE`, DML_RAW, DCL, PL/SQL). O gate continua na preparação, na reautorização e no `ServerSqlExecutor.dispatch`, e ainda recusa em PRODUÇÃO (`SERVER_SQL_OUT_OF_SCOPE`) um statement com verbo ilegível (q-quote, sem palavra-chave) ou sem rota.
- **Proteções intactas:** RBAC `SERVER.<categoria>`, política ALLOW deny-wins, `WHERE` obrigatório, confirmação forte em PRODUÇÃO, entidade de controle (`AD_MANIPULADADOS`) bloqueada como alvo, política de leitura das fontes, fail-closed de q-quote, um statement por payload, `SERVER_SQL_ENABLED` + `SERVER_SQL_PRODUCTION_OPT_IN` + `SAFE_MODE=false`.
- **Decisão do responsável:** seguir sem esperar o chamado da AutorizacaoApi; o contrato do `executeJava` (ação `98`, módulo `mge`, `refreshType=NONE`, envelope) será provado pelo primeiro teste do usuário na UI: `CREATE TABLE AD_DBX_TESTE (ID NUMBER)` seguido de `DROP TABLE AD_DBX_TESTE`, cada um por prévia → confirmação. Conferir `EXECUTED`, `cleanup=DELETED` na auditoria e a tabela aparecendo/sumindo no dicionário.
- **Env alvo na VPS:** o mesmo de 26/10 mais `SERVER_SQL_ENABLED=true` e `SERVER_SQL_PRODUCTION_OPT_IN=true`.
- **Rollback:** `SERVER_SQL_ENABLED=false` no `.env` + voltar a imagem anterior (tag de rollback) + `docker compose up -d` do `app`.

## Estado em 26/10/2026 — em produção, escrita UPDATE validada

- **Deploy:** `ed56ff4` (branch `backup/rodada-2-2026-10-21`) em produção na VPS, `/var/www/db-sankhya`, imagem `db-sankhya:latest`; commit confirmado via `/api/meta`. `main` e `migration` intocados.
- **Teste de escrita em PRODUÇÃO:** `UPDATE TGFPAR SET COMPLEMENTO = … WHERE CODPARC = 5778`, resolvido pela instância `Parceiro` (`SANKHYA_WRITE_INSTANCES=TGFPAR:Parceiro`). Resultado **VERIFIED** (gravou, releu no Sankhya e conferiu). Revert também **VERIFIED**: produção voltou ao valor original `de 700/701 ao fim`, sem resíduo.
- **RESOLVIDO — blocker (a) para UPDATE:** o `DatasetSP.save` do Sankhya **está autorizado em produção** para UPDATE simples (`SET coluna = literal` + `WHERE`). Os bloqueios anteriores eram todos do nosso lado (deny-by-default de política + trava multi-instância), não da API Sankhya.
- **Config de produção vigente** (`.env` da VPS, só nomes/valores de switch):

  | Chave                     | Valor                                    |
  | ------------------------- | ---------------------------------------- |
  | `SANKHYA_ENVIRONMENT`     | `PRODUCTION`                             |
  | `SAFE_MODE`               | `false`                                  |
  | `GLOBAL_WRITE_ENABLED`    | `true`                                   |
  | `WRITE_TO_SANKHYA`        | `true`                                   |
  | `SANKHYA_WRITE_INSTANCES` | `TGFPAR:Parceiro`                        |
  | `SERVER_SQL_*`            | ausente (rota server-side **DESLIGADA**) |

- **Caveat:** outras tabelas com várias instâncias no TDDINS continuam recusadas com `OPERATION_NOT_SUPPORTED` até serem mapeadas em `SANKHYA_WRITE_INSTANCES` (`TABELA:Instancia`, separado por vírgula) + recriação do container (`docker compose up -d`, que relê o `.env`).
- **Fase 2 continua bloqueada:** CREATE/DROP/DDL/DELETE via "Executa Banco" (`ActionButtonsSP.executeJava`, ação `98`) aguardam o chamado Sankhya de AutorizacaoApi. **NÃO habilitar `SERVER_SQL_*`** até a liberação + validação do contrato do `executeJava` (blocker (b) abaixo segue aberto).

## Estado em 23/10 — retomar na segunda

Fechamento de semana num ponto seguro. Branch `backup/rodada-2-2026-10-21`, HEAD **`38f8921`** (NÃO enviado: `origin/backup/rodada-2-2026-10-21` segue em `714a0da`). `main` (`f8d6a2e`) e `migration` (`0ddc4bd`) intocados. Árvore limpa.

**Implementado e verde EM MOCK (gateway mock + PGlite; nunca em homologação real nem produção):**

- Rodada 6 — rota de execução direta SERVER_SQL / "Executa Banco": ciclo prévia → confirmação → execução → verificação → auditoria via `ActionButtonsSP.executeJava` (ação `98`, bloco em `TEXTO` de registro `AD_MANIPULADADOS` dedicado criado/apagado pela ferramenta). Desligada por padrão.
- Fiação completa no `MutationService` (`resolveServerSql` prepare, `runServerSql` execute) + `ServerSqlExecutor.dispatch` (save → executeJava → removeRecords), UX neutra na web, docs (`docs/server-sql.md`).
- Extrator de alvo fail-closed (`serverSqlTarget` → `null` quando não resolve) e varredura de fontes/join fechando por padrão — duas revisões de segurança endereçadas.
- CLI read-only `pnpm --filter @dbx/api probe-server-sql` (só SELECT/WITH). Rodado contra homologação real: leitura PROVADA real (`AD_MANIPULADADOS` existe, `ID NUMBER NOT NULL` + `TEXTO CLOB`, 40 linhas, sem erro Sankhya).
- Primitiva de escopo fase-1 de PRODUÇÃO `assertServerSqlEnvironmentScope` + código `SERVER_SQL_OUT_OF_SCOPE` + testes (65/65 no arquivo), commit `38f8921`.

**NÃO feito (próxima tarefa de segunda) — gate de backend fase 1:** a primitiva `assertServerSqlEnvironmentScope` existe e está testada, mas **NÃO está fiada** em lugar nenhum. Falta chamá-la em `resolveServerSql` (preparação) E no `ServerSqlExecutor.dispatch` (execução, exige adicionar `environment` ao `ServerSqlDispatchInput`), fail-closed nos dois pontos, de modo que em PRODUÇÃO fase 1 só `UPDATE` (inclusive com subconsulta/expressão) passe e `DELETE`/`DROP`/`TRUNCATE`/DDL/`MERGE`/`INSERT…SELECT`/DCL/PL-SQL sejam recusados antes de disparar, sem bypass por classificação errada nem por chamada direta à API.

**Blockers reais (independentes do código, continuam abertos):**

- (a) Autorização da API: o usuário de integração em homologação ainda recebe `"status":"0"` / `"Não autorizado"` em `DatasetSP.save` / `ActionButtonsSP.executeJava` / `removeRecords`. Leitura e autenticação funcionam; escrita não.
- (b) Contrato da ação `98` do DBScript não validado empiricamente — parâmetros e envelope de retorno ainda não confirmados contra o servidor real.
- (c) Versão implantada na VPS não confirmada — não há como afirmar o que está rodando lá a partir desta sessão.

**Confirmação por escrito (23/10):** `SERVER_SQL_ENABLED` continua **off**; nada foi para produção nem para a VPS; nenhum deploy; nenhuma escrita real executada; nenhum push (HEAD local `38f8921` à frente de `origin` `714a0da`). `SAFE_MODE=true`, `GLOBAL_WRITE_ENABLED=false`, `WRITE_TO_SANKHYA=false` inalterados.

## Estado do git

- Branch: `fix/metadata-on-demand`; `origin/fix/metadata-on-demand` = `f356880` (gates verdes). O commit seguinte (só docs: guia de publicação + este HANDOFF) foi enviado só para o backup.
- Backup remoto atualizado a cada etapa: `backup/rodada-2-2026-10-21`.
- Nada foi enviado para `migration` ou `main`; não houve deploy nem acesso à VPS.

## PRONTO e onde foi provado

"mock" = gateway mock + PGlite (testes unitários, de integração e E2E). "base de testes" = Sankhya de testes da empresa pela API local. Produção: nunca.

| Item                                           | O que faz                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Onde foi provado                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| PKs paginadas (`8f2b0fa`)                      | Leitura global de PKs paginada por `TABLE_NAME, COLUMN_NAME`, contada, com corte silencioso detectado                                                                                                                                                                                                                                                                                                                                                                                                        | mock (`metadata.int.test.ts` 45/45); base de testes: **não verificado** depois da mudança |
| Selo de origem e partes do híbrido (`96f7e73`) | O grid mostra Sankhya / temporária / híbrido, a conexão e as partes copiadas                                                                                                                                                                                                                                                                                                                                                                                                                                 | mock (testes web)                                                                         |
| A1/A2                                          | SELECT só de `tmp_` no scratch; SELECT híbrido num passo (parte Sankhya em WITH/subconsulta)                                                                                                                                                                                                                                                                                                                                                                                                                 | mock (integração + E2E)                                                                   |
| A3 (`0b5da09`)                                 | `CREATE TABLE tmp_… AS SELECT` do Sankhya com prévia (colunas, tipos, contagem, aviso de corte) e "Confirmar criação"                                                                                                                                                                                                                                                                                                                                                                                        | mock (integração)                                                                         |
| A4 (`52662be`, `d08863a`)                      | DML/DDL de `tmp_*` pelo mesmo diálogo: dry run transacional, estrutura ANTES/DEPOIS, "N linhas serão perdidas", VERIFIED/FAILED                                                                                                                                                                                                                                                                                                                                                                              | mock (integração, web, E2E)                                                               |
| A5 (`057625a`, `92e7d7c`)                      | Grupo "Temporárias (tmp_*)" no topo da árvore, com TTL, colunas e linhas, relido após cada comando; autocomplete com `tmp_*`                                                                                                                                                                                                                                                                                                                                                                                 | mock (integração + web + E2E)                                                             |
| A6 (`45aa551`)                                 | Página Scratch secundária ("Scratch (avançado)", depois de Status)                                                                                                                                                                                                                                                                                                                                                                                                                                           | mock (web + E2E)                                                                          |
| A7 (`5639a6a`)                                 | E2E `e2e/tests/editor-tmp.spec.ts`: cria do TGFPAR, insere, cruza com TGFPAR, altera, apaga com confirmação; o log de chamadas do mock (`SANKHYA_MOCK_CALL_LOG`, só nomes de serviço) só tem serviços de leitura                                                                                                                                                                                                                                                                                             | mock (E2E)                                                                                |
| Rodada 3: "Não autorizado"                     | `"status":"0"` + `"Não autorizado"` numa escrita vira `SANKHYA_WRITE_NOT_AUTHORIZED` (403); o diálogo mostra "Gravação via API não liberada para este usuário no Gateway (DatasetSP.save)"; switches continuam como gate                                                                                                                                                                                                                                                                                     | mock (integração + web)                                                                   |
| Rodada 3: revisão de segurança                 | três achados MEDIUM das ações corrigidos: (1) toda coluna que o corpo envia entra na decisão de política (`writes()` por ação; exclusão decide em todas as colunas, como `*`); (2) ações de item checam a nota `TGFCAB` na política e leem a linha dela antes de qualquer chamada; (3) a política decide nas duas permissões (própria e `SANKHYA.BUSINESS_ACTION.EXECUTE`), um `DENY` em qualquer uma recusa, limites = o mais estrito; a aprovação exige o par exato no capability congelado                | mock (integração, unitário, aprovações)                                                   |
| Rodada 3: ações de nota                        | `CACSP.incluirNota`, `CACSP.incluirAlterarItemNota`, `CACSP.excluirItemNota` além de `cancelarNota`, só com o contrato oficial; permissão própria `SANKHYA.ACTION.*` + `SANKHYA.BUSINESS_ACTION.EXECUTE`; prepare → prévia ANTES/DEPOIS → confirmação → execute → read-back → VERIFIED/FAILED → auditoria; aviso "validado só no mock; testar em HOMOLOGAÇÃO antes de produção"; `SelecaoDocumentoSP.faturar` é stub desligado                                                                               | mock (integração, unitário do registry e do mock); base de testes e produção: **nunca**   |
| Rodada 4: escrita em HOMOLOGAÇÃO               | `admin grant-homolog-writes --email … --entities … [--actions]`: papel `HOMOLOG_WRITER` + ALLOW só para `HOMOLOGATION` (nada em PRODUCTION/SANDBOX, sem DELETE, recusa quem edita políticas); `docs/homologation.md` com o passo a passo na UI, `.env`, `BUSINESS_ACTIONS_ENABLED`, liberação do "Não autorizado" e custo de `SANKHYA_MAX_ROWS`                                                                                                                                                              | integração (CLI); seed aplicado no PGlite local                                           |
| Atribuir ≠ deter                               | Quem tem `ADMIN.ROLES` atribui a OUTRO usuário papel com permissões que não tem, só se forem escritas separadas (`DATA.*`, `DDL.CUSTOM.GENERATE`, `SANKHYA.*`; ex.: Operador; nunca `ADMIN.*`/`APPROVAL.*`), desde que esse usuário já tenha definido a própria senha (`password_not_own`); continua: ninguém altera os próprios papéis, grupo/criação/papel exigem deter, escritor não edita política, o admin não redefine senha nem retira o papel do escritor. Risco aceito documentado em `security.md` | integração (API + serviço) + web                                                          |
| Fase 7 (`6f28c04`)                             | `capabilities.md` (matriz comando × origem × ambiente, decisões pendentes), `sankhya.md` (respostas brutas, números do dicionário, DBEXPMAXROW), `security.md`, `troubleshooting.md`, `operations.md`                                                                                                                                                                                                                                                                                                        | —                                                                                         |

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
- **Ações de nota em HOMOLOGAÇÃO: não verificado.** Nenhuma foi chamada fora do mock. Para habilitar numa conexão live: listar o id exato em `BUSINESS_ACTIONS_ENABLED` (vazio por padrão) numa instalação só com conexões de homologação, uma chamada de cada, conferir a nota no ERP. Pontos abertos da doc oficial em `docs/sankhya.md#business-actions` (caixa de `incluirNota`, `CODLOCALORIG`, `VLRTOT`, resposta de `incluirAlterarItemNota`, `mgeSession`).
- **Rodada 4: UPDATE/INSERT reais na base de testes: não verificado.** O seed foi aplicado localmente, mas o login do usuário de teste precisa de uma senha nova (`admin reset-password`), que a verificação automática de permissões da sessão bloqueou. Falta: senha pelo usuário, uma prévia → confirmação → execução de cada comando em `AD_MANIPULADADOS`, e capturar o envelope.
- **`SelecaoDocumentoSP.faturar`: decisão pendente.** A página oficial não diz quais campos são obrigatórios; fica stub (`OPERATION_NOT_SUPPORTED`) até o contrato ser confirmado.
- **Rodada 6 — rota de execução direta (SERVER_SQL / "Executa Banco"): execução real não verificada.** A integração está implementada e provada **em mock** (ver abaixo), mas nenhum comando correu contra a base de homologação. Bloqueado por: deploy na VPS; liberação de `save`/`executeJava`/`removeRecords` ao usuário de integração; confirmar `AD_MANIPULADADOS`/campo `TEXTO`/ação `98` publicados. Como habilitar e como verificar: `docs/server-sql.md#onde-foi-provado--pendências`. Refinamento aberto: verificação honesta por categoria (reconsultar estrutura após DDL, contar linhas após `DELETE`).

## Rodada 6 — rota de execução direta (SERVER_SQL)

Statements que o gateway não executa (DDL, `DELETE` genérico, DML cru, DCL, PL/SQL) passam pelo ciclo prévia → confirmação → execução → verificação → auditoria via a rotina server-side do cliente (`ActionButtonsSP.executeJava`, ação `98`, bloco em `TEXTO` de um registro `AD_*` dedicado criado e apagado pela ferramenta). Desligada por padrão (`SERVER_SQL_ENABLED=false`), só HOMOLOGAÇÃO/SANDBOX; PRODUÇÃO exige opt-in separado + `SAFE_MODE=false`. Nenhuma proteção foi removida: switches, RBAC (`SERVER.DDL/DELETE/DML_RAW/DCL/PLSQL`), política deny-wins, confirmação do servidor, `WHERE` obrigatório, auditoria honesta com `simulated`. UX neutra: rótulo **EXECUÇÃO DIRETA**, frase honesta por categoria, aviso de "sem prévia simulada", botão azul "Confirmar alteração"; nunca cita "servidor"/"Executa Banco"/`AD_MANIPULADADOS`. O caminho DDL de `tmp_*` (scratch) e os demais caminhos ficam intactos, ao lado deste. Doc: `docs/server-sql.md`.

## Gates

Rodada 3, rodados em 22/10/2026, em foreground, um por vez, no SHA do commit da rodada 3 (só este HANDOFF mudou depois): lint 0; format:check 0 nos arquivos versionados (só acusa `.superpowers/`, ignorado pelo git); typecheck 0; test 0 (88 arquivos, 1855 testes); build 0; drizzle-kit check 0; e2e 0 (35/35). Push normal só em `backup/rodada-2-2026-10-21`; nada em `fix/metadata-on-demand`, `migration` ou `main`.

Correções da revisão de segurança (mesmo dia, mesmo método): lint 0; format:check 0; typecheck 0; test: suíte completa 88 arquivos / 1864 testes com 1 falha (fixture de política em `mutations.int.test.ts` que só liberava a permissão própria, recusada pela nova regra, como esperado); fixture corrigida e o arquivo inteiro re-rodado: 157/157, exit 0; build 0; drizzle-kit check 0; e2e 0 (35/35).

Rodada 4 (seed `grant-homolog-writes` + `docs/homologation.md`), 22/10/2026, mesmo método: lint 0; format:check 0; typecheck 0; test 0 (88 arquivos, 1868 testes); build 0; drizzle-kit check 0; e2e 0 (35/35).

Atribuir ≠ deter, 22/10/2026, mesmo método: lint 0; format:check 0; typecheck 0; test 0 (88 arquivos, 1876 testes); build 0; drizzle-kit check 0; e2e 0 (35/35).
Escritas separadas apenas (revisão de segurança), 22/10/2026, mesmo método: lint 0; format:check 0; typecheck 0; test 0 (88 arquivos, 1877 testes); build 0; drizzle-kit check 0; e2e 0 (35/35).

## Segurança

Produção intocada: nenhuma chamada, leitura ou escrita. Nenhuma ação de nota foi chamada fora do mock; `BUSINESS_ACTIONS_ENABLED` segue vazio e nenhum switch mudou. Na base de testes houve uma única tentativa de escrita (a marca da Fase 0.6), recusada pelo gateway e sem efeito. Credenciais só no `.env` local git-ignorado, nunca impressas.

## Retomar

1. `git status --short --branch`, `git log --oneline -8`.
2. API local: `cd apps/api && pnpm exec tsx --env-file=../../.env src/server.ts` (PGlite é single-process: não rodar `pnpm admin` com a API aberta).
3. Trilha B só com a liberação do usuário. Limites de recurso: no máximo 2 auxiliares; uma suíte pesada por vez.
