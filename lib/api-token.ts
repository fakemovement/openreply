import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { WorkspaceContext } from "@/lib/workspace-access";

/**
 * Machine authentication for the campaign API.
 *
 * WHY THIS EXISTS. Everything in OpenReply is behind a NextAuth magic link,
 * which is exactly right for a human and impossible for a script: there is no
 * password to supply, only an email somebody has to click. That meant every
 * campaign had to be typed into the dashboard by hand, and three launches in a
 * row shipped with their automation still uncreated.
 *
 * So this is a second, deliberately narrow way in. It is NOT a general API key
 * system:
 *
 *  - It is opt-in. With OPENREPLY_API_TOKEN unset, `resolveApiToken` always
 *    reports "absent" and nothing changes for anyone.
 *  - It only reaches the routes that explicitly call it. Today that is the
 *    campaigns collection. Billing, admin, workspace membership and the
 *    Instagram OAuth flow are untouched and stay session-only.
 *  - It is bound to ONE workspace. Either the one named by
 *    OPENREPLY_API_WORKSPACE_ID, or the only one that exists. If the database
 *    holds several and none is named, it refuses rather than guessing, because
 *    guessing would mean writing a campaign into somebody else's account.
 *
 * Revoking it is deleting the variable.
 */

// A token is compared as a SHA-256 digest rather than as raw bytes. Both
// digests are always 32 bytes, so timingSafeEqual never throws on a length
// mismatch and the comparison leaks neither the token nor its length.
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

// Short secrets are brute-forceable and this endpoint writes to production, so
// a weak token is treated as a misconfiguration rather than quietly accepted.
export const MIN_TOKEN_LENGTH = 32;

export function readBearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return null;
  const token = rest.join(" ").trim();
  return token.length > 0 ? token : null;
}

export type ApiTokenResult =
  | { status: "absent" }
  | { status: "misconfigured"; reason: string }
  | { status: "invalid" }
  | { status: "ok"; context: WorkspaceContext };

export async function resolveApiToken(
  request: NextRequest
): Promise<ApiTokenResult> {
  const presented = readBearerToken(request);
  // No bearer header at all: this is a browser request, let the session path
  // handle it.
  if (!presented) return { status: "absent" };

  const expected = process.env.OPENREPLY_API_TOKEN;
  if (!expected) return { status: "absent" };

  if (expected.length < MIN_TOKEN_LENGTH) {
    return {
      status: "misconfigured",
      reason: `OPENREPLY_API_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`,
    };
  }

  if (!tokenMatches(presented, expected)) return { status: "invalid" };

  const pinnedWorkspaceId = process.env.OPENREPLY_API_WORKSPACE_ID?.trim();

  if (pinnedWorkspaceId) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: pinnedWorkspaceId },
      select: { id: true },
    });
    if (!workspace) {
      return {
        status: "misconfigured",
        reason: "OPENREPLY_API_WORKSPACE_ID does not match any workspace",
      };
    }
    return { status: "ok", context: await buildContext(workspace.id) };
  }

  // Nothing pinned. Fine when there is exactly one workspace, which is the
  // single-tenant self-hosted case this was built for.
  const workspaces = await prisma.workspace.findMany({
    take: 2,
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  if (workspaces.length === 0) {
    return { status: "misconfigured", reason: "No workspace exists yet" };
  }
  if (workspaces.length > 1) {
    return {
      status: "misconfigured",
      reason:
        "Several workspaces exist; set OPENREPLY_API_WORKSPACE_ID to say which one the token may write to",
    };
  }

  return { status: "ok", context: await buildContext(workspaces[0].id) };
}

/**
 * The token acts as the workspace's owner, so downstream role checks
 * (`canManageWorkspace`) behave exactly as they would for the human. The real
 * owner's user id is attached rather than a synthetic one, so anything that
 * later attributes a write to a user still points at a row that exists.
 */
async function buildContext(workspaceId: string): Promise<WorkspaceContext> {
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
  });

  const member = await prisma.workspaceMember.findFirst({
    where: { workspaceId, role: "OWNER" },
    orderBy: { createdAt: "asc" },
  });

  const fallback = member
    ? null
    : await prisma.workspaceMember.findFirst({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
      });

  return {
    userId: member?.userId ?? fallback?.userId ?? "",
    workspaceId,
    workspace,
    role: "OWNER",
  };
}
