CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"plan_hash" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decision" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approvals_decision_check" CHECK ("approvals"."decision" in ('APPROVE', 'REJECT')),
	CONSTRAINT "approvals_decided_check" CHECK (("approvals"."decision" is null) = ("approvals"."decided_by" is null) and ("approvals"."decision" is null) = ("approvals"."decided_at" is null)),
	CONSTRAINT "approvals_four_eyes_check" CHECK ("approvals"."decided_by" <> "approvals"."requested_by")
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_plan_key" ON "approvals" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "approvals_pending_idx" ON "approvals" USING btree ("decision","expires_at");