CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "project_id" text;--> statement-breakpoint
CREATE INDEX "projects_user_id_idx" ON "projects" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "contracts_project_id_idx" ON "contracts" USING btree ("project_id");
