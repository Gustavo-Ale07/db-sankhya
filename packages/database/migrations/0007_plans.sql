CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"connection_id" text NOT NULL,
	"environment" text NOT NULL,
	"sql" text NOT NULL,
	"sql_hash" text NOT NULL,
	"params_hash" text NOT NULL,
	"capability" jsonb NOT NULL,
	"decision" jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"targets" jsonb NOT NULL,
	"targets_hash" text NOT NULL,
	"preview" jsonb NOT NULL,
	"preview_kind" text NOT NULL,
	"plan_hash" text NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"strong_confirmation_phrase" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "plans_status_check" CHECK ("plans"."status" in ('PENDING', 'APPROVED', 'CONSUMED', 'EXPIRED', 'INVALIDATED')),
	CONSTRAINT "plans_environment_check" CHECK ("plans"."environment" in ('PRODUCTION', 'HOMOLOGATION', 'SANDBOX')),
	CONSTRAINT "plans_consumed_check" CHECK (("plans"."status" = 'CONSUMED') = ("plans"."consumed_at" is not null))
);
--> statement-breakpoint
DROP TABLE "write_previews" CASCADE;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plans_user_idx" ON "plans" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "plans_connection_status_idx" ON "plans" USING btree ("connection_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_user_idempotency_key" ON "plans" USING btree ("user_id","idempotency_key");