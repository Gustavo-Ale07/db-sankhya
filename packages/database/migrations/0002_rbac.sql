CREATE TABLE "group_members" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "group_roles" (
	"group_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "group_roles_group_id_role_id_pk" PRIMARY KEY("group_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_pk" PRIMARY KEY("role_id","permission")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_key_format_check" CHECK ("roles"."key" ~ '^[A-Z][A-Z0-9_]{1,39}$')
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_role_check";--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_roles" ADD CONSTRAINT "group_roles_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_roles" ADD CONSTRAINT "group_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_members_user_idx" ON "group_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_name_key" ON "groups" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_key_key" ON "roles" USING btree ("key");--> statement-breakpoint
INSERT INTO "roles" ("key", "name", "description", "system") VALUES
  ('VIEWER', 'Leitor', 'Consulta dados e usa tabelas temporárias.', true),
  ('OPERATOR', 'Operador', 'Leitor que também insere e altera registros.', true),
  ('ADMIN', 'Administrador', 'Administra usuários, grupos, papéis, políticas, conexões e segurança. Não altera dados do ERP.', true);--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", v."permission" FROM (VALUES
  ('VIEWER', 'QUERY.SELECT'),
  ('VIEWER', 'TEMP.CREATE'),
  ('VIEWER', 'TEMP.WRITE'),
  ('VIEWER', 'TEMP.DROP'),
  ('VIEWER', 'TEMP.MATERIALIZE'),
  ('OPERATOR', 'QUERY.SELECT'),
  ('OPERATOR', 'TEMP.CREATE'),
  ('OPERATOR', 'TEMP.WRITE'),
  ('OPERATOR', 'TEMP.DROP'),
  ('OPERATOR', 'TEMP.MATERIALIZE'),
  ('OPERATOR', 'DATA.INSERT'),
  ('OPERATOR', 'DATA.UPDATE'),
  ('ADMIN', 'QUERY.SELECT'),
  ('ADMIN', 'TEMP.CREATE'),
  ('ADMIN', 'TEMP.WRITE'),
  ('ADMIN', 'TEMP.DROP'),
  ('ADMIN', 'TEMP.MATERIALIZE'),
  ('ADMIN', 'APPROVAL.DECIDE'),
  ('ADMIN', 'AUDIT.READ'),
  ('ADMIN', 'ADMIN.USERS'),
  ('ADMIN', 'ADMIN.GROUPS'),
  ('ADMIN', 'ADMIN.ROLES'),
  ('ADMIN', 'ADMIN.POLICIES'),
  ('ADMIN', 'ADMIN.CONNECTIONS'),
  ('ADMIN', 'ADMIN.SECURITY')
) AS v("key", "permission") JOIN "roles" r ON r."key" = v."key";--> statement-breakpoint
INSERT INTO "user_roles" ("user_id", "role_id")
SELECT u."id", r."id" FROM "users" u JOIN "roles" r ON r."key" = u."role";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "role";