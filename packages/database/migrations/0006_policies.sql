CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"effect" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"environments" text[] DEFAULT '{}'::text[] NOT NULL,
	"connection_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"actions" text[] NOT NULL,
	"entities" text[] DEFAULT '{}'::text[] NOT NULL,
	"columns" text[] DEFAULT '{}'::text[] NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"override_where_required" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policies_effect_check" CHECK ("policies"."effect" in ('ALLOW', 'DENY')),
	CONSTRAINT "policies_subject_type_check" CHECK ("policies"."subject_type" in ('user', 'group', 'everyone'))
);
