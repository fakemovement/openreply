-- Follow nudge: DM the commenters who don't follow, stay silent for the ones who do.

-- New DmLog outcomes for "nothing was sent, on purpose".
ALTER TYPE "DmStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_ALREADY_FOLLOWS';
ALTER TYPE "DmStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_FOLLOW_UNKNOWN';

ALTER TABLE "Automation"
  ADD COLUMN IF NOT EXISTS "followNudgeEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "followNudgeMessage" TEXT,
  ADD COLUMN IF NOT EXISTS "nudgeUnknownContacts" BOOLEAN NOT NULL DEFAULT false;

-- Our own memory of every follow answer Instagram ever gave us, because it
-- refuses to answer for people who have not messaged the account.
CREATE TABLE IF NOT EXISTS "ContactFollowState" (
  "id" TEXT NOT NULL,
  "instagramAccountId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "follows" BOOLEAN NOT NULL,
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nudgedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContactFollowState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ContactFollowState_instagramAccountId_contactId_key"
  ON "ContactFollowState"("instagramAccountId", "contactId");

CREATE INDEX IF NOT EXISTS "ContactFollowState_instagramAccountId_idx"
  ON "ContactFollowState"("instagramAccountId");

ALTER TABLE "ContactFollowState"
  ADD CONSTRAINT "ContactFollowState_instagramAccountId_fkey"
  FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
