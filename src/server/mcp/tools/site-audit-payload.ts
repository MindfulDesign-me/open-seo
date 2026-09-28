import { sort } from "remeda";
import {
  getIssueDescriptor,
  ISSUE_SEVERITY_ORDER,
  type IssueSeverity,
} from "@/shared/audit-issues";

// get_audit_issues defaulted to 200 rows, each repeating how_to_fix, and
// get_audit_pages defaulted to 100. Those payloads have exhausted the
// self-host Worker on the Free plan (HTTP 503 / Error 1102). 1000 stays
// allowed for one call. Past this budget, repeated how_to_fix moves to the
// summary and long strings are shortened.
const AUDIT_STRUCTURED_BUDGET_CHARS = 24_000;
const AUDIT_DETAIL_STRING_MAX = 300;
const AUDIT_DETAIL_ARRAY_MAX = 5;
const AUDIT_PAGE_TEXT_MAX = 160;

export const AUDIT_READ_DEFAULT_LIMIT = 50;
export const AUDIT_READ_MAX_LIMIT = 1_000;

export const AUDIT_WORKERS_FREE_GUIDANCE =
  "Prefer a limit of 50. Larger pages are expensive on Cloudflare Workers Free and can exhaust CPU or the 128MB isolate (HTTP 503 / Error 1102). Do not call get_audit_issues and get_audit_pages in the same turn or in parallel — run one, then the other.";

export type AuditIssueSourceRow = {
  severity: IssueSeverity;
  issueType: string;
  pageUrl: string;
  detailsJson: string | null;
};

type PageText = {
  url: string;
  title: string | null;
  metaDescription: string | null;
};

function previewText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max).trimEnd()}…`;
}

function trimAuditDetails(details: unknown): unknown {
  if (typeof details === "string") {
    return previewText(details, AUDIT_DETAIL_STRING_MAX);
  }
  if (Array.isArray(details)) {
    return details
      .slice(0, AUDIT_DETAIL_ARRAY_MAX)
      .map((item) => trimAuditDetails(item));
  }
  if (typeof details === "object" && details !== null) {
    const trimmed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details)) {
      trimmed[key] = trimAuditDetails(value);
    }
    return trimmed;
  }
  return details;
}

function issuesAreOversized(rows: AuditIssueSourceRow[]): boolean {
  let chars = 0;
  for (const row of rows) {
    chars += row.pageUrl.length;
    chars += row.detailsJson?.length ?? 0;
    chars += getIssueDescriptor(row.issueType)?.howToFix.length ?? 0;
    if (chars > AUDIT_STRUCTURED_BUDGET_CHARS) return true;
  }
  return false;
}

export function buildAuditIssueContent(
  rows: AuditIssueSourceRow[],
  limit: number,
) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.issueType, (counts.get(row.issueType) ?? 0) + 1);
  }
  const summary = sort(
    Array.from(counts.entries()).map(([issueType, count]) => {
      const descriptor = getIssueDescriptor(issueType);
      return {
        issueType,
        title: descriptor?.title ?? issueType,
        severity: descriptor?.severity ?? "info",
        count,
      };
    }),
    (a, b) =>
      ISSUE_SEVERITY_ORDER[a.severity] - ISSUE_SEVERITY_ORDER[b.severity] ||
      b.count - a.count,
  );

  const returned = rows.slice(0, limit);
  const trimmed = issuesAreOversized(returned);
  const issues = returned.map((row) => {
    const descriptor = getIssueDescriptor(row.issueType);
    const details = row.detailsJson
      ? (JSON.parse(row.detailsJson) as unknown)
      : null;
    return {
      severity: row.severity,
      issueType: row.issueType,
      title: descriptor?.title ?? row.issueType,
      url: row.pageUrl,
      details: trimmed ? trimAuditDetails(details) : details,
      ...(trimmed ? {} : { howToFix: descriptor?.howToFix ?? null }),
    };
  });

  return {
    summary: trimmed
      ? summary.map((entry) => ({
          ...entry,
          howToFix: getIssueDescriptor(entry.issueType)?.howToFix ?? null,
        }))
      : summary,
    issues,
    trimmed,
  };
}

function pagesAreOversized(pages: PageText[]): boolean {
  let chars = 0;
  for (const page of pages) {
    chars += page.url.length;
    chars += page.title?.length ?? 0;
    chars += page.metaDescription?.length ?? 0;
    if (chars > AUDIT_STRUCTURED_BUDGET_CHARS) return true;
  }
  return false;
}

export function trimAuditPages<T extends PageText>(
  pages: T[],
): {
  pages: T[];
  trimmed: boolean;
} {
  if (!pagesAreOversized(pages)) return { pages, trimmed: false };
  let trimmed = false;
  const shortened = pages.map((page) => {
    const title =
      page.title == null ? null : previewText(page.title, AUDIT_PAGE_TEXT_MAX);
    const metaDescription =
      page.metaDescription == null
        ? null
        : previewText(page.metaDescription, AUDIT_PAGE_TEXT_MAX);
    if (title !== page.title || metaDescription !== page.metaDescription) {
      trimmed = true;
    }
    return { ...page, title, metaDescription };
  });
  return { pages: shortened, trimmed };
}
