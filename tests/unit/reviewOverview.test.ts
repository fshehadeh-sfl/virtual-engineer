import { describe, expect, it } from "vitest";
import { renderReviewOverview } from "../../src/review/reviewOverview.js";
import type { InlineReviewComment } from "../../src/interfaces.js";

const blocking: InlineReviewComment = {
  file: "src/payments/validate.ts",
  line: 42,
  message: "Negative amounts are accepted by the validator.",
  severity: "error",
};

describe("renderReviewOverview", () => {
  it("renders a linked, blocking review without repeating the change title", () => {
    const body = renderReviewOverview({
      score: -1,
      summary: "Negative amounts still pass validation.",
      changeOverview: "Adds amount validation and updates error responses.",
      requiredAction: "Reject negative amounts before approval.",
      commitSha: "abcdef0123456789",
      findings: [
        {
          comment: blocking,
          url: "https://github.com/acme/billing/pull/42#discussion_r123",
          status: "new",
        },
        {
          comment: { file: "src/payments/handler.ts", line: 0, message: "Handle network failures.", severity: "warning" },
          status: "new",
        },
      ],
    });

    expect(body).toContain("## Virtual Engineer review overview");
    expect(body).toContain("🔴 **Changes required** · Reviewed commit: `abcdef0`");
    expect(body).toContain("**Findings:** 1 blocking · 1 warning");
    expect(body).toContain("**Before approval:** Reject negative amounts before approval.");
    expect(body).toContain("[Negative amounts are accepted by the validator. · `src/payments/validate.ts:42`](https://github.com/acme/billing/pull/42#discussion_r123)");
    expect(body).toContain("`src/payments/handler.ts` — Handle network failures.");
    expect(body).toContain("### What changed in this PR");
    expect(body).toContain("🤖 Reviewed by [Virtual Engineer](https://virtual-engineer.dev).");
    expect(body).not.toContain("PR title:");
    expect(body).not.toContain("handler.ts:0");
  });

  it("labels a GitLab fallback advisory without claiming to block merging", () => {
    const body = renderReviewOverview({
      score: -1,
      summary: "Review feedback.",
      changeOverview: "Updates payment checks.",
      requiredAction: "Fix the validation.",
      advisoryOnly: true,
      findings: [],
    });
    expect(body).toContain("Changes required (advisory — does not block merging)");
    expect(body).not.toContain("Reviewed commit:");
  });

  it("renders the approved and neutral verdicts without a blocking action", () => {
    const common = { summary: "All checks passed.", changeOverview: "Adds tests.", findings: [] };
    expect(renderReviewOverview({ ...common, score: 1 })).toContain("🟢 **Looks good**");
    expect(renderReviewOverview({ ...common, score: 0 })).toContain("🟡 **Changes recommended**");
    expect(renderReviewOverview({ ...common, score: 1 })).not.toContain("Before approval");
  });

  it("only calls a previous finding still present when explicitly verified", () => {
    const body = renderReviewOverview({
      score: -1,
      summary: "Still needs work.",
      changeOverview: "Updates validation.",
      requiredAction: "Fix the validation.",
      fixedCount: 1,
      findings: [
        { comment: blocking, status: "previous", url: "https://github.com/acme/billing/pull/42#discussion_r123" },
        { comment: { ...blocking, message: "Unknown previous issue." }, status: "uncertain" },
      ],
    });
    expect(body).toContain("**Since the last review:** No new findings · 1 previously reported finding still present");
    expect(body).toContain("1 verified fix");
    expect(body).toContain("**Blocking · Previously reported**");
    expect(body).not.toContain("Unknown previous issue.");
  });

  it("states that a re-review found nothing new while keeping still-open findings listed", () => {
    const body = renderReviewOverview({
      score: -1,
      summary: "The earlier issue is still open.",
      changeOverview: "Updates validation.",
      requiredAction: "Fix the validation.",
      reReview: true,
      findings: [
        { comment: blocking, status: "previous", url: "https://github.com/acme/billing/pull/42#discussion_r123" },
      ],
    });
    expect(body).toContain("**Since the last review:** No new findings · 1 previously reported finding still present");
    expect(body).toContain("**Blocking · Previously reported**");
    expect(body).toContain("(https://github.com/acme/billing/pull/42#discussion_r123)");
  });

  it("states that a clean re-review found nothing new", () => {
    const body = renderReviewOverview({
      score: 1,
      summary: "Nothing else to flag.",
      changeOverview: "Updates validation.",
      reReview: true,
      findings: [],
    });
    expect(body).toContain("🟢 **Looks good**");
    expect(body).toContain("**Since the last review:** No new findings");
    expect(body).toContain("No findings to report.");
  });

  it("keeps untrusted provider URLs and paths inside the finding link", () => {
    const body = renderReviewOverview({
      score: -1,
      summary: "A regression",
      changeOverview: "Updates input handling",
      requiredAction: "Fix the regression",
      findings: [{
        status: "new",
        comment: {
          file: "src/a.ts\nInjected heading",
          line: 4,
          message: "Validate input",
          severity: "error",
        },
        url: "https://example.test/discussion/1\n#malicious",
      }],
    });
    expect(body).not.toContain("\nInjected heading");
    expect(body).not.toContain("\n#malicious");
    expect(body).toContain("https://example.test/discussion/1#malicious");
  });
});
