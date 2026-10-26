# Runbook — deploy da integração SERVER_SQL na VPS (rodada 6)

> **Documento, não execução.** Nada aqui foi rodado. Não executar antes de todas as
> [pré-condições](#1-pré-condições-não-deployar-antes) estarem cumpridas.
>
> **Atualização 26/10/2026:** deploy feito (`ed56ff4`), sem a rota SERVER_SQL. Ver
> [7. Executado em 26/10/2026](#7-executado-em-26102026).

## 0. Estado inspecionado (26/10/2026, somente leitura)

Inspeção via `ssh plac-vps` em `/var/www/db-sankhya` (usuário `tokicrafto`), sem nenhuma escrita.

| Item                             | Valor observado                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Checkout git                     | `HEAD (no branch)` (detached) em `062fedd6db4649cd0e7f8725923c12cc9eba7b31`, árvore limpa, sem stash |
| Remote                           | `origin https://github.com/Gustavo-Ale07/db-sankhya.git` (sem credencial embutida)                   |
| Versão em execução (`/api/meta`) | `version 0.1.0`, `commit 062fedd`, `sankhyaMode live`, `demoMode false`                              |
| `/health/ready` em `:3102`       | `200`                                                                                                |
| Arquivo compose                  | `compose.yaml` (projeto `db-sankhya`, serviços `app` + `db`, imagem `db-sankhya:latest`)             |
| Disco                            | 67 GB livres em `/`                                                                                  |
| Docker                           | **exige `sudo`** para o usuário `tokicrafto` (socket negado) — itens abaixo marcados "a confirmar"   |

Switches declarados no `.env` da VPS (só nomes não sensíveis):

| Switch                         | `.env`               | Observação                                                                 |
| ------------------------------ | -------------------- | -------------------------------------------------------------------------- |
| `APP_ENV`                      | `production`         |                                                                            |
| `SANKHYA_MODE`                 | `live`               |                                                                            |
| `SANKHYA_ENVIRONMENT`          | `HOMOLOGATION`       | a conexão padrão aponta para a base de homologação (owner `PLACFESTASTST`) |
| `SAFE_MODE`                    | `true`               | só bloqueia conexões **PRODUCTION** — não age sobre esta (HOMOLOGATION)    |
| `GLOBAL_WRITE_ENABLED`         | `true`               |                                                                            |
| `WRITE_TO_SANKHYA`             | `true`               |                                                                            |
| `SERVER_SQL_ENABLED`           | ausente → `false`    | e o código `062fedd` nem lê essa variável                                  |
| `SERVER_SQL_PRODUCTION_OPT_IN` | ausente → `false`    |                                                                            |
| `BUSINESS_ACTIONS_ENABLED`     | ausente → vazio      |                                                                            |
| `APP_BIND` / `APP_PORT`        | `127.0.0.1` / `3102` |                                                                            |

**A confirmar com `sudo`** (não foi possível sem ele): ID da imagem em execução, hora de start
do container, env efetiva dentro do container. O `.env` foi modificado em 23/10 20:16; se o
container subiu antes disso, a env efetiva pode diferir da tabela acima. Comandos na
[seção 2.1](#21-confirmar-o-estado-atual-com-sudo).

### Versão implantada × código da integração

- `062fedd` está na linha da `backup/rodada-2-2026-10-21` (a `main` `f8d6a2e` é ancestral dele).
- A integração SERVER_SQL entra em `438d975` (rota de execução direta) e termina, por enquanto,
  em `447ccc2` (gate de produção fase 1, só `UPDATE`). **A VPS está 11 commits atrás e não
  contém a integração.**
- Diferença `062fedd..447ccc2`: 43 arquivos, uma migration nova:
  `packages/database/migrations/0013_server_sql.sql` — **só dados, idempotente**
  (`INSERT … ON CONFLICT DO NOTHING`): cria o papel `SUPER_ADMIN` e suas permissões
  (`SERVER.DDL/DELETE/DML_RAW/DCL/PLSQL`, `SECURITY.SEGREGATION_OVERRIDE`). Ela é aplicada
  **automaticamente no start** do container (`database.migrate()` em `apps/api/src/server.ts`).
- Rollback para `062fedd` com a 0013 já aplicada é tolerado: o código antigo filtra permissões
  desconhecidas com `isPermission` (`apps/api/src/services/authz.ts`). Restaurar o dump só é
  necessário se a migration falhar no meio ou se for exigido remover o papel `SUPER_ADMIN`.

## 1. Pré-condições (NÃO deployar antes)

Todas obrigatórias, nesta ordem:

1. **Autorização da API liberada pela Sankhya** para o usuário de integração nos três serviços
   da rota: `DatasetSP.save`, `ActionButtonsSP.executeJava` e `DatasetSP.removeRecords`
   (hoje respondem "Não autorizado" — chamado aberto).
2. **Contrato da ação 98 validado com comando inócuo**, fora da VPS (ambiente local apontando
   para a homologação), seguindo `docs/server-sql.md` → "Procedimento para validar a integração
   real": capturar a chamada real do botão "Executa Banco", conferir `actionID`/entidade/módulo/
   forma de `rows`, rodar um DDL inócuo (criar e derrubar uma `AD_*` de teste), confirmar
   `cleanup = DELETED`, auditoria `route: SERVER_SQL` e o objeto no dicionário. Se algum
   parâmetro divergir de `DEFAULT_SERVER_SQL_ACTION`, corrigir em código, commitar e **voltar
   ao item 3** com o novo SHA.
3. **Suíte completa verde no SHA a implantar** (máx. 2 workers):
   `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:integration`
   (inclui `mutations.int`). Anotar o SHA exato aprovado — chamado abaixo de `<SHA>`.
4. O `<SHA>` está **no origin** (`git ls-remote origin backup/rodada-2-2026-10-21`).
5. Janela combinada; ninguém usando a ferramenta durante o deploy.

## 2. Backup antes do deploy

Tudo em `/var/www/db-sankhya`, como `tokicrafto`, com `sudo` para o Docker.

### 2.1 Confirmar o estado atual (com sudo)

```bash
cd /var/www/db-sankhya
sudo docker compose ps
CID=$(sudo docker compose ps -q app); echo "$CID"
sudo docker inspect "$CID" --format 'image={{.Image}} ref={{.Config.Image}} started={{.State.StartedAt}}'
sudo docker inspect "$CID" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^(GIT_COMMIT|APP_VERSION)='
sudo docker compose exec -T app printenv | grep -E '^(SANKHYA_ENVIRONMENT|SAFE_MODE|GLOBAL_WRITE_ENABLED|WRITE_TO_SANKHYA|SERVER_SQL_ENABLED|SERVER_SQL_PRODUCTION_OPT_IN|BUSINESS_ACTIONS_ENABLED)='
sudo docker images --format '{{.Repository}}:{{.Tag}}  {{.ID}}  {{.CreatedAt}}' | grep -i sankhya
```

Esperado: `GIT_COMMIT=062fedd`, env do container igual à tabela da seção 0. Se divergir, **parar**
e entender antes de continuar.

### 2.2 Salvar commit, imagem, `.env` e banco

```bash
cd /var/www/db-sankhya
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p ~/backups/db-sankhya && chmod 700 ~/backups/db-sankhya

# commit atual (esperado 062fedd…)
git rev-parse HEAD | tee ~/backups/db-sankhya/commit-pre-rodada6-$TS.txt

# imagem atual: tag fixa que o build novo NÃO sobrescreve
CID=$(sudo docker compose ps -q app)
IMG=$(sudo docker inspect "$CID" --format '{{.Image}}')
sudo docker tag "$IMG" db-sankhya:rollback-062fedd
sudo docker images db-sankhya        # deve listar :latest e :rollback-062fedd com o mesmo ID

# .env (contém segredos e o ENCRYPTION_KEY: permissões 600 preservadas)
cp -p .env ~/backups/db-sankhya/env-pre-rodada6-$TS
ls -l ~/backups/db-sankhya/

# dump do Postgres (volume db-data)
sudo docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > ~/backups/db-sankhya/db-pre-rodada6-$TS.dump
chmod 600 ~/backups/db-sankhya/db-pre-rodada6-$TS.dump
ls -l ~/backups/db-sankhya/db-pre-rodada6-$TS.dump   # tamanho > 0
```

Não imprimir o conteúdo de `.env` nem do dump. Guardar o `$TS` usado.

## 3. Deploy

O checkout está em detached HEAD; o deploy continua assim, preso a um SHA exato.

```bash
cd /var/www/db-sankhya
git status --porcelain                      # deve sair vazio; se não, parar
git fetch origin backup/rodada-2-2026-10-21
git checkout --detach <SHA>
git log -1 --format='%H %s'                 # conferir <SHA>

# .env NÃO muda neste passo: SERVER_SQL_* continuam ausentes (= false)

SHORT=$(git rev-parse --short HEAD)
sudo docker compose build --build-arg GIT_COMMIT=$SHORT app
sudo docker compose up -d --no-build app    # recria só o app; o db segue de pé
```

Verificação (a migration 0013 roda no start):

```bash
sudo docker compose ps                                           # app healthy
curl -s http://127.0.0.1:3102/api/meta; echo                     # "commit":"<SHORT>"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3102/health/ready   # 200
sudo docker compose logs app 2>&1 | grep 'DB-Sankhya API started' | tail -1
sudo docker compose exec -T app printenv | grep -E '^SERVER_SQL_'           # vazio
sudo docker compose exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select key from roles where key = '\''SUPER_ADMIN'\''"'
                                                                 # SUPER_ADMIN
```

Fumaça manual na UI: login, um `SELECT` simples na conexão padrão, página de Segurança.
Qualquer falha → [rollback](#5-rollback).

## 4. Switches — quais e quando

Mudança de `.env` só vale após **recriar** o container (`sudo docker compose up -d --no-build app`);
`docker compose restart` **não** relê o `env_file`. Sempre fazer `cp -p .env` antes de editar.

| Switch                                      | Faz                                                                                                                                           | Quando                                                                                                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SERVER_SQL_ENABLED`                        | Switch mestre da rota server-side ("Executa Banco"). `false` → `SERVER_SQL_DISABLED` e o statement volta para o caminho normal ou é recusado. | **Não no deploy.** Só depois do deploy estável **e** com o contrato da ação 98 já validado (pré-condição 2), numa mudança separada, registrada, com o primeiro uso planejado (seção 6). |
| `SERVER_SQL_PRODUCTION_OPT_IN`              | Opt-in separado para a rota tocar uma conexão `PRODUCTION`; ainda exige `SAFE_MODE=false`, e a fase 1 só aceita `UPDATE`.                     | **Manter ausente/`false`.** Esta VPS usa `SANKHYA_ENVIRONMENT=HOMOLOGATION`, então o opt-in não se aplica. Ligar contra PRODUCTION é decisão própria, fora deste runbook.               |
| `SAFE_MODE`                                 | Bloqueia escrita em conexões `PRODUCTION`.                                                                                                    | Manter `true`.                                                                                                                                                                          |
| `GLOBAL_WRITE_ENABLED` / `WRITE_TO_SANKHYA` | Liberam escrita planejada e escrita em tabelas Sankhya.                                                                                       | Já estão `true` hoje; não mudar neste deploy. Para cortar escrita em emergência: página Segurança (runtime) ou `GLOBAL_WRITE_ENABLED=false` + recriar o container.                      |

Atenção: o gate de produção fase 1 depende de `SANKHYA_ENVIRONMENT` ser verdadeiro. Se a
conexão padrão algum dia apontar para a base de produção, `SANKHYA_ENVIRONMENT` **tem** de
virar `PRODUCTION` antes — com `HOMOLOGATION` o gate não se aplica.

Para desligar a rota a qualquer momento: remover `SERVER_SQL_ENABLED` (ou `=false`) do `.env`
e `sudo docker compose up -d --no-build app`.

## 5. Rollback

Gatilhos: app não fica `healthy`, `/health/ready` ≠ 200, `/api/meta` com commit errado, erro na
migration no log, fumaça manual falhando, ou qualquer comportamento inesperado de escrita.

```bash
cd /var/www/db-sankhya

# 1. desligar a rota se ela tiver sido ligada (restaurar o .env salvo)
cp -p ~/backups/db-sankhya/env-pre-rodada6-<TS> .env

# 2. voltar o código e a imagem
git checkout --detach 062fedd6db4649cd0e7f8725923c12cc9eba7b31
sudo docker tag db-sankhya:rollback-062fedd db-sankhya:latest
sudo docker compose up -d --no-build app

# 3. verificar
curl -s http://127.0.0.1:3102/api/meta; echo                       # "commit":"062fedd"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3102/health/ready   # 200
```

Banco: a 0013 é só dados e o código antigo ignora as permissões novas, então **normalmente não
se restaura o dump**. Restaurar apenas se a migration falhou no meio ou se o estado do banco
ficou inconsistente (perde o que foi gravado depois do dump):

```bash
sudo docker compose stop app
sudo docker compose exec -T db sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  < ~/backups/db-sankhya/db-pre-rodada6-<TS>.dump
sudo docker compose up -d --no-build app
```

O `.env` restaurado traz o mesmo `ENCRYPTION_KEY`, então as conexões cadastradas continuam
legíveis.

## 6. Primeira operação real

- **Nunca** faz parte do deploy. O deploy termina com `SERVER_SQL_ENABLED` desligado.
- A primeira operação é **um único `UPDATE` específico**, escrito e revisado à parte (texto do
  SQL, tabela, `WHERE` e contagem esperada de linhas aprovados antes), executado pelo ciclo
  prévia → confirmar, com `SERVER_SQL_ENABLED` ligado só para ela.
- Depois: conferir auditoria (`route: SERVER_SQL`, `simulated: false`), `cleanup = DELETED`
  e o resultado com um `SELECT` no próprio ERP. Decidir em seguida se o switch fica ligado.

## Observações

- Há 6 cópias `.env.bak*` antigas em `/var/www/db-sankhya` (uma com dono `root`). Ficam onde
  estão; limpeza é tarefa separada.
- `.env.example` ainda não documenta `SERVER_SQL_ENABLED` / `SERVER_SQL_PRODUCTION_OPT_IN`
  (estão em `docs/server-sql.md`). Pendência de documentação.

## 7. Executado em 26/10/2026

- **Deploy:** `ed56ff4` (branch `backup/rodada-2-2026-10-21`) em produção, `/var/www/db-sankhya`,
  imagem `db-sankhya:latest`; commit confirmado via `/api/meta`. Inclui `SANKHYA_WRITE_INSTANCES`
  (instância de gravação por tabela com várias instâncias no TDDINS).
- **`.env` vigente (switches):** `SANKHYA_ENVIRONMENT=PRODUCTION`, `SAFE_MODE=false`,
  `GLOBAL_WRITE_ENABLED=true`, `WRITE_TO_SANKHYA=true`, `SANKHYA_WRITE_INSTANCES=TGFPAR:Parceiro`,
  `SERVER_SQL_*` ausente. Isso substitui a recomendação da seção 4 de manter `SAFE_MODE=true`:
  a escrita em produção pela rota `DatasetSP.save` foi ligada por decisão do responsável.
- **Primeira operação real (rota `DatasetSP.save`, não SERVER_SQL):**
  `UPDATE TGFPAR SET COMPLEMENTO = … WHERE CODPARC = 5778`, pela instância `Parceiro` →
  **VERIFIED** (gravou, releu no Sankhya e conferiu). Revert também **VERIFIED**: valor original
  `de 700/701 ao fim` restaurado, sem resíduo.
- **Resolvido:** o `DatasetSP.save` está autorizado em produção para UPDATE simples
  (`SET coluna = literal` + `WHERE`). Os bloqueios anteriores eram do nosso lado
  (deny-by-default de política + trava multi-instância), não da API Sankhya.
- **Outras tabelas multi-instância:** recusadas com `OPERATION_NOT_SUPPORTED` até serem
  acrescentadas em `SANKHYA_WRITE_INSTANCES` (`TABELA:Instancia`, separado por vírgula) e o
  container ser recriado com `sudo docker compose up -d --no-build app` (relê o `.env`).
- **SERVER_SQL (fase 2) continua desligada:** CREATE/DROP/DDL/DELETE via "Executa Banco"
  (`ActionButtonsSP.executeJava`, ação `98`) aguardam o chamado Sankhya de AutorizacaoApi.
  **Não** acrescentar `SERVER_SQL_*` ao `.env` até a liberação + validação do contrato do
  `executeJava`; as seções 1 e 6 continuam valendo para essa rota.
