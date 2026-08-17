import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// The module reads the database to resolve which workspace a token may write
// to, so the client is faked. Every test that gets as far as a lookup declares
// what it expects to find.
const findManyWorkspace = vi.fn();
const findUniqueWorkspace = vi.fn();
const findUniqueOrThrowWorkspace = vi.fn();
const findFirstMember = vi.fn();

vi.mock("@/lib/db/client", () => ({
  prisma: {
    workspace: {
      findMany: (...a: unknown[]) => findManyWorkspace(...a),
      findUnique: (...a: unknown[]) => findUniqueWorkspace(...a),
      findUniqueOrThrow: (...a: unknown[]) => findUniqueOrThrowWorkspace(...a),
    },
    workspaceMember: {
      findFirst: (...a: unknown[]) => findFirstMember(...a),
    },
  },
}));

const { readBearerToken, resolveApiToken, MIN_TOKEN_LENGTH } = await import(
  "../lib/api-token"
);

// 40 chars, comfortably over the minimum.
const GOOD_TOKEN = "z".repeat(40);

function req(headers: Record<string, string> = {}): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  findManyWorkspace.mockReset();
  findUniqueWorkspace.mockReset();
  findUniqueOrThrowWorkspace.mockReset();
  findFirstMember.mockReset();

  findUniqueOrThrowWorkspace.mockResolvedValue({ id: "ws_1", name: "Solo" });
  findFirstMember.mockResolvedValue({ userId: "user_1", role: "OWNER" });
});

describe("readBearerToken", () => {
  it("reads a bearer token regardless of scheme casing", () => {
    expect(readBearerToken(req({ authorization: "Bearer abc" }))).toBe("abc");
    expect(readBearerToken(req({ authorization: "bearer abc" }))).toBe("abc");
    expect(readBearerToken(req({ authorization: "BEARER abc" }))).toBe("abc");
  });

  it("ignores other schemes and empty values", () => {
    expect(readBearerToken(req({ authorization: "Basic abc" }))).toBeNull();
    expect(readBearerToken(req({ authorization: "Bearer" }))).toBeNull();
    expect(readBearerToken(req({ authorization: "Bearer   " }))).toBeNull();
    expect(readBearerToken(req())).toBeNull();
  });
});

describe("resolveApiToken", () => {
  it("stays out of the way when there is no bearer header", async () => {
    vi.stubEnv("OPENREPLY_API_TOKEN", GOOD_TOKEN);
    const result = await resolveApiToken(req());
    // "absent" is what lets the browser session path run untouched.
    expect(result.status).toBe("absent");
  });

  it("is disabled entirely when the env var is unset", async () => {
    const result = await resolveApiToken(
      req({ authorization: `Bearer ${GOOD_TOKEN}` })
    );
    expect(result.status).toBe("absent");
    expect(findManyWorkspace).not.toHaveBeenCalled();
  });

  it("rejects a wrong token", async () => {
    vi.stubEnv("OPENREPLY_API_TOKEN", GOOD_TOKEN);
    const result = await resolveApiToken(
      req({ authorization: `Bearer ${"y".repeat(40)}` })
    );
    expect(result.status).toBe("invalid");
    expect(findManyWorkspace).not.toHaveBeenCalled();
  });

  it("rejects a token that is a prefix of the real one", async () => {
    vi.stubEnv("OPENREPLY_API_TOKEN", GOOD_TOKEN);
    const result = await resolveApiToken(
      req({ authorization: `Bearer ${GOOD_TOKEN.slice(0, 39)}` })
    );
    expect(result.status).toBe("invalid");
  });

  it("refuses to run with a token short enough to brute force", async () => {
    vi.stubEnv("OPENREPLY_API_TOKEN", "short");
    const result = await resolveApiToken(req({ authorization: "Bearer short" }));
    expect(result.status).toBe("misconfigured");
    if (result.status === "misconfigured") {
      expect(result.reason).toContain(String(MIN_TOKEN_LENGTH));
    }
  });

  it("accepts the right token and binds it to the only workspace", async () => {
    vi.stubEnv("OPENREPLY_API_TOKEN", GOOD_TOKEN);
    findManyWorkspace.mockResolvedValue([{ id: "ws_1" }]);

    const result = await resolveApiToken(
      req({ authorization: `Bearer ${GOOD_TOKEN}` })
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.context.workspaceId).toBe("ws_1");
      // OWNER so the existing canManageWorkspace checks behave as they do for
      // the human, and a real user id so attributed writes point at a live row.
      expect(result.context.role).toBe("OWNER");
      expect(result.context.userId).toBe("user_1");
    }
  });

  // The one that actually protects other people: with more than one workspace
  // and nothing pinned, a guess would write a campaign into the wrong account.
  it("refuses to guess when several workspaces exist", async () => {
    vi.stubEnv("OPENREPLY_API_TOKEN", GOOD_TOKEN);
    findManyWorkspace.mockResolvedValue([{ id: "ws_1" }, { id: "ws_2" }]);

    const result = await resolveApiToken(
      req({ authorization: `Bearer ${GOOD_TOKEN}` })
    );

    expect(result.status).toBe("misconfigured");
    if (result.status === "misconfigured") {
      expect(result.reason).toContain("OPENREPLY_API_WORKSPACE_ID");
    }
  });

  it("uses the pinned workspace when one is named", async () => {
    vi.stubEnv("OPENREPLY_API_TOKEN", GOOD_TOKEN);
    vi.stubEnv("OPENREPLY_API_WORKSPACE_ID", "ws_2");
    findUniqueWorkspace.mockResolvedValue({ id: "ws_2" });
    findUniqueOrThrowWorkspace.mockResolvedValue({ id: "ws_2", name: "Pinned" });

    const result = await resolveApiToken(
      req({ authorization: `Bearer ${GOOD_TOKEN}` })
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.context.workspaceId).toBe("ws_2");
    // Pinning must not consult the "is there exactly one" fallback at all.
    expect(findManyWorkspace).not.toHaveBeenCalled();
  });

  it("reports a pinned workspace that does not exist", async () => {
    vi.stubEnv("OPENREPLY_API_TOKEN", GOOD_TOKEN);
    vi.stubEnv("OPENREPLY_API_WORKSPACE_ID", "ws_missing");
    findUniqueWorkspace.mockResolvedValue(null);

    const result = await resolveApiToken(
      req({ authorization: `Bearer ${GOOD_TOKEN}` })
    );

    expect(result.status).toBe("misconfigured");
  });

  it("reports an empty database rather than inventing a workspace", async () => {
    vi.stubEnv("OPENREPLY_API_TOKEN", GOOD_TOKEN);
    findManyWorkspace.mockResolvedValue([]);

    const result = await resolveApiToken(
      req({ authorization: `Bearer ${GOOD_TOKEN}` })
    );

    expect(result.status).toBe("misconfigured");
  });
});
