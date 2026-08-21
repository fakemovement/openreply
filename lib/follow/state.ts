import { prisma } from "@/lib/db/client";
import { getUserFollowStatus } from "@/lib/meta/client";

/**
 * Follow status, remembered.
 *
 * Instagram will only tell you whether someone follows a business account if
 * that person has messaged the account at some point — Meta calls it user
 * consent, and it is set by a DM, an icebreaker, or a button tap, never by a
 * comment. Ask about a plain commenter and the call fails with "User consent is
 * required to access user profile", which is indistinguishable from "we don't
 * know".
 *
 * So every answer we do get is written down. A person who tapped a button on
 * some other campaign last week is a person whose follow status we can still
 * act on today, without asking Instagram again.
 */

/** How long a stored answer counts as current before we re-read it. */
export const FOLLOW_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Don't nudge the same person again inside this window. */
export const FOLLOW_NUDGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Write down what Instagram just told us. Safe to call from any code path that
 * happens to learn a follow status; failures are swallowed, because recording
 * the fact is never more important than the message the caller is sending.
 */
export async function recordFollowStatus(
  instagramAccountId: string,
  contactId: string,
  follows: boolean
): Promise<void> {
  try {
    await prisma.contactFollowState.upsert({
      where: {
        instagramAccountId_contactId: { instagramAccountId, contactId },
      },
      create: { instagramAccountId, contactId, follows, checkedAt: new Date() },
      update: { follows, checkedAt: new Date() },
    });
  } catch (error) {
    console.error(
      "[Follow state] Failed to record follow status:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

/** Note that we just nudged someone, so the cooldown starts. */
export async function recordFollowNudge(
  instagramAccountId: string,
  contactId: string
): Promise<void> {
  try {
    await prisma.contactFollowState.upsert({
      where: {
        instagramAccountId_contactId: { instagramAccountId, contactId },
      },
      // A nudge only ever goes to someone we already know doesn't follow, so
      // false is the honest value if the row somehow isn't there yet.
      create: {
        instagramAccountId,
        contactId,
        follows: false,
        nudgedAt: new Date(),
      },
      update: { nudgedAt: new Date() },
    });
  } catch (error) {
    console.error(
      "[Follow state] Failed to record follow nudge:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

export interface ResolvedFollowState {
  /** true / false when known, null when Instagram won't say and we have no record. */
  follows: boolean | null;
  /** Where the answer came from, for logging. */
  source: "live" | "stored" | "unknown";
  /** When this person was last nudged, if ever. */
  nudgedAt: Date | null;
}

/**
 * Best available answer to "does this person follow the account?".
 *
 * Order: a fresh stored answer, then a live call to Instagram (recorded when it
 * succeeds), then a stale stored answer, then null. The live call is skipped
 * when the stored answer is still inside its TTL, so a busy comment thread
 * doesn't spend a Graph call per comment on people we already know.
 */
export async function resolveFollowState(
  accessToken: string,
  instagramAccountId: string,
  contactId: string
): Promise<ResolvedFollowState> {
  const stored = await prisma.contactFollowState
    .findUnique({
      where: {
        instagramAccountId_contactId: { instagramAccountId, contactId },
      },
    })
    .catch(() => null);

  const isFresh =
    stored != null &&
    Date.now() - stored.checkedAt.getTime() < FOLLOW_STATE_TTL_MS;

  if (isFresh) {
    return {
      follows: stored.follows,
      source: "stored",
      nudgedAt: stored.nudgedAt,
    };
  }

  const live = await getUserFollowStatus(accessToken, contactId);
  if (live !== null) {
    await recordFollowStatus(instagramAccountId, contactId, live);
    return { follows: live, source: "live", nudgedAt: stored?.nudgedAt ?? null };
  }

  // Instagram refused. An expired record still beats knowing nothing: people
  // rarely unfollow, and the alternative is treating a known follower as a
  // stranger.
  if (stored) {
    return {
      follows: stored.follows,
      source: "stored",
      nudgedAt: stored.nudgedAt,
    };
  }

  return { follows: null, source: "unknown", nudgedAt: null };
}

/** True when this person was nudged recently enough that we should not repeat it. */
export function isInNudgeCooldown(nudgedAt: Date | null): boolean {
  if (!nudgedAt) return false;
  return Date.now() - nudgedAt.getTime() < FOLLOW_NUDGE_COOLDOWN_MS;
}
