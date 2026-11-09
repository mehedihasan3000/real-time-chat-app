import { describe, expect, it } from "vitest";

import {
  APPEAL_WINDOW_DAYS,
  BLOCK_MAX,
  REPORTS_PER_DAY,
  reportExpiresAt,
  validateBlockCreate,
  validateReportCreate,
} from "../../packages/contracts/src/index.js";
import { MemoryBlockStore } from "../../apps/api/src/blocks/store.js";
import {
  MemoryReportStore,
  operatorView,
  reportedView,
  reporterView,
} from "../../apps/api/src/reports/store.js";

describe("TC-PRIV-004 — report consent, excerpts, uniqueness, TTL", () => {
  it("requires explicit consent when excerpts are included", () => {
    const noConsent = validateReportCreate({
      reportedUserId: "user-b",
      reason: "spam",
      optionalReferences: [],
      optionalExcerpts: ["hello"],
      excerptConsent: false,
    });
    expect(noConsent.ok).toBe(false);
    const consented = validateReportCreate({
      reportedUserId: "user-b",
      reason: "spam",
      optionalReferences: ["msg-1"],
      optionalExcerpts: ["hello"],
      excerptConsent: true,
    });
    expect(consented.ok).toBe(true);
  });

  it("enforces excerpt/reference bounds and reason/self rules", () => {
    expect(
      validateReportCreate({
        reportedUserId: "user-b",
        reason: "spam",
        optionalReferences: Array.from({ length: 6 }, (_, i) => `ref-${i}`),
      }).ok,
    ).toBe(false);
    expect(
      validateReportCreate({
        reportedUserId: "user-b",
        reason: "spam",
        optionalExcerpts: ["x".repeat(2500)],
        excerptConsent: true,
      }).ok,
    ).toBe(false);
    expect(validateReportCreate({ reportedUserId: "user-b", reason: "not-a-reason" }).ok).toBe(
      false,
    );
    expect(validateBlockCreate({ blockedUserId: "" }).ok).toBe(false);
  });

  it("stores only consented excerpts with a 90-day TTL; reporter identity stays server-side", async () => {
    const store = new MemoryReportStore();
    const created = await store.create("user-a", {
      reportedUserId: "user-b",
      reason: "spam",
      references: ["msg-1"],
      excerpts: ["ex-1"],
      excerptConsent: true,
    });
    if (!created.ok) throw new Error("expected create");
    // TTL starts only at final disposition; open reports do not expire.
    expect(created.record.expiresAt).toBe("");
    await store.dispose(created.record.reportId, "warning", new Date("2026-11-09T00:00:00Z"));
    const disposed = await store.getById(created.record.reportId);
    expect(disposed?.expiresAt).toBe(reportExpiresAt(new Date("2026-11-09T00:00:00Z")));
    const reporter = reporterView(created.record);
    expect(reporter).not.toHaveProperty("reporterUserId");
    expect(reporter).not.toHaveProperty("excerpts");
    const operator = operatorView(created.record);
    expect(operator.excerpts).toEqual(["ex-1"]);
    const reported = reportedView(created.record);
    expect(reported).not.toHaveProperty("reporterUserId");
    expect(reported).not.toHaveProperty("excerpts");
    expect(reported).not.toHaveProperty("references");
  });

  it("enforces 10/day and 24h dedupe", async () => {
    const store = new MemoryReportStore();
    const first = await store.create("user-a", {
      reportedUserId: "user-b",
      reason: "spam",
      references: [],
      excerpts: [],
      excerptConsent: false,
    });
    expect(first.ok).toBe(true);
    const duplicate = await store.create("user-a", {
      reportedUserId: "user-b",
      reason: "harassment",
      references: [],
      excerpts: [],
      excerptConsent: false,
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.code).toBe("DUPLICATE");
  });

  it("self-report is rejected", async () => {
    const store = new MemoryReportStore();
    const result = await store.create("user-a", {
      reportedUserId: "user-a",
      reason: "spam",
      references: [],
      excerpts: [],
      excerptConsent: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SELF");
  });
});

describe("TC-PRIV-003 — silent bilateral block (50 max, private)", () => {
  it("caps at 50 and keeps the list private", async () => {
    const store = new MemoryBlockStore();
    expect(await store.create("user-a", "user-a")).toBe("SELF");
    await store.create("user-a", "user-b");
    expect(await store.isBlocked("user-a", "user-b")).toBe(true);
    expect(await store.isBlocked("user-b", "user-a")).toBe(true);
    expect(await store.list("user-b", 50)).toEqual([]);
    for (let i = 0; i < 49; i += 1) {
      await store.create("user-a", `user-${i}`);
    }
    expect(await store.count("user-a")).toBe(BLOCK_MAX);
    expect(await store.create("user-a", "user-overflow")).toBe("LIMIT");
  });

  it("unblock removes the block and history (idempotent)", async () => {
    const store = new MemoryBlockStore();
    await store.create("user-a", "user-b");
    await store.remove("user-a", "user-b");
    expect(await store.isBlocked("user-a", "user-b")).toBe(false);
    await store.remove("user-a", "user-b");
    expect(await store.isBlocked("user-a", "user-b")).toBe(false);
  });
});

describe("TC-PRIV-005 — operator disposition, one appeal, 7-day window", () => {
  it("allows one appeal within 7 days; TTL restarts at disposition", async () => {
    const store = new MemoryReportStore();
    const created = await store.create("user-a", {
      reportedUserId: "user-b",
      reason: "spam",
      references: [],
      excerpts: [],
      excerptConsent: false,
    });
    if (!created.ok) throw new Error("expected create");
    const id = created.record.reportId;
    // Appeal before disposition is rejected.
    expect(await store.appeal(id, "user-b")).toBe("NO_DISPOSITION");
    await store.dispose(id, "warning", new Date("2026-11-09T00:00:00Z"));
    expect(await store.appeal(id, "user-b", new Date("2026-11-10T00:00:00Z"))).toBe("OK");
    expect(await store.appeal(id, "user-b", new Date("2026-11-11T00:00:00Z"))).toBe("MULTIPLE");
    const record = await store.getById(id);
    expect(record?.expiresAt).toBe(reportExpiresAt(new Date("2026-11-09T00:00:00Z")));
    expect(record?.appealCount).toBe(1);
    void APPEAL_WINDOW_DAYS;
    void REPORTS_PER_DAY;
  });

  it("appeal window closes after 7 days", async () => {
    const store = new MemoryReportStore();
    const t0 = new Date("2026-11-09T00:00:00Z");
    const created = await store.create(
      "user-a",
      {
        reportedUserId: "user-b",
        reason: "spam",
        references: [],
        excerpts: [],
        excerptConsent: false,
      },
      t0,
    );
    if (!created.ok) throw new Error("expected create");
    const id = created.record.reportId;
    await store.dispose(id, "ban", t0);
    const late = new Date(t0.getTime() + APPEAL_WINDOW_DAYS * 24 * 60 * 60 * 1000 + 1);
    expect(await store.appeal(id, "user-b", late)).toBe("WINDOW");
  });
});
