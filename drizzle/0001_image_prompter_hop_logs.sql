CREATE TABLE "pipeline_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"hop_id" uuid NOT NULL,
	"step" text NOT NULL,
	"status" text NOT NULL,
	"latency_ms" integer,
	"metadata" jsonb,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_assessments" ADD COLUMN "enhancement_prompt" jsonb;--> statement-breakpoint
CREATE INDEX "pipeline_events_user_run_created_idx" ON "pipeline_events" USING btree ("user_id","run_id","created_at");