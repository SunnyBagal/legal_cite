CREATE TABLE "bib_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bib_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"paper_id" bigint NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"authors" jsonb NOT NULL,
	"year" integer,
	"venue" text,
	"doi" text,
	"arxiv_id" text,
	"ids" jsonb NOT NULL,
	"raw" text
);
--> statement-breakpoint
CREATE TABLE "citation_contexts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "citation_contexts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"paper_id" bigint NOT NULL,
	"bib_entry_id" bigint NOT NULL,
	"ordinal" integer NOT NULL,
	"sentence" text NOT NULL,
	"previous_sentence" text,
	"section" text,
	"marker" text NOT NULL,
	"linked_by" text NOT NULL,
	CONSTRAINT "citation_contexts_linked_by_chk" CHECK ("citation_contexts"."linked_by" in ('grobid', 'numeric-fallback'))
);
--> statement-breakpoint
CREATE TABLE "existence_verdicts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "existence_verdicts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"bib_entry_id" bigint NOT NULL,
	"verdict" text NOT NULL,
	"mismatches" text[] NOT NULL,
	"matched_candidate_id" bigint,
	"reason" text NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "existence_verdicts_verdict_chk" CHECK ("existence_verdicts"."verdict" in ('VERIFIED', 'MISMATCH', 'NOT_FOUND', 'AMBIGUOUS'))
);
--> statement-breakpoint
CREATE TABLE "papers" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "papers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_kind" text NOT NULL,
	"source" text NOT NULL,
	"title" text,
	"pdf_sha256" text,
	"tei" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"options" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "papers_source_kind_chk" CHECK ("papers"."source_kind" in ('arxiv', 'pdf')),
	CONSTRAINT "papers_status_chk" CHECK ("papers"."status" in ('queued', 'ingested', 'extracted', 'resolving', 'reported', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "relevance_verdicts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "relevance_verdicts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"citation_context_id" bigint NOT NULL,
	"verdict" text NOT NULL,
	"reason" text NOT NULL,
	"method" text NOT NULL,
	"similarity" real,
	"model" text,
	"cited_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relevance_verdicts_verdict_chk" CHECK ("relevance_verdicts"."verdict" in ('SUPPORTS', 'PARTIAL', 'UNRELATED', 'CANNOT_TELL')),
	CONSTRAINT "relevance_verdicts_method_chk" CHECK ("relevance_verdicts"."method" in ('prefilter', 'llm', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "resolution_candidates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "resolution_candidates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"bib_entry_id" bigint NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"rank" integer NOT NULL,
	"record" jsonb NOT NULL,
	"score_total" real NOT NULL,
	"breakdown" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resolver_calls" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "resolver_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"bib_entry_id" bigint NOT NULL,
	"resolver" text NOT NULL,
	"candidate_count" integer NOT NULL,
	"error" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bib_entries" ADD CONSTRAINT "bib_entries_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation_contexts" ADD CONSTRAINT "citation_contexts_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation_contexts" ADD CONSTRAINT "citation_contexts_bib_entry_id_bib_entries_id_fk" FOREIGN KEY ("bib_entry_id") REFERENCES "public"."bib_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "existence_verdicts" ADD CONSTRAINT "existence_verdicts_bib_entry_id_bib_entries_id_fk" FOREIGN KEY ("bib_entry_id") REFERENCES "public"."bib_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "existence_verdicts" ADD CONSTRAINT "existence_verdicts_matched_candidate_id_resolution_candidates_id_fk" FOREIGN KEY ("matched_candidate_id") REFERENCES "public"."resolution_candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relevance_verdicts" ADD CONSTRAINT "relevance_verdicts_citation_context_id_citation_contexts_id_fk" FOREIGN KEY ("citation_context_id") REFERENCES "public"."citation_contexts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_candidates" ADD CONSTRAINT "resolution_candidates_bib_entry_id_bib_entries_id_fk" FOREIGN KEY ("bib_entry_id") REFERENCES "public"."bib_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolver_calls" ADD CONSTRAINT "resolver_calls_bib_entry_id_bib_entries_id_fk" FOREIGN KEY ("bib_entry_id") REFERENCES "public"."bib_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bib_entries_paper_key_uq" ON "bib_entries" USING btree ("paper_id","key");--> statement-breakpoint
CREATE INDEX "citation_contexts_paper_idx" ON "citation_contexts" USING btree ("paper_id");--> statement-breakpoint
CREATE INDEX "citation_contexts_bib_entry_idx" ON "citation_contexts" USING btree ("bib_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "existence_verdicts_bib_entry_uq" ON "existence_verdicts" USING btree ("bib_entry_id");--> statement-breakpoint
CREATE INDEX "existence_verdicts_matched_candidate_idx" ON "existence_verdicts" USING btree ("matched_candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relevance_verdicts_context_uq" ON "relevance_verdicts" USING btree ("citation_context_id");--> statement-breakpoint
CREATE INDEX "resolution_candidates_bib_entry_idx" ON "resolution_candidates" USING btree ("bib_entry_id","rank");--> statement-breakpoint
CREATE INDEX "resolver_calls_bib_entry_idx" ON "resolver_calls" USING btree ("bib_entry_id");