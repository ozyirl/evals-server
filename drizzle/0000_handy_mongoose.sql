CREATE TABLE "image_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"image_url" text,
	"file_name" text,
	"mime_type" text,
	"byte_size" integer,
	"status" text NOT NULL,
	"label" text,
	"requires_enhancement" boolean,
	"needs_review" boolean,
	"confidence" real,
	"scores" jsonb,
	"issues" jsonb,
	"reason" text,
	"model" text,
	"latency_ms" integer,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "image_assessments_user_created_idx" ON "image_assessments" USING btree ("user_id","created_at");