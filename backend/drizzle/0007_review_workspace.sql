CREATE TABLE "contract_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"text" text NOT NULL,
	"storage_key" text,
	"authored_by" text NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_id" text NOT NULL,
	"token" text NOT NULL,
	"counterparty_email" text,
	"status" text DEFAULT 'active' NOT NULL,
	"base_version_id" text,
	"working_text" text,
	"submitted_version_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"review_session_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"suggested_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cv_contract_id_idx" ON "contract_versions" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "cv_contract_version_idx" ON "contract_versions" USING btree ("contract_id","version_number");--> statement-breakpoint
CREATE INDEX "rs_contract_id_idx" ON "review_sessions" USING btree ("contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rs_token_uidx" ON "review_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "rm_session_id_idx" ON "review_messages" USING btree ("review_session_id");
