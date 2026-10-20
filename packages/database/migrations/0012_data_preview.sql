INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", v."permission" FROM (VALUES
  ('OPERATOR', 'DATA.PREVIEW'),
  ('ADMIN', 'DATA.PREVIEW')
) AS v("key", "permission") JOIN "roles" r ON r."key" = v."key"
ON CONFLICT DO NOTHING;
