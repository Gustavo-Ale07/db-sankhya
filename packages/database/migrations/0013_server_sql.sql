-- 0013_server_sql.sql
-- Server-side ("Executa Banco") permissions and the SUPER_ADMIN system role.
--
-- Justification (required by the working rules for any new migration): the server-side execution
-- route adds five permission categories (SERVER.DDL / DELETE / DML_RAW / DCL / PLSQL) and a
-- SECURITY.SEGREGATION_OVERRIDE marker. SUPER_ADMIN holds the whole catalog, so it does every
-- command (including the server-side route) AND administers access, with the override lifting the
-- separation-of-duties block on policy administration for that one role. The existing system roles
-- (VIEWER / OPERATOR / ADMIN) are left exactly as they were: server-side execution starts
-- SUPER_ADMIN-only and behind the SERVER_SQL_ENABLED master switch (off by default, HOMOLOGATION /
-- SANDBOX only). Data-only and idempotent (ON CONFLICT DO NOTHING); applied to local / homologation
-- databases only. Not applied to production and not merged to main/migration without authorization.
INSERT INTO "roles" ("key", "name", "description", "system") VALUES
  ('SUPER_ADMIN', 'Super administrador', 'Executa todos os comandos (inclusive pelo banco) e administra o acesso. Dispensa a segregação de funções.', true)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", v."permission" FROM (VALUES
  ('SUPER_ADMIN', 'QUERY.SELECT'),
  ('SUPER_ADMIN', 'TEMP.CREATE'),
  ('SUPER_ADMIN', 'TEMP.WRITE'),
  ('SUPER_ADMIN', 'TEMP.DROP'),
  ('SUPER_ADMIN', 'TEMP.MATERIALIZE'),
  ('SUPER_ADMIN', 'DATA.PREVIEW'),
  ('SUPER_ADMIN', 'DATA.INSERT'),
  ('SUPER_ADMIN', 'DATA.UPDATE'),
  ('SUPER_ADMIN', 'DATA.DELETE'),
  ('SUPER_ADMIN', 'DDL.CUSTOM.GENERATE'),
  ('SUPER_ADMIN', 'SANKHYA.BUSINESS_ACTION.EXECUTE'),
  ('SUPER_ADMIN', 'SANKHYA.ACTION.CANCELAR_NOTA'),
  ('SUPER_ADMIN', 'SANKHYA.ACTION.INCLUIR_NOTA'),
  ('SUPER_ADMIN', 'SANKHYA.ACTION.INCLUIR_ALTERAR_ITEM_NOTA'),
  ('SUPER_ADMIN', 'SANKHYA.ACTION.EXCLUIR_ITEM_NOTA'),
  ('SUPER_ADMIN', 'SERVER.DDL'),
  ('SUPER_ADMIN', 'SERVER.DELETE'),
  ('SUPER_ADMIN', 'SERVER.DML_RAW'),
  ('SUPER_ADMIN', 'SERVER.DCL'),
  ('SUPER_ADMIN', 'SERVER.PLSQL'),
  ('SUPER_ADMIN', 'APPROVAL.DECIDE'),
  ('SUPER_ADMIN', 'AUDIT.READ'),
  ('SUPER_ADMIN', 'ADMIN.USERS'),
  ('SUPER_ADMIN', 'ADMIN.GROUPS'),
  ('SUPER_ADMIN', 'ADMIN.ROLES'),
  ('SUPER_ADMIN', 'ADMIN.POLICIES'),
  ('SUPER_ADMIN', 'ADMIN.CONNECTIONS'),
  ('SUPER_ADMIN', 'ADMIN.SECURITY'),
  ('SUPER_ADMIN', 'SECURITY.SEGREGATION_OVERRIDE')
) AS v("key", "permission") JOIN "roles" r ON r."key" = v."key"
ON CONFLICT DO NOTHING;
