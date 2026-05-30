ALTER TABLE "contract_signers" ADD COLUMN "signing_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX "cs_signing_token_uidx" ON "contract_signers" USING btree ("signing_token");