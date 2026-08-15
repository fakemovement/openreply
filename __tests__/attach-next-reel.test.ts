import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockGetUserMedia, mockDecryptToken } = vi.hoisted(() => ({
  mockPrisma: {
    automation: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
  mockGetUserMedia: vi.fn(),
  mockDecryptToken: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", () => ({ getUserMedia: mockGetUserMedia }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));

import { attachPendingNextReel } from "@/lib/automations/attach-next-reel";

const ACCOUNT = {
  id: "acct_1",
  instagramId: "1784144",
  accessToken: "encrypted",
};

function campaign(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "auto_1",
    instagramAccountId: ACCOUNT.id,
    createdAt: new Date("2026-08-15T12:00:00Z"),
    instagramAccount: ACCOUNT,
    ...overrides,
  };
}

function reel(id: string, timestamp: string) {
  return {
    id,
    media_product_type: "REELS",
    timestamp,
    permalink: `https://instagram.com/reel/${id}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDecryptToken.mockReturnValue("plain-token");
  mockPrisma.automation.update.mockResolvedValue({});
});

describe("attachPendingNextReel", () => {
  it("binds the earliest reel posted after the campaign was created", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([campaign()]);
    // Deliberately out of order, and one reel predating the campaign.
    mockGetUserMedia.mockResolvedValue([
      reel("later", "2026-08-15T18:00:00Z"),
      reel("old", "2026-08-14T09:00:00Z"),
      reel("target", "2026-08-15T14:00:00Z"),
    ]);

    const result = await attachPendingNextReel();

    expect(result).toEqual({ checked: 1, bound: 1, failedAccounts: 0 });
    expect(mockPrisma.automation.update).toHaveBeenCalledWith({
      where: { id: "auto_1" },
      data: {
        postId: "target",
        postUrl: "https://instagram.com/reel/target",
        pendingNextReel: false,
      },
    });
  });

  it("leaves the campaign pending when every reel predates it", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([campaign()]);
    mockGetUserMedia.mockResolvedValue([reel("old", "2026-08-14T09:00:00Z")]);

    const result = await attachPendingNextReel();

    expect(result.bound).toBe(0);
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("ignores posts that are not reels", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([campaign()]);
    mockGetUserMedia.mockResolvedValue([
      {
        id: "photo",
        media_product_type: "FEED",
        timestamp: "2026-08-15T13:00:00Z",
      },
      reel("the-reel", "2026-08-15T16:00:00Z"),
    ]);

    await attachPendingNextReel();

    expect(mockPrisma.automation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ postId: "the-reel" }) })
    );
  });

  it("fetches media once per account when several campaigns are pending", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      campaign({ id: "auto_1" }),
      campaign({ id: "auto_2" }),
    ]);
    mockGetUserMedia.mockResolvedValue([reel("target", "2026-08-15T14:00:00Z")]);

    const result = await attachPendingNextReel();

    expect(mockGetUserMedia).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ checked: 2, bound: 2, failedAccounts: 0 });
  });

  it("reports a failure instead of throwing when the media fetch fails", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([campaign()]);
    mockGetUserMedia.mockRejectedValue(new Error("token expired"));

    const result = await attachPendingNextReel();

    expect(result).toEqual({ checked: 1, bound: 0, failedAccounts: 1 });
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("scopes the sweep to one account when an instagramId is given", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);

    await attachPendingNextReel({ instagramId: "1784144" });

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          pendingNextReel: true,
          instagramAccount: { instagramId: "1784144" },
        },
      })
    );
  });
});
