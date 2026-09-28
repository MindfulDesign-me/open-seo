import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AUDIT_ISSUE_TYPES } from "@/shared/audit-issues";
import { getAuditIssuesTool, getAuditPagesTool } from "./site-audit-tools";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getLatestAuditForProject: vi.fn(),
  getIssuesForAudit: vi.fn(),
  getPagesForAudit: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  DurableObject: class {
    readonly ctx = null;
  },
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    getLatestAuditForProject: mocks.getLatestAuditForProject,
    getIssuesForAudit: mocks.getIssuesForAudit,
    getPagesForAudit: mocks.getPagesForAudit,
  },
}));

beforeEach(() => {
  mocks.getProjectForOrganization.mockResolvedValue({ id: "project_1" });
  mocks.getLatestAuditForProject.mockResolvedValue({
    id: "audit_1",
    startUrl: "https://example.com",
  });
});

const context = makeToolContext();
const howToFix = AUDIT_ISSUE_TYPES["missing-meta-description"].howToFix;

function issueRow(index: number, details?: Record<string, unknown>) {
  return {
    severity: "warning" as const,
    issueType: "missing-meta-description",
    pageUrl: `https://example.com/${index}`,
    detailsJson: details ? JSON.stringify(details) : null,
  };
}

function pageRow(
  index: number,
  overrides: { title?: string; metaDescription?: string } = {},
) {
  return {
    id: `page_${index}`,
    url: `https://example.com/${index}`,
    statusCode: 200,
    fetchClass: "ok" as const,
    redirectUrl: null,
    title: overrides.title ?? `Title ${index}`,
    metaDescription: overrides.metaDescription ?? "A short description.",
    wordCount: 400,
    isIndexable: true,
    crawlDepth: 1,
    inSitemap: true,
    internalLinkCount: 2,
    responseTimeMs: 120,
  };
}

describe("get_audit_issues and get_audit_pages limits", () => {
  it("defaults both limits to 50 and still allows 1000", () => {
    const issues = z.object(getAuditIssuesTool.config.inputSchema);
    const pages = z.object(getAuditPagesTool.config.inputSchema);
    expect(issues.parse({ projectId: "project_1" }).limit).toBe(50);
    expect(pages.parse({ projectId: "project_1" }).limit).toBe(50);
    expect(
      issues.safeParse({ projectId: "project_1", limit: 1000 }).success,
    ).toBe(true);
    expect(
      pages.safeParse({ projectId: "project_1", limit: 1001 }).success,
    ).toBe(false);
    expect(getAuditIssuesTool.config.description).toContain(
      "Do not call get_audit_issues and get_audit_pages in the same turn or in parallel",
    );
    expect(getAuditPagesTool.config.description).toContain("Workers Free");
  });

  it("keeps how_to_fix on a small issue page and caps the default at 50", async () => {
    mocks.getIssuesForAudit.mockResolvedValue(
      Array.from({ length: 60 }, (_, index) => issueRow(index)),
    );

    const result = await getAuditIssuesTool.handler(
      { projectId: "project_1" },
      context,
    );

    expect(result.structuredContent.issues).toHaveLength(50);
    expect(result.structuredContent.issues[0]).toMatchObject({
      howToFix,
      url: "https://example.com/0",
    });
    expect(result.structuredContent.summary[0]).not.toHaveProperty("howToFix");
    expect(textContent(result)).toContain("showing 50");
  });

  it("moves repeated how_to_fix onto the summary and shortens long details", async () => {
    const blob = "x".repeat(2000);
    mocks.getIssuesForAudit.mockResolvedValue(
      Array.from({ length: 20 }, (_, index) => issueRow(index, { blob })),
    );

    const result = await getAuditIssuesTool.handler(
      { projectId: "project_1", limit: 20 },
      context,
    );

    const encoded = JSON.stringify(result.structuredContent);
    expect(result.structuredContent.issues[0]).not.toHaveProperty("howToFix");
    expect(result.structuredContent.summary[0]).toMatchObject({ howToFix });
    expect(encoded.split(howToFix).length - 1).toBe(1);
    expect(encoded).toContain(`${"x".repeat(300)}…`);
    expect(encoded).not.toContain(blob);
  });

  it("shortens long page descriptions when the page is large", async () => {
    const longDescription = "d".repeat(500);
    mocks.getPagesForAudit.mockResolvedValue(
      Array.from({ length: 80 }, (_, index) =>
        pageRow(index, { metaDescription: longDescription }),
      ),
    );

    const shortened = await getAuditPagesTool.handler(
      { projectId: "project_1", limit: 80 },
      context,
    );
    const description = shortened.structuredContent.pages[0]?.metaDescription;
    expect(typeof description).toBe("string");
    expect(description?.endsWith("…")).toBe(true);
    expect(description?.length).toBeLessThan(longDescription.length);
    expect(shortened.structuredContent.pages[0]?.title).toBe("Title 0");
    expect(textContent(shortened)).toContain("shortened");
  });
});
