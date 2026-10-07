import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitLabMergeRequestReviewProvider } from "../../src/connectors/gitlabMergeRequestReviewProvider.js";
import type { ExternalChangeId, ReviewOverviewPublication, PublishedReviewFinding } from "../../src/interfaces.js";

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

const config = {
  baseUrl: "https://gitlab.example.com",
  projectId: 100,
  token: "glpat_test",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function pagedResponse(body: unknown, nextPage: number | null): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: nextPage !== null ? { "x-next-page": String(nextPage) } : {},
  });
}

function ownReviewers(reviewState: string | null): object {
  return { reviewers: { nodes: [
    { id: "gid://gitlab/User/7", mergeRequestInteraction: { reviewState: "REQUESTED_CHANGES" } },
    { id: "gid://gitlab/User/9", mergeRequestInteraction: { reviewState } },
  ] } };
}

const cid = "42" as unknown as ExternalChangeId;
const projectCid = "group/proj#42" as ExternalChangeId;

const MR_BODY = {
  iid: 42,
  state: "opened",
  title: "Add feature X",
  description: "Description here.",
  web_url: "https://gitlab.example.com/group/proj/-/merge_requests/42",
  target_branch: "main",
  source_branch: "feature-x",
  project_id: 100,
  author: { id: 7, username: "alice" },
  reviewers: [],
  references: { full: "group/proj!42" },
  diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
};

const CHANGES_BODY = {
  diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
  changes: [
    {
      old_path: "src/a.ts",
      new_path: "src/a.ts",
      new_file: false,
      renamed_file: false,
      deleted_file: false,
      diff: "@@ -1 +1,2 @@\n context\n+added line",
    },
  ],
};

function overviewPublication(): ReviewOverviewPublication {
  return {
    details: {
      changeId: projectCid,
      changeNumber: 42,
      subject: "Add feature X",
      description: "",
      ownerAccountId: "7",
      currentPatchset: 1,
      status: "OPEN",
      project: "group/proj",
      targetBranch: "main",
      url: MR_BODY.web_url,
      headSha: "head",
    },
    summary: "Overall summary",
    changeOverview: "Adds feature X",
    requiredAction: "Fix this bug",
    score: 0,
    comments: [],
    folded: [],
    previous: [],
    reReview: false,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("GitLabMergeRequestReviewProvider", () => {
  it("getChangeDetails maps an open MR to OPEN and resolves the project path", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(MR_BODY));
    const p = new GitLabMergeRequestReviewProvider(config);
    const r = await p.getChangeDetails(cid);
    expect(r.status).toBe("OPEN");
    expect(r.changeNumber).toBe(42);
    expect(r.targetBranch).toBe("main");
    expect(r.project).toBe("group/proj");
    expect(r.ownerAccountId).toBe("7");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.example.com/api/v4/projects/100/merge_requests/42",
      expect.objectContaining({ headers: expect.anything() })
    );
  });

  describe("reviewer assignment", () => {
    it("confirms VE is an assigned reviewer", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ ...MR_BODY, reviewers: [{ id: 9, username: "ve-bot" }] }))
        .mockResolvedValueOnce(jsonResponse({ id: 9, username: "ve-bot" }));

      await expect(new GitLabMergeRequestReviewProvider(config).isReviewer(cid)).resolves.toBe(true);
    });

    it("adds VE while preserving existing reviewer ids", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ ...MR_BODY, reviewers: [{ id: 11, username: "alice-reviewer" }] }))
        .mockResolvedValueOnce(jsonResponse({ id: 9, username: "ve-bot" }))
        .mockResolvedValueOnce(jsonResponse({}));

      await new GitLabMergeRequestReviewProvider(config).ensureReviewerAssignment(cid);

      expect(fetchMock).toHaveBeenLastCalledWith(
        "https://gitlab.example.com/api/v4/projects/100/merge_requests/42",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ reviewer_ids: [11, 9] }),
        }),
      );
    });
  });

  it("maps merged and closed MRs to MERGED / ABANDONED", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...MR_BODY, state: "merged" }));
    expect((await new GitLabMergeRequestReviewProvider(config).getChangeDetails(cid)).status).toBe("MERGED");
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...MR_BODY, state: "closed" }));
    expect((await new GitLabMergeRequestReviewProvider(config).getChangeDetails(cid)).status).toBe("ABANDONED");
  });

  it("getChangeDetails derives currentPatchset from the head SHA so updates re-review", async () => {
    const p = new GitLabMergeRequestReviewProvider(config);

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...MR_BODY, sha: "aaaaaaaaaaaaaaaa" }));
    const first = await p.getChangeDetails(cid);
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...MR_BODY, sha: "aaaaaaaaaaaaaaaa" }));
    const same = await p.getChangeDetails(cid);
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...MR_BODY, sha: "bbbbbbbbbbbbbbbb" }));
    const updated = await p.getChangeDetails(cid);

    // Same head SHA -> same patchset (dedup skips); new head SHA -> new patchset (re-review).
    expect(first.currentPatchset).toBe(same.currentPatchset);
    expect(updated.currentPatchset).not.toBe(first.currentPatchset);
  });

  it("parses a project-prefixed changeId", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(MR_BODY));
    const p = new GitLabMergeRequestReviewProvider(config);
    await p.getChangeDetails("group/proj#42" as unknown as ExternalChangeId);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.example.com/api/v4/projects/group%2Fproj/merge_requests/42",
      expect.anything()
    );
  });

  it("getChangeDiff maps the MR changes to review diff files", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(CHANGES_BODY));
    const p = new GitLabMergeRequestReviewProvider(config);
    const diff = await p.getChangeDiff(cid);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]?.path).toBe("src/a.ts");
    expect(diff.files[0]?.status).toBe("modified");
  });

  it("getChangeDiff echoes the requested patchset", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(CHANGES_BODY));
    const diff = await new GitLabMergeRequestReviewProvider(config).getChangeDiff(cid, 99);
    expect(diff.patchset).toBe(99);
  });

  it("postReviewWithComments posts inline discussions, a summary note, and approves on +1", async () => {
    // 1) changes, 2) discussion, 3) note, 4) project path, 5) own review state, 6) approve
    fetchMock
      .mockResolvedValueOnce(jsonResponse(CHANGES_BODY))
      .mockResolvedValueOnce(jsonResponse({ id: "d1" }))
      .mockResolvedValueOnce(jsonResponse({ id: 1 }))
      .mockResolvedValueOnce(jsonResponse({ path_with_namespace: "group/proj" }))
      .mockResolvedValueOnce(jsonResponse({ data: { currentUser: { id: "gid://gitlab/User/9" },
        project: { mergeRequest: ownReviewers("UNREVIEWED") } } }))
      .mockResolvedValueOnce(jsonResponse({}));

    const p = new GitLabMergeRequestReviewProvider(config);
    await p.postReviewWithComments(
      cid,
      1,
      [{ file: "src/a.ts", line: 2, message: "Bug here", severity: "error" }],
      "Looks good overall",
      1
    );

    const urls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(urls).toContain("https://gitlab.example.com/api/v4/projects/100/merge_requests/42/discussions");
    expect(urls).toContain("https://gitlab.example.com/api/v4/projects/100/merge_requests/42/notes");
    expect(urls).toContain("https://gitlab.example.com/api/v4/projects/100/merge_requests/42/approve");
  });

  it("posts a neutral review without changing MR approval", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 1 }))
      .mockResolvedValueOnce(jsonResponse({ path_with_namespace: "group/proj" }))
      .mockResolvedValueOnce(jsonResponse({ data: { currentUser: { id: "gid://gitlab/User/9" },
        project: { mergeRequest: ownReviewers("UNREVIEWED") } } }));

    await new GitLabMergeRequestReviewProvider(config).postReviewWithComments(
      cid,
      1,
      [],
      "Notes only",
      0
    );

    const urls = fetchMock.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(urls).toContain("https://gitlab.example.com/api/v4/projects/100/merge_requests/42/notes");
    expect(urls.some((url: string) => url.endsWith("/approve"))).toBe(false);
    expect(urls.some((url: string) => url.endsWith("/unapprove"))).toBe(false);
  });

  it("folds out-of-diff comments into the summary note instead of posting them inline", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(CHANGES_BODY)) // line 999 is not in the diff
      .mockResolvedValueOnce(jsonResponse({ id: 1 })); // summary note only

    const p = new GitLabMergeRequestReviewProvider(config);
    await p.postReviewComments(
      cid,
      1,
      [{ file: "src/a.ts", line: 999, message: "Out of range", severity: "warning" }],
      "Summary"
    );

    const calls = fetchMock.mock.calls;
    const discussionCalls = calls.filter((c: unknown[]) => String(c[0]).endsWith("/discussions"));
    expect(discussionCalls).toHaveLength(0);
    const noteCall = calls.find((c: unknown[]) => String(c[0]).endsWith("/notes"));
    expect(noteCall).toBeDefined();
    const body = JSON.parse((noteCall?.[1] as { body: string }).body) as { body: string };
    expect(body.body).toContain("Out of range");
  });

  it("folds file-level (line=0) comments into the summary note without a line suffix", async () => {
    // Only a file-level comment → no /changes fetch needed, just the summary note.
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 })); // summary note only

    const p = new GitLabMergeRequestReviewProvider(config);
    await p.postReviewComments(
      cid,
      1,
      [{ file: "src/a.ts", line: 0, message: "file-level concern", severity: "warning" }],
      "Summary"
    );

    const calls = fetchMock.mock.calls;
    const discussionCalls = calls.filter((c: unknown[]) => String(c[0]).endsWith("/discussions"));
    expect(discussionCalls).toHaveLength(0);
    const noteCall = calls.find((c: unknown[]) => String(c[0]).endsWith("/notes"));
    expect(noteCall).toBeDefined();
    const body = JSON.parse((noteCall?.[1] as { body: string }).body) as { body: string };
    expect(body.body).toContain("file-level concern");
    expect(body.body).toContain("`src/a.ts`");
    expect(body.body).not.toContain("`src/a.ts:0`");
  });

  it("vote(-1) requests changes through GraphQL and verifies its own reviewer state", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ path_with_namespace: "group/proj" }))
      .mockResolvedValueOnce(jsonResponse({
        data: { mergeRequestRequestChanges: {
          errors: [],
          mergeRequest: ownReviewers("REQUESTED_CHANGES"),
        } },
      }))
      .mockResolvedValueOnce(jsonResponse({ id: 9, username: "ve-bot" }));
    const p = new GitLabMergeRequestReviewProvider(config);
    await p.vote(cid, 1, -1);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://gitlab.example.com/api/graphql");
    expect(init).toEqual(expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer glpat_test" }),
    }));
    expect(JSON.parse(String(init.body))).toEqual({
      query: expect.stringContaining("mergeRequestRequestChanges"),
      variables: { input: { projectPath: "group/proj", iid: "42" } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("falls back to advisory REST unapprove on an unsupported mutation and exposes the outcome", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: "Field 'mergeRequestRequestChanges' doesn't exist on type 'Mutation'" }] }))
      .mockResolvedValueOnce(jsonResponse({}));
    const p = new GitLabMergeRequestReviewProvider(config);
    await expect(p.postReviewWithDecision("group/proj#42" as ExternalChangeId, 1, [], "", -1))
      .resolves.toBe("advisory_only");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.example.com/api/v4/projects/group%2Fproj/merge_requests/42/unapprove",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("falls back when GitLab explicitly rejects native request changes for the tier", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { mergeRequestRequestChanges: {
        errors: ["Requesting changes is not available on your subscription"], mergeRequest: null,
      } } }))
      .mockResolvedValueOnce(jsonResponse({}));
    await expect(new GitLabMergeRequestReviewProvider(config).postReviewWithDecision(
      "group/proj#42" as ExternalChangeId, 1, [], "", -1,
    )).resolves.toBe("advisory_only");
  });

  it("treats a missing GraphQL endpoint as advisory only", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, 404))
      .mockResolvedValueOnce(jsonResponse({}));
    await expect(new GitLabMergeRequestReviewProvider(config).postReviewWithDecision(
      "group/proj#42" as ExternalChangeId, 1, [], "", -1,
    )).resolves.toBe("advisory_only");
  });

  it.each([
    [401, { message: "Unauthorized" }],
    [403, { message: "Forbidden" }],
    [500, { message: "Internal Server Error" }],
    [200, { errors: [{ message: "Access denied" }] }],
    [200, { data: { mergeRequestRequestChanges: { errors: ["Permission denied"], mergeRequest: null } } }],
    [200, { data: { mergeRequestRequestChanges: { errors: [], mergeRequest: null } } }],
  ])("does not silently fall back on errors or unverified requests (HTTP %i)", async (status, body) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(body, status));
    await expect(new GitLabMergeRequestReviewProvider(config).vote(
      "group/proj#42" as ExternalChangeId, 1, -1,
    )).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not claim native success unless its own reviewer requests changes", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { mergeRequestRequestChanges: {
        errors: [], mergeRequest: ownReviewers("UNREVIEWED"),
      } } }))
      .mockResolvedValueOnce(jsonResponse({ id: 9, username: "ve-bot" }));
    await expect(new GitLabMergeRequestReviewProvider(config).vote(
      "group/proj#42" as ExternalChangeId, 1, -1,
    )).rejects.toThrow("did not confirm own REQUESTED_CHANGES");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("forwards abort signals and does not fall back on aborted requests", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal);
      controller.abort();
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    });
    await expect(new GitLabMergeRequestReviewProvider(config).vote(
      "group/proj#42" as ExternalChangeId, 1, -1, undefined, controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("removes an existing own changes request before a neutral decision", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { currentUser: { id: "gid://gitlab/User/9" },
        project: { mergeRequest: ownReviewers("REQUESTED_CHANGES") } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { mergeRequestDestroyRequestedChanges: {
        errors: [], mergeRequest: ownReviewers("UNREVIEWED"),
      } } }));
    await new GitLabMergeRequestReviewProvider(config).vote("group/proj#42" as ExternalChangeId, 1, 0);
    const body = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as { query: string };
    expect(body.query).toContain("mergeRequestDestroyRequestedChanges");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("removes an existing own changes request before approving", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { currentUser: { id: "gid://gitlab/User/9" },
        project: { mergeRequest: ownReviewers("REQUESTED_CHANGES") } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { mergeRequestDestroyRequestedChanges: {
        errors: [], mergeRequest: ownReviewers(null),
      } } }))
      .mockResolvedValueOnce(jsonResponse({}));
    await new GitLabMergeRequestReviewProvider(config).vote("group/proj#42" as ExternalChangeId, 1, 1);
    expect(fetchMock.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([
      "https://gitlab.example.com/api/graphql",
      "https://gitlab.example.com/api/graphql",
      "https://gitlab.example.com/api/v4/projects/group%2Fproj/merge_requests/42/approve",
    ]);
  });

  it("treats VE missing from the reviewer list as having no changes request to clear", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { currentUser: { id: "gid://gitlab/User/9" },
        project: { mergeRequest: { reviewers: { nodes: [] } } } } }))
      .mockResolvedValueOnce(jsonResponse({}));
    await new GitLabMergeRequestReviewProvider(config).vote("group/proj#42" as ExternalChangeId, 1, 1);
    expect(fetchMock.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([
      "https://gitlab.example.com/api/graphql",
      "https://gitlab.example.com/api/v4/projects/group%2Fproj/merge_requests/42/approve",
    ]);
  });

  it.each([
    ["unknown current user", { currentUser: null, project: { mergeRequest: { reviewers: { nodes: [] } } } }],
    ["inaccessible merge request", { currentUser: { id: "gid://gitlab/User/9" }, project: { mergeRequest: null } }],
  ])("does not approve when own reviewer state cannot be determined (%s)", async (_label, data) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data }));
    await expect(new GitLabMergeRequestReviewProvider(config).vote(
      "group/proj#42" as ExternalChangeId, 1, 1,
    )).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not approve when removing a previous changes request fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { currentUser: { id: "gid://gitlab/User/9" },
        project: { mergeRequest: ownReviewers("REQUESTED_CHANGES") } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { mergeRequestDestroyRequestedChanges: {
        errors: ["Permission denied"], mergeRequest: null,
      } } }));
    await expect(new GitLabMergeRequestReviewProvider(config).vote(
      "group/proj#42" as ExternalChangeId, 1, 1,
    )).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe("instances without native reviewer state", () => {
    const missingState = { errors: [{
      message: "Field 'reviewState' doesn't exist on type 'UserMergeRequestInteraction'",
    }] };
    const noNativeMutations = { errors: [
      { message: "Field 'mergeRequestRequestChanges' doesn't exist on type 'Mutation'" },
      { message: "Field 'mergeRequestDestroyRequestedChanges' doesn't exist on type 'Mutation'" },
    ] };

    it.each([0, 1])("allows decision %i when review-state and both native mutations are absent", async (score) => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(missingState))
        .mockResolvedValueOnce(jsonResponse(noNativeMutations))
        .mockResolvedValueOnce(jsonResponse({}));
      await new GitLabMergeRequestReviewProvider(config).vote(projectCid, 1, score);
      const [url, options] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(url).toBe("https://gitlab.example.com/api/graphql");
      const probe = JSON.parse(String(options.body)) as { query: string; variables: object };
      expect(probe.query).toContain("mergeRequestRequestChanges");
      expect(probe.query).toContain("mergeRequestDestroyRequestedChanges");
      expect(probe.query).not.toContain("input:");
      expect(probe.variables).toEqual({});
      expect(fetchMock).toHaveBeenCalledTimes(score === 1 ? 3 : 2);
      if (score === 1) {
        expect(fetchMock.mock.calls[2]?.[0]).toBe(`${config.baseUrl}/api/v4/projects/group%2Fproj/merge_requests/42/approve`);
      }
    });

    it("still publishes a hosted neutral overview on explicitly unsupported schema", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(MR_BODY))
        .mockResolvedValueOnce(jsonResponse(missingState))
        .mockResolvedValueOnce(jsonResponse(noNativeMutations))
        .mockResolvedValueOnce(jsonResponse({ id: 103 }));
      const result = await new GitLabMergeRequestReviewProvider(config).postReviewOverview(
        projectCid, 1, overviewPublication(),
      );
      expect(result.remoteId).toBe("103");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("recognizes the absent reviewer interaction field only when mutations are also absent", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ errors: [{
          message: 'Cannot query field "mergeRequestInteraction" on type "MergeRequestReviewer".',
        }] }))
        .mockResolvedValueOnce(jsonResponse(noNativeMutations));
      await new GitLabMergeRequestReviewProvider(config).vote(projectCid, 1, 0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
      { errors: [
        { message: "Field 'mergeRequestDestroyRequestedChanges' doesn't exist on type 'Mutation'" },
        { message: "Field 'mergeRequestRequestChanges' is missing required arguments: input" },
      ] },
      { errors: [
        { message: "Field 'mergeRequestRequestChanges' doesn't exist on type 'Mutation'" },
        { message: "Field 'mergeRequestDestroyRequestedChanges' is missing required arguments: input" },
      ] },
    ])("does not ignore an unconfirmed previous request if either native mutation exists", async (capabilities) => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(missingState))
        .mockResolvedValueOnce(jsonResponse(capabilities));
      await expect(new GitLabMergeRequestReviewProvider(config).vote(projectCid, 1, 1))
        .rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
      [{ errors: [{ message: "Access denied" }] }],
      [{ errors: [{ message: "Field 'reviewState' doesn't exist on type 'UserMergeRequestInteraction'" }, { message: "Permission denied" }] }],
      [{ errors: [{ message: "Field 'mergeRequestRequestChanges' doesn't exist on type 'Mutation'" }] }],
    ])("does not ignore authorization or incomplete schema responses (%o)", async (body) => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(missingState))
        .mockResolvedValueOnce(jsonResponse(body));
      await expect(new GitLabMergeRequestReviewProvider(config).vote(projectCid, 1, 1))
        .rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not skip native cleanup when the schema probe is temporarily unavailable", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(missingState))
        .mockResolvedValueOnce(jsonResponse({ message: "Service Unavailable" }, 503));
      await expect(new GitLabMergeRequestReviewProvider(config).vote(projectCid, 1, 1))
        .rejects.toThrow("503");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("forwards abort signals to the schema probe instead of proceeding to approval", async () => {
      const controller = new AbortController();
      fetchMock
        .mockResolvedValueOnce(jsonResponse(missingState))
        .mockImplementationOnce((_url: string, init: RequestInit) => {
          expect(init.signal).toBe(controller.signal);
          controller.abort();
          return Promise.reject(new DOMException("Aborted", "AbortError"));
        });
      await expect(new GitLabMergeRequestReviewProvider(config).vote(
        projectCid, 1, 1, undefined, controller.signal,
      )).rejects.toMatchObject({ name: "AbortError" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
      [403, { message: "Forbidden" }],
      [500, { message: "Service Unavailable" }],
      [200, { errors: [{ message: "Access denied" }] }],
    ])("does not skip a previous request check on HTTP %i query failures", async (status, body) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(body, status));
      await expect(new GitLabMergeRequestReviewProvider(config).vote(projectCid, 1, 1))
        .rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("linked review overview", () => {
    it("posts linked inline findings, preserves null previous URLs, and includes fixed count", async () => {
      const publication = overviewPublication();
      publication.comments = [{ file: "src/a.ts", line: 2, message: "New bug", severity: "error" }];
      publication.previous = [{ comment: { file: "src/old.ts", line: 0, message: "Old issue", severity: "warning" }, url: null }];
      publication.folded = [{ file: "src/b.ts", line: 0, message: "Folded issue", severity: "warning" }];
      publication.fixedCount = 2;
      publication.reReview = true;
      const events: string[] = [];
      publication.onFindingPosted = async (finding: PublishedReviewFinding) => {
        events.push(`finding:${finding.disposition}`);
      };
      publication.onPublicationCreated = async (remoteId: string) => {
        events.push(`overview:${remoteId}`);
      };
      fetchMock
        .mockResolvedValueOnce(jsonResponse(MR_BODY))
        .mockResolvedValueOnce(jsonResponse({ data: { currentUser: { id: "gid://gitlab/User/9" },
          project: { mergeRequest: ownReviewers("UNREVIEWED") } } }))
        .mockResolvedValueOnce(jsonResponse(CHANGES_BODY))
        .mockResolvedValueOnce(jsonResponse({ id: "discussion-1", notes: [{ id: 77 }] }))
        .mockResolvedValueOnce(jsonResponse({ id: 101 }));

      const result = await new GitLabMergeRequestReviewProvider(config).postReviewOverview(projectCid, 1, publication);
      expect(result).toEqual({
        remoteId: "101",
        advisoryOnly: false,
        findings: [
          {
            comment: publication.comments[0],
            url: `${MR_BODY.web_url}#note_77`,
            providerThreadId: "discussion-1",
            disposition: "inline",
          },
          {
            comment: publication.folded[0],
            url: null,
            providerThreadId: null,
            disposition: "folded",
          },
        ],
      });
      const noteCall = fetchMock.mock.calls.find((call: unknown[]) => String(call[0]).endsWith("/notes"));
      const noteBody = JSON.parse((noteCall?.[1] as { body: string }).body) as { body: string };
      expect(noteBody.body).toContain("2 verified fixes");
      expect(noteBody.body).toContain("Old issue");
      expect(noteBody.body).toContain("New bug");
      expect(noteBody.body).toContain(`${MR_BODY.web_url}#note_77`);
      expect(events).toEqual(["finding:inline", "overview:101", "finding:folded"]);
    });

    it("marks unsupported negative decisions advisory in the posted overview", async () => {
      const publication = { ...overviewPublication(), score: -1 as const };
      fetchMock
        .mockResolvedValueOnce(jsonResponse(MR_BODY))
        .mockResolvedValueOnce(jsonResponse({ errors: [{ message: "Field 'mergeRequestRequestChanges' doesn't exist on type 'Mutation'" }] }))
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({ id: 101 }));
      const result = await new GitLabMergeRequestReviewProvider(config).postReviewOverview(projectCid, 1, publication);
      expect(result.advisoryOnly).toBe(true);
      const noteCall = fetchMock.mock.calls.find((call: unknown[]) => String(call[0]).endsWith("/notes"));
      expect((noteCall?.[1] as { body: string }).body).toContain("advisory");
    });

    it("folds invalid inline locations and reports them only after the overview exists", async () => {
      const publication = overviewPublication();
      publication.comments = [{ file: "src/a.ts", line: 999, message: "Outside diff", severity: "error" }];
      const onFindingPosted = vi.fn();
      publication.onFindingPosted = onFindingPosted;
      fetchMock
        .mockResolvedValueOnce(jsonResponse(MR_BODY))
        .mockResolvedValueOnce(jsonResponse({ data: { currentUser: { id: "gid://gitlab/User/9" },
          project: { mergeRequest: ownReviewers("UNREVIEWED") } } }))
        .mockResolvedValueOnce(jsonResponse(CHANGES_BODY))
        .mockResolvedValueOnce(jsonResponse({ id: 101 }));
      const result = await new GitLabMergeRequestReviewProvider(config).postReviewOverview(projectCid, 1, publication);
      expect(result.findings).toEqual([{
        comment: publication.comments[0],
        url: null,
        providerThreadId: null,
        disposition: "folded",
      }]);
      expect(onFindingPosted).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls.some((call: unknown[]) => String(call[0]).endsWith("/discussions"))).toBe(false);
    });

    it("does not swallow finding callback failures or post an overview after them", async () => {
      const publication = overviewPublication();
      publication.comments = [{ file: "src/a.ts", line: 2, message: "Bug", severity: "error" }];
      publication.onFindingPosted = vi.fn().mockRejectedValue(new Error("failed to persist finding"));
      fetchMock
        .mockResolvedValueOnce(jsonResponse(MR_BODY))
        .mockResolvedValueOnce(jsonResponse({ data: { currentUser: { id: "gid://gitlab/User/9" },
          project: { mergeRequest: ownReviewers("UNREVIEWED") } } }))
        .mockResolvedValueOnce(jsonResponse(CHANGES_BODY))
        .mockResolvedValueOnce(jsonResponse({ id: "discussion-1", notes: [{ id: 77 }] }));
      await expect(new GitLabMergeRequestReviewProvider(config).postReviewOverview(projectCid, 1, publication))
        .rejects.toThrow("failed to persist finding");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("does not treat a transient inline publication failure as a folded finding", async () => {
      const publication = overviewPublication();
      publication.comments = [{ file: "src/a.ts", line: 2, message: "Bug", severity: "error" }];
      fetchMock
        .mockResolvedValueOnce(jsonResponse(MR_BODY))
        .mockResolvedValueOnce(jsonResponse({ data: { currentUser: { id: "gid://gitlab/User/9" },
          project: { mergeRequest: ownReviewers("UNREVIEWED") } } }))
        .mockResolvedValueOnce(jsonResponse(CHANGES_BODY))
        .mockResolvedValueOnce(jsonResponse({ message: "Server error" }, 500));
      await expect(new GitLabMergeRequestReviewProvider(config).postReviewOverview(projectCid, 1, publication))
        .rejects.toThrow("500");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it.each([
      ["a newer head", { ...MR_BODY, sha: "newer" }],
      ["a closed merge request", { ...MR_BODY, state: "closed" }],
    ])("rejects %s before applying any review effect", async (_label, mr) => {
      const publication = { ...overviewPublication(), score: -1 as const };
      publication.comments = [{ file: "src/a.ts", line: 2, message: "Bug", severity: "error" }];
      fetchMock.mockResolvedValueOnce(jsonResponse(mr));
      await expect(new GitLabMergeRequestReviewProvider(config).postReviewOverview(projectCid, 1, publication))
        .rejects.toThrow(/reviewed revision|no longer open/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects a publication without a reviewed head revision", async () => {
      const publication = overviewPublication();
      publication.details = { ...publication.details, headSha: undefined };
      await expect(new GitLabMergeRequestReviewProvider(config).postReviewOverview(projectCid, 1, publication))
        .rejects.toThrow(/reviewed revision/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not position inline findings against a diff for another head", async () => {
      const publication = overviewPublication();
      publication.comments = [{ file: "src/a.ts", line: 2, message: "Bug", severity: "error" }];
      fetchMock
        .mockResolvedValueOnce(jsonResponse(MR_BODY))
        .mockResolvedValueOnce(jsonResponse({ data: { currentUser: { id: "gid://gitlab/User/9" },
          project: { mergeRequest: ownReviewers("UNREVIEWED") } } }))
        .mockResolvedValueOnce(jsonResponse({ ...CHANGES_BODY, diff_refs: { ...CHANGES_BODY.diff_refs, head_sha: "newer" } }));
      await expect(new GitLabMergeRequestReviewProvider(config).postReviewOverview(projectCid, 1, publication))
        .rejects.toThrow(/reviewed revision/i);
      expect(fetchMock.mock.calls.some((call: unknown[]) => String(call[0]).endsWith("/discussions"))).toBe(false);
    });

    it("positions a renamed-file finding with its original old path", async () => {
      const publication = overviewPublication();
      publication.comments = [{ file: "src/new.ts", line: 2, message: "Bug", severity: "error" }];
      fetchMock
        .mockResolvedValueOnce(jsonResponse(MR_BODY))
        .mockResolvedValueOnce(jsonResponse({ data: { currentUser: { id: "gid://gitlab/User/9" },
          project: { mergeRequest: ownReviewers("UNREVIEWED") } } }))
        .mockResolvedValueOnce(jsonResponse({ ...CHANGES_BODY, changes: [{
          ...CHANGES_BODY.changes[0], old_path: "src/old.ts", new_path: "src/new.ts", renamed_file: true,
        }] }))
        .mockResolvedValueOnce(jsonResponse({ id: "discussion-1", notes: [{ id: 77 }] }))
        .mockResolvedValueOnce(jsonResponse({ id: 101 }));
      await new GitLabMergeRequestReviewProvider(config).postReviewOverview(projectCid, 1, publication);
      const call = fetchMock.mock.calls.find((entry: unknown[]) => String(entry[0]).endsWith("/discussions"));
      const body = JSON.parse(String((call?.[1] as RequestInit).body)) as { position: Record<string, unknown> };
      expect(body.position).toMatchObject({ old_path: "src/old.ts", new_path: "src/new.ts", new_line: 2 });
    });
  });

  it("legacy review discussions use the original path of a renamed file", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ...CHANGES_BODY, changes: [{
        ...CHANGES_BODY.changes[0], old_path: "src/old.ts", new_path: "src/new.ts", renamed_file: true,
      }] }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ data: { currentUser: { id: "gid://gitlab/User/9" },
        project: { mergeRequest: ownReviewers("UNREVIEWED") } } }));
    await new GitLabMergeRequestReviewProvider(config).postReviewWithComments(
      projectCid, 1, [{ file: "src/new.ts", line: 2, message: "Bug", severity: "error" }], "Summary", 0,
    );
    const call = fetchMock.mock.calls.find((entry: unknown[]) => String(entry[0]).endsWith("/discussions"));
    const body = JSON.parse(String((call?.[1] as RequestInit).body)) as { position: Record<string, unknown> };
    expect(body.position).toMatchObject({ old_path: "src/old.ts", new_path: "src/new.ts" });
  });

  describe("discussion threads", () => {
    it("getDiscussionThreads maps discussions, tags isOwn and resolved", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ id: 9, username: "ve-bot" })) // /api/v4/user
        .mockResolvedValueOnce(
          jsonResponse([
            {
              id: "disc-open",
              individual_note: false,
              notes: [
                {
                  id: 1,
                  body: "Why this approach?",
                  resolvable: true,
                  resolved: false,
                  author: { id: 7, username: "alice" },
                  position: { new_path: "src/a.ts", new_line: 12 },
                },
                {
                  id: 2,
                  body: "Because of X.",
                  resolvable: true,
                  resolved: false,
                  author: { id: 9, username: "ve-bot" },
                },
              ],
            },
            {
              id: "disc-resolved",
              individual_note: false,
              notes: [
                {
                  id: 3,
                  body: "nit",
                  resolvable: true,
                  resolved: true,
                  author: { id: 7, username: "alice" },
                },
              ],
            },
            {
              id: "disc-system",
              individual_note: false,
              notes: [{ id: 4, body: "changed the description", system: true }],
            },
          ])
        );

      const p = new GitLabMergeRequestReviewProvider(config);
      const threads = await p.getDiscussionThreads(cid);

      // The system-only discussion is dropped.
      expect(threads).toHaveLength(2);
      const open = threads.find((t) => t.threadId === "disc-open");
      expect(open?.resolved).toBe(false);
      expect(open?.file).toBe("src/a.ts");
      expect(open?.line).toBe(12);
      expect(open?.comments).toHaveLength(2);
      expect(open?.comments[0]).toEqual({
        author: "alice",
        message: "Why this approach?",
        isOwn: false,
      });
      expect(open?.comments[1]?.isOwn).toBe(true);
      const resolved = threads.find((t) => t.threadId === "disc-resolved");
      expect(resolved?.resolved).toBe(true);
    });

    it("postThreadReply POSTs a note to the discussion", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 99 }));
      const p = new GitLabMergeRequestReviewProvider(config);
      await p.postThreadReply(cid, 1, "disc-open", "Thanks, addressed.");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://gitlab.example.com/api/v4/projects/100/merge_requests/42/discussions/disc-open/notes",
        expect.objectContaining({ method: "POST" })
      );
      const body = JSON.parse(
        (fetchMock.mock.calls[0]?.[1] as { body: string }).body
      ) as { body: string };
      expect(body.body).toBe("Thanks, addressed.");
    });
  });

  describe("hasReviewedCurrentPatchset", () => {
    it("returns true when VE posted a note at/after the latest commit date", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ id: 9, username: "ve-bot" })) // /api/v4/user
        .mockResolvedValueOnce(jsonResponse([
          { committed_date: "2026-01-01T10:00:00Z" },
          { committed_date: "2026-01-02T10:00:00Z" },
        ])) // /commits
        .mockResolvedValueOnce(jsonResponse([
          { system: false, created_at: "2026-01-02T11:00:00Z", author: { username: "ve-bot" } },
          { system: false, created_at: "2026-01-01T09:00:00Z", author: { username: "alice" } },
        ])); // /notes
      expect(await new GitLabMergeRequestReviewProvider(config).hasReviewedCurrentPatchset(cid)).toBe(true);
    });

    it("returns false when VE's only note predates the latest commit (new push)", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ id: 9, username: "ve-bot" }))
        .mockResolvedValueOnce(jsonResponse([{ committed_date: "2026-01-03T10:00:00Z" }]))
        .mockResolvedValueOnce(jsonResponse([
          { system: false, created_at: "2026-01-02T10:00:00Z", author: { username: "ve-bot" } },
        ]));
      expect(await new GitLabMergeRequestReviewProvider(config).hasReviewedCurrentPatchset(cid)).toBe(false);
    });

    it("ignores system notes and notes from other users", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ id: 9, username: "ve-bot" }))
        .mockResolvedValueOnce(jsonResponse([{ committed_date: "2026-01-01T10:00:00Z" }]))
        .mockResolvedValueOnce(jsonResponse([
          { system: true, created_at: "2026-01-02T10:00:00Z", author: { username: "ve-bot" } },
          { system: false, created_at: "2026-01-02T10:00:00Z", author: { username: "alice" } },
        ]));
      expect(await new GitLabMergeRequestReviewProvider(config).hasReviewedCurrentPatchset(cid)).toBe(false);
    });

    it("paginates notes to find VE's review on a later page", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ id: 9, username: "ve-bot" }))
        .mockResolvedValueOnce(jsonResponse([{ committed_date: "2026-01-01T10:00:00Z" }]))
        .mockResolvedValueOnce(pagedResponse(
          [{ system: false, created_at: "2026-01-03T10:00:00Z", author: { username: "alice" } }],
          2,
        )) // page 1: newer than commit, but not VE
        .mockResolvedValueOnce(pagedResponse(
          [{ system: false, created_at: "2026-01-02T10:00:00Z", author: { username: "ve-bot" } }],
          null,
        )); // page 2: VE note at/after commit
      expect(await new GitLabMergeRequestReviewProvider(config).hasReviewedCurrentPatchset(cid)).toBe(true);
    });

    it("stops paginating once notes predate the latest commit", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ id: 9, username: "ve-bot" }))
        .mockResolvedValueOnce(jsonResponse([{ committed_date: "2026-01-05T10:00:00Z" }]))
        .mockResolvedValueOnce(pagedResponse(
          [{ system: false, created_at: "2026-01-01T10:00:00Z", author: { username: "ve-bot" } }],
          2,
        )); // page 1 has an older VE note -> short-circuit, page 2 never fetched
      expect(await new GitLabMergeRequestReviewProvider(config).hasReviewedCurrentPatchset(cid)).toBe(false);
      // Only user + commits + one notes page = 3 fetch calls (no second notes page).
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});
