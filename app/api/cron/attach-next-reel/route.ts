import { NextRequest, NextResponse } from "next/server";
import { attachPendingNextReel } from "@/lib/automations/attach-next-reel";

/**
 * Scheduled backstop for binding "next reel" campaigns to a real post.
 *
 * The DM worker does this every few minutes and on every incoming comment, so
 * this route is no longer the primary path. It stays callable by hand for when
 * the worker is down and a campaign needs binding now.
 */

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const result = await attachPendingNextReel();

  return NextResponse.json({ success: true, data: result });
}
