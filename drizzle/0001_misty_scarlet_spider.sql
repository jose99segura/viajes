CREATE TABLE "fetch_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"provider" text NOT NULL,
	"route" text,
	"status" text NOT NULL,
	"fares_found" integer DEFAULT 0 NOT NULL,
	"fares_stored" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "idx_runs_captured" ON "fetch_runs" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX "idx_runs_provider" ON "fetch_runs" USING btree ("provider","route","captured_at");