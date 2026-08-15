import { prisma } from "@/lib/db/client";
import { getUserMedia, type InstagramMedia } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";

/**
 * Binds "next reel" campaigns to a real post.
 *
 * A pending campaign has no postId and matchAnyPost false, so it matches no
 * comment at all until something fills the postId in. Instagram sends no
 * webhook when media is published, so we look the reel up ourselves.
 *
 * Callers: the DM worker (every poll, and on any comment for an account with a
 * pending campaign) and the cron route. They share this function so the live
 * path and the scheduled path can never disagree about which reel is "next".
 */

const MEDIA_LOOKBACK = 25;

export interface AttachResult {
  checked: number;
  bound: number;
  failedAccounts: number;
}

function isReel(media: InstagramMedia): boolean {
  return media.media_product_type === "REELS";
}

export async function attachPendingNextReel(options?: {
  /** Restrict the sweep to one connected account. */
  instagramId?: string;
}): Promise<AttachResult> {
  const pending = await prisma.automation.findMany({
    where: {
      pendingNextReel: true,
      ...(options?.instagramId
        ? { instagramAccount: { instagramId: options.instagramId } }
        : {}),
    },
    include: { instagramAccount: true },
  });

  // Group by connected account so we fetch each account's media only once.
  const byAccount = new Map<
    string,
    {
      account: (typeof pending)[number]["instagramAccount"];
      automations: typeof pending;
    }
  >();
  for (const automation of pending) {
    const key = automation.instagramAccountId;
    const entry = byAccount.get(key);
    if (entry) entry.automations.push(automation);
    else
      byAccount.set(key, {
        account: automation.instagramAccount,
        automations: [automation],
      });
  }

  let bound = 0;
  let checked = 0;
  const failures: string[] = [];

  for (const { account, automations } of byAccount.values()) {
    checked += automations.length;
    if (!account?.accessToken) continue;

    let reels: InstagramMedia[];
    try {
      const token = decryptToken(account.accessToken);
      const media = await getUserMedia(token, MEDIA_LOOKBACK);
      reels = media
        .filter(isReel)
        .sort(
          (a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
    } catch (err) {
      failures.push(account.id);
      console.error("[attach-next-reel] media fetch failed", account.id, err);
      continue;
    }

    for (const automation of automations) {
      // The "next" reel = the earliest one posted after the campaign was created.
      const nextReel = reels.find(
        (reel) => new Date(reel.timestamp) > automation.createdAt
      );
      if (!nextReel) continue;

      await prisma.automation.update({
        where: { id: automation.id },
        data: {
          postId: nextReel.id,
          postUrl: nextReel.permalink ?? null,
          pendingNextReel: false,
        },
      });
      bound += 1;
    }
  }

  return { checked, bound, failedAccounts: failures.length };
}
