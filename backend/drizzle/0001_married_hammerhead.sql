CREATE TYPE "public"."signer_role" AS ENUM('creator', 'counterparty', 'other');--> statement-breakpoint
CREATE TYPE "public"."signer_status" AS ENUM('pending', 'sent', 'viewed', 'signed', 'declined');--> statement-breakpoint
ALTER TYPE "public"."contract_status" ADD VALUE 'out_for_signature';--> statement-breakpoint
ALTER TYPE "public"."contract_status" ADD VALUE 'partially_signed';--> statement-breakpoint
ALTER TYPE "public"."thread_direction" ADD VALUE 'system';--> statement-breakpoint
CREATE TABLE "contract_signers" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_id" text NOT NULL,
	"signature_request_id" text NOT NULL,
	"dropbox_signature_id" text,
	"signer_email" text NOT NULL,
	"signer_name" text NOT NULL,
	"signing_order" integer,
	"role" "signer_role" DEFAULT 'other' NOT NULL,
	"genie_user_id" text,
	"status" "signer_status" DEFAULT 'pending' NOT NULL,
	"signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "signature_request_id" text;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "signed_storage_key" text;--> statement-breakpoint
CREATE INDEX "cs_contract_id_idx" ON "contract_signers" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "cs_signature_request_id_idx" ON "contract_signers" USING btree ("signature_request_id");--> statement-breakpoint
CREATE INDEX "cs_contract_order_idx" ON "contract_signers" USING btree ("contract_id","signing_order");--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_signature_request_id_uidx" ON "contracts" USING btree ("signature_request_id");