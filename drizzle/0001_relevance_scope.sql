ALTER TABLE "relevance_verdicts" ADD COLUMN "abstract_source" text;--> statement-breakpoint
ALTER TABLE "relevance_verdicts" ADD COLUMN "scope" text DEFAULT 'abstract-level, needs human review' NOT NULL;--> statement-breakpoint
ALTER TABLE "relevance_verdicts" ADD COLUMN "verifier_version" text;