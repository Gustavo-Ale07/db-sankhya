ALTER TABLE "audit_events" ADD COLUMN "connection_id" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "environment" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "plan_hash" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "capability" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "verification" jsonb;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "approval_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "policy_decision" jsonb;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "snapshot" jsonb;--> statement-breakpoint
CREATE INDEX "audit_events_plan_idx" ON "audit_events" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "audit_events_connection_idx" ON "audit_events" USING btree ("connection_id","created_at");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_environment_check" CHECK ("audit_events"."environment" IS NULL OR "audit_events"."environment" IN ('PRODUCTION', 'HOMOLOGATION', 'SANDBOX'));