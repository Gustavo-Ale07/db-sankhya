CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"environment" text NOT NULL,
	"mode" text NOT NULL,
	"base_url" text NOT NULL,
	"dialect" text NOT NULL,
	"client_id_enc" text,
	"client_secret_enc" text,
	"x_token_enc" text,
	"secrets_rotated_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_environment_check" CHECK ("connections"."environment" in ('PRODUCTION', 'HOMOLOGATION', 'SANDBOX')),
	CONSTRAINT "connections_mode_check" CHECK ("connections"."mode" in ('live', 'mock')),
	CONSTRAINT "connections_dialect_check" CHECK ("connections"."dialect" in ('oracle', 'mssql'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "connections_name_key" ON "connections" USING btree ("name");