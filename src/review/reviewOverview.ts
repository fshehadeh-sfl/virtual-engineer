import type { InlineReviewComment } from "../interfaces.js";
import { severityRank } from "./commentSeverity.js";

export interface ReviewOverviewFinding {
  comment: InlineReviewComment;
  status: "new" | "previous" | "uncertain";
  url?: string | undefined;
}

export interface ReviewOverviewInput {
  score: -1 | 0 | 1;
  summary: string;
  changeOverview: string;
  requiredAction?: string | undefined;
  commitSha?: string | undefined;
  kind?: "github" | "gitlab" | undefined;
  advisoryOnly?: boolean | undefined;
  reReview?: boolean | undefined;
  fixedCount?: number | undefined;
  findings: readonly ReviewOverviewFinding[];
}

function plainText(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function escapeMarkdown(value: string): string {
  return plainText(value).replace(/[\\`*_{}[\]()<>#!|]/g, "\\$&");
}

function findingTitle(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0] ?? "";
  return escapeMarkdown(firstLine.slice(0, 180));
}

function displayLocation(comment: InlineReviewComment): string {
  const file = plainText(comment.file).replace(/`/g, "'");
  return comment.line > 0 ? `${file}:${comment.line}` : file;
}

function findingSeverity(severity: string): { emoji: string; label: string; group: "blocking" | "warning" | "note" } {
  const rank = severityRank(severity);
  if (rank >= 3) return { emoji: "🔴", label: "Blocking", group: "blocking" };
  if (rank >= 2) return { emoji: "🟠", label: "Warning", group: "warning" };
  return { emoji: "🔵", label: "Note", group: "note" };
}

function markdownLink(title: string, url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported review comment URL protocol: ${parsed.protocol}`);
  }
  return `[${title}](${parsed.href.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
}

/** Render a provider-neutral review body from the findings actually published. */
export function renderReviewOverview(input: ReviewOverviewInput): string {
  const visible = input.findings.filter((finding) => finding.status !== "uncertain");
  const sorted = visible
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) =>
      severityRank(b.finding.comment.severity) - severityRank(a.finding.comment.severity) ||
      a.index - b.index
    )
    .map(({ finding }) => finding);
  const counts = { blocking: 0, warning: 0, note: 0 };
  for (const { comment } of visible) counts[findingSeverity(comment.severity).group]++;
  const countText = ([
    [counts.blocking, "blocking"],
    [counts.warning, "warning"],
    [counts.note, "note"],
  ] as const)
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}${count > 1 && label !== "blocking" ? "s" : ""}`)
    .join(" · ") || "none";

  const verdict = input.score < 0
    ? `🔴 **Changes required${input.advisoryOnly === true ? " (advisory — does not block merging)" : ""}**`
    : input.score > 0 ? "🟢 **Looks good**" : "🟡 **Changes recommended**";
  const sha = input.commitSha?.trim();
  const reviewedCommit = sha && /^[\da-f]{7,40}$/i.test(sha) ? ` · Reviewed commit: \`${sha.slice(0, 7)}\`` : "";
  const sections = [
    "## Virtual Engineer review overview",
    "",
    `${verdict}${reviewedCommit}`,
    "",
    escapeMarkdown(input.summary),
  ];

  const previouslyReported = visible.filter((finding) => finding.status === "previous").length;
  const newlyReported = visible.length - previouslyReported;
  if (input.reReview === true || previouslyReported > 0 || (input.fixedCount ?? 0) > 0) {
    const parts = [
      ...(newlyReported > 0 ? [`${newlyReported} newly reported finding${newlyReported === 1 ? "" : "s"}`] : []),
      ...(previouslyReported > 0
        ? [`${previouslyReported} previously reported finding${previouslyReported === 1 ? "" : "s"} still present`]
        : []),
      ...((input.fixedCount ?? 0) > 0
        ? [`${input.fixedCount} verified fix${input.fixedCount === 1 ? "" : "es"}`]
        : []),
    ];
    if (parts.length > 0) sections.push("", `**Since the last review:** ${parts.join(" · ")}`);
  }
  sections.push("", `**Findings:** ${countText}`);
  if (input.score < 0 && input.requiredAction?.trim()) {
    sections.push("", `**Before approval:** ${escapeMarkdown(input.requiredAction)}`);
  }

  sections.push("", "### Findings to address", "");
  if (sorted.length === 0) {
    sections.push("No findings to report.");
  } else {
    for (const [index, finding] of sorted.entries()) {
      const { emoji, label } = findingSeverity(finding.comment.severity);
      const title = `${findingTitle(finding.comment.message)} · \`${displayLocation(finding.comment)}\``;
      const subject = finding.url ? markdownLink(title, finding.url) : `\`${displayLocation(finding.comment)}\` — ${findingTitle(finding.comment.message)}`;
      const status = finding.status === "previous" ? "Previously reported" : "New";
      sections.push(`${index + 1}. ${emoji} **${label} · ${status}** — ${subject}`);
    }
  }

  const noun = input.kind === "gitlab" ? "merge request" : "PR";
  sections.push(
    "",
    `### What changed in this ${noun}`,
    "",
    escapeMarkdown(input.changeOverview),
    "",
    "---",
    "",
    "🤖 Reviewed by [Virtual Engineer](https://virtual-engineer.dev).",
  );
  return sections.join("\n");
}
