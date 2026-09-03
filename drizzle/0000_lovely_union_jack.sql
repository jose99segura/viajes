CREATE TABLE "alert_hits" (
	"alert_id" integer NOT NULL,
	"trip_key" text NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"seen" boolean DEFAULT false NOT NULL,
	CONSTRAINT "alert_hits_alert_id_trip_key_pk" PRIMARY KEY("alert_id","trip_key")
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"name" text NOT NULL,
	"airport" text,
	"max_price" numeric(10, 2),
	"max_days_off" integer,
	"min_nights" integer DEFAULT 1 NOT NULL,
	"max_nights" integer DEFAULT 14 NOT NULL,
	"direct_only" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fares" (
	"id" serial PRIMARY KEY NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"origin" text NOT NULL,
	"destination" text NOT NULL,
	"departure" timestamp NOT NULL,
	"arrival" timestamp,
	"airline" text,
	"stops" integer DEFAULT 0 NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"currency" text NOT NULL,
	"sold_out" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "favorites" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"out_origin" text NOT NULL,
	"out_destination" text NOT NULL,
	"out_departure" timestamp NOT NULL,
	"ret_origin" text,
	"ret_destination" text,
	"ret_departure" timestamp,
	"note" text,
	"price_at_save" numeric(10, 2),
	CONSTRAINT "favorites_identity" UNIQUE NULLS NOT DISTINCT("kind","out_origin","out_destination","out_departure","ret_origin","ret_destination","ret_departure")
);
--> statement-breakpoint
CREATE TABLE "package_fares" (
	"id" serial PRIMARY KEY NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"origin" text NOT NULL,
	"destination" text NOT NULL,
	"out_date" date NOT NULL,
	"nights" integer NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"currency" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_hits" ADD CONSTRAINT "alert_hits_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_fares_route_dep" ON "fares" USING btree ("origin","destination","departure");--> statement-breakpoint
CREATE INDEX "idx_fares_captured" ON "fares" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX "idx_pkg_route_date" ON "package_fares" USING btree ("origin","destination","out_date");