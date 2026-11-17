ALTER TABLE "image_assessments" ADD COLUMN "enhancement" jsonb;--> statement-breakpoint
ALTER TABLE "image_assessments" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "image_assessments" ADD COLUMN "outcome_reason" text;--> statement-breakpoint
ALTER TABLE "image_assessments" ADD COLUMN "published_image_url" text;--> statement-breakpoint
ALTER TABLE "image_assessments" ADD COLUMN "human_label" text;--> statement-breakpoint
ALTER TABLE "image_assessments" ADD COLUMN "human_labeled_at" timestamp with time zone;