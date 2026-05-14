-- Gateway access tracking on users
ALTER TABLE "users" ADD COLUMN "gateway_accepted_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "gateway_verified_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "gateway_verified" BOOLEAN NOT NULL DEFAULT false;
