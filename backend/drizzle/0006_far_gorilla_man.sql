CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"company" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "contacts_user_id_idx" ON "contacts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "contacts_user_last_used_idx" ON "contacts" USING btree ("user_id","last_used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_user_email_uidx" ON "contacts" USING btree ("user_id","email");