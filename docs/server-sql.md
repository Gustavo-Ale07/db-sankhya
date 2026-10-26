# Rota de execução direta (SERVER_SQL / "Executa Banco")

Esta rota permite que comandos que o Gateway REST da Sankhya **não** sabe executar
(DDL, `DELETE` genérico, DML cru, DCL e blocos PL/SQL) passem pelo mesmo ciclo das
demais alterações — prévia → confirmação → execução → verificação → auditoria —
disparados pela rotina server-side do próprio cliente Sankhya (DBScript), em vez de
pelos serviços REST.

> **Estado:** desligada por padrão (`SERVER_SQL_ENABLED=false`), só em HOMOLOGAÇÃO/SANDBOX.
> A integração está implementada e coberta por testes de integração **com mocks**. A
> execução real contra a base de homologação é uma pendência explícita (ver o fim deste
> documento): **mock não é prova de execução real**.

## Por que existe

O Gateway cobre apenas formas específicas de escrita: `SELECT` (via `executeQuery`),
`INSERT ... VALUES` de uma linha e `UPDATE`/`DELETE` simples (via `DatasetSP.save`).
Tudo o que foge disso — criar/alterar/derrubar tabela, `DELETE` sem a forma suportada,
`MERGE`, `INSERT ... SELECT`, `UPDATE` com subconsulta/expressão, `GRANT`/`REVOKE`,
blocos `BEGIN ... END` — não tem serviço REST. Essa rota preenche essa lacuna **sem**
afrouxar nenhuma proteção: o comando segue preso aos mesmos switches, RBAC, política,
confirmação, leitura de verificação e auditoria.

## Mapa de roteamento

A classificação decide, por statement, por onde a alteração passa:

| Forma do comando                                           | Rota           | Serviço Sankhya                               |
| ---------------------------------------------------------- | -------------- | --------------------------------------------- |
| `SELECT`                                                   | leitura        | `DbExplorerSP.executeQuery`                   |
| `INSERT ... VALUES` (uma linha), `UPDATE`/`DELETE` simples | gateway        | `DatasetSP.save`                              |
| Qualquer coisa sobre `tmp_*`                               | scratch        | PGlite (dry run transacional)                 |
| DDL / `DELETE` genérico / DML cru / DCL / PL/SQL           | **SERVER_SQL** | `ActionButtonsSP.executeJava` (ação DBScript) |

Quando `SERVER_SQL_ENABLED=false`, a última linha **não** se aplica: o statement cai
nos caminhos existentes e `parseWrite` recusa o que o gateway não sabe salvar
(`SQL_UNSUPPORTED`/`SQL_PARSE_ERROR`). Nenhuma prévia é criada e nada é gravado.

## Categorias (`SERVER.*`)

Cada statement elegível recebe uma categoria, que é a permissão exigida:

| Categoria | Permissão        | Cobre                                                            |
| --------- | ---------------- | ---------------------------------------------------------------- |
| `DDL`     | `SERVER.DDL`     | `CREATE` / `ALTER` / `DROP` / `TRUNCATE` / `RENAME` / `COMMENT`  |
| `DELETE`  | `SERVER.DELETE`  | `DELETE` genérico (sem serviço de gateway documentado)           |
| `DML_RAW` | `SERVER.DML_RAW` | `MERGE`, `INSERT ... SELECT`, `UPDATE` com subconsulta/expressão |
| `DCL`     | `SERVER.DCL`     | `GRANT` / `REVOKE`                                               |
| `PLSQL`   | `SERVER.PLSQL`   | bloco anônimo (`BEGIN`/`DECLARE`) ou chamada de procedure        |

Um payload com mais de um statement é recusado (`SERVER_SQL_UNSUPPORTED`): assim a
categoria — e a permissão e a decisão de política ligadas a ela — nunca são confundidas
por um `; DROP TABLE ...` escondido atrás de um `DELETE`. PL/SQL é exceção (um bloco
legitimamente tem vários comandos, e `SERVER.PLSQL` já autoriza um bloco arbitrário).

## Contrato do DBScript (`ActionButtonsSP.executeJava`)

- **CONFIRMADO pela documentação/contrato do cliente:** a ação de botão com
  `actionID = 98` executa Java; o bloco PL/SQL vai no campo `TEXTO` de um registro de uma
  entidade `AD_*`; DDL é executada de dentro do bloco via `EXECUTE IMMEDIATE`.
- **COMO esta ferramenta usa:** cria um registro **dedicado** na entidade de controle
  (`AD_MANIPULADADOS` por padrão, configurável), grava o bloco em `TEXTO`, dispara a ação
  `98` apontando para a PK desse registro e, no fim, **apaga** o registro de controle.
  Nunca sobrescreve um registro existente (ex.: o ID 46 da consultoria): o registro é
  criado e controlado por esta ferramenta e removido ao final.
- **PENDENTE de confirmação na base real:** que `AD_MANIPULADADOS` exista na homologação
  com o campo `TEXTO`, que a ação `98` esteja publicada e que o usuário de integração
  tenha permissão de `save`/`executeJava`/`removeRecords`. Isso só se prova executando na
  homologação (ver pendências).

### Ciclo de disparo (`ServerSqlExecutor.dispatch`)

1. `save` do registro de controle (sem PK) → extrai o `ID` gerado. Se a resposta não trouxer
   o id, lança `SANKHYA_BAD_RESPONSE` e **a ação não é disparada**.
2. `executeJava` com `actionId: 98`, a entidade de controle e a PK do passo 1.
3. `removeRecords` do registro de controle (limpeza), em melhor esforço: sucesso →
   `cleanup: DELETED`; falha → `cleanup: ORPHANED` + `cleanupError` (o id fica registrado
   para limpeza manual, mas a alteração já ocorreu).

O resultado é `EXECUTED` quando a ação volta com `status === '1'`, senão `FAILED`.

### Parâmetros da ação 98 ainda NÃO confirmados na base real

O corpo que esta ferramenta envia em `ActionButtonsSP.executeJava` é o mesmo do botão
"Executa Banco" da UI, mas cada parâmetro abaixo é uma **suposição** até ser provado na
homologação. Hoje todos são **fixos** em `DEFAULT_SERVER_SQL_ACTION`
(`apps/api/src/services/server-sql-executor.ts`): a `mutation-factory` ainda **não** passa um
`action`, e não existe `.env` para sobrescrevê-los. Se algum valor divergir da base real, é
preciso ligar `serverSql.action` na factory (a partir de novas chaves `.env`) — é uma pendência
de código, não só de configuração.

| Parâmetro               | Valor assumido                             | Como confirmar na homologação                                                                                |
| ----------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `actionID`              | `98`                                       | capturar a chamada real do botão "Executa Banco" (DevTools / log do gateway) e ler o `actionID`              |
| entidade de controle    | `AD_MANIPULADADOS`                         | confirmar que a entidade existe e qual instância/tela o botão 98 usa                                         |
| campo do bloco          | `TEXTO` (CLOB)                             | confirmar o nome e o tipo da coluna que a ação lê como script                                                |
| campo-chave             | `ID`                                       | confirmar o nome da PK da entidade de controle                                                               |
| `refreshType`           | `NONE`                                     | confirmar que a ação aceita `NONE` (a UI pode mandar outro valor)                                            |
| forma de `rows`/`field` | `{ row: [{ field: [{ fieldName, $ }] }] }` | confirmar que a ação 98 lê o `TEXTO` do **registro apontado pela PK** e não de um parâmetro próprio do corpo |
| módulo                  | `mge`                                      | confirmar o módulo do serviço (a ação pode viver em outro módulo)                                            |

Enquanto esses valores não forem capturados de uma chamada real, a execução server-side
**não pode ser declarada comprovada** — ver "Onde foi provado / pendências".

### Procedimento para validar a integração real (homologação)

0. **Verificação read-only** (não escreve nada, não imprime credenciais): rodar
   `pnpm --filter @dbx/api probe-server-sql [--connection <id|nome>] [--entity AD_MANIPULADADOS]`.
   Usa `DbExplorerSP.executeQuery` (já autorizado) para confirmar que a entidade de controle
   existe e tem as colunas `ID` e `TEXTO`, e quantas linhas tem. É só um `SELECT` (trava recusa
   qualquer statement que não seja um `SELECT`/`WITH` único). **Não** confirma o contrato da ação
   98 — isso continua dependendo do passo 1. Opcional: `--action-sql "<SELECT que você confie>"`
   para inspecionar o binding da ação se souber onde o ERP o guarda.
1. Capturar uma chamada real do botão "Executa Banco" na UI da homologação e preencher a
   tabela acima; se algum valor divergir dos fixos em `DEFAULT_SERVER_SQL_ACTION`, ligar
   `serverSql.action` na `mutation-factory` (pendência de código — hoje não há `.env` para isso).
2. Garantir a autorização do usuário de integração para os três serviços da rota
   (`DatasetSP.save`, `ActionButtonsSP.executeJava` ação 98, `DatasetSP.removeRecords`) —
   ver `docs/homologation.md`, seção "Não autorizado".
3. Com `SERVER_SQL_ENABLED=true` **apenas** na homologação, rodar um DDL inócuo (criar e
   derrubar uma `AD_*` de teste) pelo ciclo prévia → confirmar.
4. Conferir no log do gateway que só `save`/`executeJava`/`removeRecords` foram chamados,
   que o `cleanup` resultou em `DELETED`, e que a auditoria registrou `route: SERVER_SQL`
   com `simulated: false`.
5. Confirmar no banco que o objeto foi realmente criado/derrubado (a rota reporta
   `EXECUTED` como **não verificado** — a prova final é a consulta ao dicionário/catálogo).

## Proteções (nenhuma foi removida)

Ordem de verificação, tudo fail-closed:

1. **Switch mestre** `SERVER_SQL_ENABLED` (padrão `false`) → `SERVER_SQL_DISABLED`.
2. `GLOBAL_WRITE_ENABLED` e `WRITE_TO_SANKHYA` → `READ_ONLY_MODE` (mesmos switches gerais).
3. **Ambiente:** só HOMOLOGAÇÃO/SANDBOX. PRODUÇÃO exige opt-in separado
   (`SERVER_SQL_PRODUCTION_OPT_IN`) **e** `SAFE_MODE` desligado; caso contrário
   `SERVER_SQL_PRODUCTION_BLOCKED`. Mesmo com o opt-in, PRODUÇÃO fase 1 só aceita `UPDATE`
   (inclusive com subconsulta/expressão): `DELETE`, DDL (`DROP`/`TRUNCATE`/…), `MERGE`,
   `INSERT`/`INSERT…SELECT`, DCL e PL/SQL são recusados com `SERVER_SQL_OUT_OF_SCOPE` (403).
   A decisão vem do verbo real do statement (não da categoria) e é checada na preparação, na
   reautorização e de novo no `ServerSqlExecutor.dispatch`, antes de qualquer chamada ao
   gateway. HOMOLOGAÇÃO/SANDBOX não têm essa restrição.
4. **RBAC:** a permissão `SERVER.<categoria>` precisa estar concedida, senão `FORBIDDEN`.
5. **Entidade de controle reservada:** nenhum comando — nem pela rota SERVER_SQL nem pelo
   gateway — pode ter a entidade de controle (`AD_MANIPULADADOS`, configurável) como alvo.
   Uma tentativa é recusada com `FORBIDDEN` (detalhe `{ entity }`). Isso fecha o TOCTOU em
   que um usuário visaria diretamente o registro que a ferramenta cria/apaga para disparar a
   ação `98`. A checagem existe nos **dois** lados (`resolveSankhya` para o gateway e
   `resolveServerSql` para a rota direta).
6. **Política:** decisão com ALLOW obrigatório (deny-wins) sobre o **objeto real** do comando;
   sem ALLOW, `FORBIDDEN`. O objeto é extraído com o tokenizer real (strings, comentários e
   identificadores entre aspas ou qualificados por schema tratados). Se o objeto de um
   DDL/`DELETE`/DML cru/DCL **não puder ser determinado com segurança** (ex.: `ALTER SESSION`,
   `CREATE VIEW`/`SYNONYM`/`TRIGGER`, que referenciam outros objetos), o comando é recusado
   (`SERVER_SQL_TARGET_UNKNOWN`) em vez de cair no registro de controle — a política nunca é
   decidida sobre `AD_MANIPULADADOS` no lugar da tabela real. PL/SQL é a exceção: não tem alvo
   único e já é autorizado como bloco arbitrário por `SERVER.PLSQL`.
7. **Política de leitura das fontes:** um comando que **lê** de outras tabelas para decidir o
   que gravar (`DELETE ... WHERE x IN (SELECT ... FROM OUTRA)`, `MERGE ... USING`,
   `INSERT ... SELECT`, `UPDATE` com subconsulta) só passa se o chamador puder ler **cada**
   tabela de origem: para cada fonte, avalia-se `QUERY.SELECT` (que honra regras DENY) e, sem
   ALLOW, recusa-se com `FORBIDDEN` (detalhe `{ entity }` da fonte). As fontes são extraídas
   percorrendo **toda** a lista `FROM` separada por vírgula (não só a primeira tabela),
   pulando subconsultas derivadas sem perder as irmãs seguintes e sufixos Oracle
   `PARTITION (...)`/`SUBPARTITION (...)`. Fail-closed → `SERVER_SQL_TARGET_UNKNOWN` quando uma
   fonte não pode ser determinada com segurança: função de tabela `TABLE(f())`, dblink
   `tabela@link`, ou **qualquer modificador de referência que não parseamos** (`SAMPLE`,
   `AS OF`, `VERSIONS`) — estes nunca são consumidos como alias, para não pular uma irmã
   `, SECRET` à frente. O fim de um item de `FROM` só é aceito num **limite de cláusula real**
   (lista restrita: `WHERE`, `GROUP`, `HAVING`, `ORDER`, `CONNECT`, `START`, operadores de conjunto,
   `FETCH`, `OFFSET`, `RETURNING`, `SET`, `WHEN`, `FOR`, `INTO`) ou num join; **todo o resto falha
   fechado por padrão**. Uma irmã vírgula ao estilo antigo após um join ANSI
   (`FROM A JOIN B ON a=b, SECRET` / `USING (x), SECRET`) é recusada (essa irmã não é alcançada por
   nenhum `FROM`/`JOIN`); e um `CASE` numa condição de join, ou qualquer `PIVOT`/`UNPIVOT`/`APPLY`/
   `LATERAL`/`MODEL`, também falham fechado por não serem gramática que analisamos. Ao varrer a
   área de join em busca dessa irmã, só uma palavra **reservada** do Oracle (`WHERE`, `GROUP`,
   `HAVING`, `ORDER`, `CONNECT`, `START`, `SET`, `FOR`, `INTO`, operadores de conjunto) encerra a
   varredura; palavras não reservadas (`JOIN`, `OFFSET`, `FETCH`, `RETURNING`, `WHEN`, `EXCEPT`)
   podem ser **identificadores** (ex.: coluna `a.OFFSET`) e por isso não interrompem a varredura, e
   todo nome logo após um `.` é tratado como parte de identificador — assim uma irmã vírgula não
   escapa escondida atrás de um nome com forma de palavra-chave. Além disso,
   **ler da entidade de controle** (`AD_MANIPULADADOS`) é
   recusado como alvo (`FORBIDDEN { entity }`). **Resíduos documentados:** (a) a checagem é por
   **tabela** (nível de objeto); regras de leitura por **coluna** nas fontes não são aplicadas
   aqui; (b) uma tabela lida **indiretamente por uma função** (`WHERE c = ALGUMA_FN()`) não é
   fonte de `FROM`/`JOIN` e não é descoberta aqui — a função roda sob os privilégios do próprio
   Oracle, então o schema de integração deve ser de menor privilégio no banco; o comando ainda
   exige a permissão `SERVER.<categoria>` e um ALLOW de política. PL/SQL é exceção (bloco
   arbitrário, sem lista de fontes analisável).
8. **Literais q-quote Oracle (`q'…'`/`nq'…'`):** o tokenizer das análises é ANSI e **não**
   entende q-quote; um `q'[…]'` dessincroniza a leitura e poderia esconder um `WHERE`, uma
   fonte ou o alvo. Por isso `serverSqlTarget`/`serverSqlWhere`/`serverSqlSources` **falham
   fechado** diante de um q-quote (alvo/fonte → `SERVER_SQL_TARGET_UNKNOWN`; `WHERE` →
   tratado como ausente). O detector varre o texto cru pulando strings `'…'` **e identificadores
   com aspas** `"…"`/`[…]` exatamente como o tokenizer ANSI os lê, para que uma aspa dentro de
   `"a'b"` não dessincronize o detector e deixe o q-quote passar; uma string ou identificador
   **não terminado** também falha fechado. Isso é na camada de **autorização** — o disparo em si
   (`dynamicWrap`, `EXECUTE IMMEDIATE q'X…X'`) já garante execução de exatamente um statement
   mesmo com diferença de lexer, então q-quote não é vetor de statement-smuggling. PL/SQL (que usa
   q-quote legitimamente) não passa por essas análises.
9. **Confirmação forte** quando a política/ambiente exigem — decidida no servidor, nunca
   inventada só no front.
10. `UPDATE`/`DELETE` sem `WHERE` → `WHERE_REQUIRED` (salvo override explícito de política). A
    necessidade de `WHERE` e a presença dele são decididas pelo tokenizer real da rota direta
    (`serverSqlWhere`), por verbo — não pelo parser PG, que marcaria como `UNKNOWN` formas
    Oracle como `DELETE FROM T PARTITION (P1)`. Fail-closed: na dúvida, `present = false`.

Papéis: `LEITOR` = só `SELECT`; `OPERADOR` = `SELECT` + `INSERT` + `UPDATE`; `ADMIN` = tudo

- administração via `SUPER_ADMIN` (a segregação de deveres foi preservada criando
  `SUPER_ADMIN`, em vez de afrouxá-la para o ADMIN comum — ver `security.md`).

## Interface (sem citar a rota)

- Rótulo de prévia neutro **EXECUÇÃO DIRETA** (`SERVER_EXECUTION`); nunca "servidor",
  "Executa Banco" nem `AD_MANIPULADADOS`.
- Não há diff de linha simulado: o alvo é só um objeto. O diálogo mostra uma frase honesta
  por categoria ("Este comando altera a estrutura do banco e será aplicado diretamente.",
  "...remove registros...", etc.) e avisa que **não há prévia simulada** — o comando é
  aplicado como está e o resultado é conferido em seguida.
- Botão azul **"Confirmar alteração"** (o padrão), nunca um "executar" genérico.
- A linha de impacto (objeto/entidade, ambiente) é mantida.

## Auditoria (honesta)

A auditoria registra o SQL real, a rota (`route: SERVER_SQL`), a categoria
(`serverCategory`), o id do registro de controle, o resultado da limpeza (`cleanup`) e o
campo **`simulated`** — `true` quando a execução correu contra o gateway mock (uma
simulação) e `false` contra uma base real. Isso garante que um resultado de teste nunca
possa ser lido, depois, como uma alteração real. A rota nunca é disfarçada de gateway.

## Verificação por categoria

A rota direta não tem read-back de linha como `UPDATE`/`DELETE` de gateway; um passo
`EXECUTED` fica como `UNVERIFIED` (ok, sem conferência de valor) e um `FAILED` fica como
`FAILED`. A verificação honesta por categoria (ex.: reconsultar a estrutura após um DDL,
contar linhas após um `DELETE`) é uma pendência de refinamento documentada aqui.

## Configuração

| Variável                       | Padrão  | Efeito                                                         |
| ------------------------------ | ------- | -------------------------------------------------------------- |
| `SERVER_SQL_ENABLED`           | `false` | Liga/desliga a rota inteira (switch mestre).                   |
| `SERVER_SQL_PRODUCTION_OPT_IN` | `false` | Opt-in separado para PRODUÇÃO (ainda exige `SAFE_MODE=false`). |

## Onde foi provado / pendências

- **Provado em mock:** prepare por categoria, gate de permissão/política/ambiente,
  `WHERE` obrigatório, e o ciclo de execução (`EXECUTED`/`FAILED`/`ORPHANED`/
  `SANKHYA_BAD_RESPONSE`/`READ_ONLY_MODE`) via um `ServerSqlClient` falso injetado — a
  orquestração real do `MutationService` roda, só a borda do gateway é falsa. Ver
  `apps/api/src/services/mutations.int.test.ts`,
  `apps/api/src/services/server-sql-executor.test.ts`,
  `packages/sql-engine/src/server-sql.test.ts` e os testes web de `MutationDialog`.
- **NÃO verificado (pendência) — execução real na base de homologação.** Bloqueado por:
  (1) autorização de deploy na VPS; (2) liberação de escrita/`executeJava`/`removeRecords`
  para o usuário de integração no admin da Sankhya (a mesma credencial hoje recebe "Não
  autorizado" em `DatasetSP.save`); (3) confirmar `AD_MANIPULADADOS`/campo `TEXTO`/ação
  `98` publicados na homologação. **Como verificar:** com `SERVER_SQL_ENABLED=true` só na
  homologação, rodar um DDL inócuo (ex.: criar e derrubar uma tabela `AD_*` de teste) e
  conferir no log do gateway que só os serviços `save`/`executeJava`/`removeRecords`
  esperados foram chamados, com a limpeza resultando em `DELETED`.
