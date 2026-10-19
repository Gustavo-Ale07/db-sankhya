DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'audit_events' AND column_name = 'omie_calls')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'audit_events' AND column_name = 'gateway_calls') THEN
    ALTER TABLE "audit_events" RENAME COLUMN "omie_calls" TO "gateway_calls";
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "gateway_calls" jsonb;
