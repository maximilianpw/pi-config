import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

type RepoResolution = { ok: true; repo: string } | { ok: false; error: string };
type PullRequestResolution = { ok: true; number: number; repo: string } | { ok: false; error: string };

type GitHubUser = { login?: string | null } | null;

type PullRequestSummary = {
  number: number;
  title?: string;
  url?: string;
  author?: GitHubUser;
};

type IssueComment = {
  id: number;
  user: GitHubUser;
  body?: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
};

type Review = {
  id: number;
  user: GitHubUser;
  state: string;
  body?: string | null;
  submitted_at?: string | null;
  html_url?: string | null;
};

type ReviewComment = {
  id: number;
  user: GitHubUser;
  body?: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  diff_hunk?: string;
  in_reply_to_id?: number;
};

type NormalizedComment = {
  kind: "issue" | "review" | "review_comment";
  id: number;
  author: string;
  state?: string;
  path?: string;
  line?: number;
  inReplyToId?: number;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
  body: string;
};

const toolSchema = Type.Object({
  prNumber: Type.Optional(Type.Number({ description: "Pull request number. If omitted, uses the PR for the current git branch or jj bookmark." })),
  repo: Type.Optional(Type.String({ description: "GitHub repository in owner/name form. If omitted, inferred from git or jj git remotes." })),
  includeEmptyReviews: Type.Optional(Type.Boolean({ description: "Include approval/change-request review records even when the review body is empty. Defaults to false." })),
  maxComments: Type.Optional(Type.Number({ description: "Maximum number of normalized comments to return. Defaults to 200." })),
});

type ToolInput = Static<typeof toolSchema>;

function parseGitHubRepo(remoteUrl: string): string | undefined {
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  const httpsMatch = remoteUrl.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  return undefined;
}

async function resolveGitHubRepo(pi: ExtensionAPI, cwd: string, explicitRepo?: string): Promise<RepoResolution> {
  if (explicitRepo) return { ok: true, repo: explicitRepo };

  const gitResult = await pi.exec("git", ["remote", "-v"], { cwd, timeout: 5_000 });
  if (gitResult.code === 0) {
    for (const line of gitResult.stdout.split("\n")) {
      const remoteUrl = line.trim().split(/\s+/)[1];
      if (!remoteUrl) continue;
      const repo = parseGitHubRepo(remoteUrl);
      if (repo) return { ok: true, repo };
    }
  }

  const jjResult = await pi.exec("jj", ["git", "remote", "list"], { cwd, timeout: 5_000 });
  if (jjResult.code === 0) {
    for (const line of jjResult.stdout.split("\n")) {
      const remoteUrl = line.trim().split(/\s+/)[1];
      if (!remoteUrl) continue;
      const repo = parseGitHubRepo(remoteUrl);
      if (repo) return { ok: true, repo };
    }
  }

  return { ok: false, error: "could not infer a GitHub owner/name repo from git or jj remotes" };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

async function getJjBookmarkCandidates(pi: ExtensionAPI, cwd: string): Promise<string[]> {
  const result = await pi.exec("jj", ["log", "--no-graph", "-r", "@ | @-", "--template", 'bookmarks ++ "\\n"'], { cwd, timeout: 5_000 });
  if (result.code !== 0) return [];

  return unique(result.stdout.split(/\s+/).filter((bookmark) => bookmark !== ""));
}

async function getGitBranchCandidate(pi: ExtensionAPI, cwd: string): Promise<string[]> {
  const result = await pi.exec("git", ["branch", "--show-current"], { cwd, timeout: 5_000 });
  if (result.code !== 0) return [];
  return unique([result.stdout.trim()]);
}

async function ghPrNumber(pi: ExtensionAPI, cwd: string, repo: string, selector?: string): Promise<number | undefined> {
  const args = selector ? ["pr", "view", selector, "--repo", repo, "--json", "number"] : ["pr", "view", "--repo", repo, "--json", "number"];
  const result = await pi.exec("gh", args, { cwd, timeout: 10_000 });
  if (result.code !== 0) return undefined;

  try {
    const parsed = JSON.parse(result.stdout) as { number?: number };
    return typeof parsed.number === "number" ? parsed.number : undefined;
  } catch {
    return undefined;
  }
}

async function resolvePullRequest(pi: ExtensionAPI, cwd: string, params: ToolInput): Promise<PullRequestResolution> {
  const repo = await resolveGitHubRepo(pi, cwd, params.repo);
  if (!repo.ok) return repo;
  if (params.prNumber !== undefined) return { ok: true, repo: repo.repo, number: params.prNumber };

  const directNumber = await ghPrNumber(pi, cwd, repo.repo);
  if (directNumber !== undefined) return { ok: true, repo: repo.repo, number: directNumber };

  const candidates = unique([...(await getGitBranchCandidate(pi, cwd)), ...(await getJjBookmarkCandidates(pi, cwd))]);
  for (const candidate of candidates) {
    const number = await ghPrNumber(pi, cwd, repo.repo, candidate);
    if (number !== undefined) return { ok: true, repo: repo.repo, number };
  }

  return { ok: false, error: `failed to resolve PR from current git branch or jj bookmarks${candidates.length > 0 ? ` (${candidates.join(", ")})` : ""}; pass prNumber explicitly` };
}

async function ghJson<T>(pi: ExtensionAPI, cwd: string, args: string[]): Promise<T> {
  const result = await pi.exec("gh", args, { cwd, timeout: 20_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `gh exited ${result.code}`);
  return JSON.parse(result.stdout) as T;
}

async function ghPaginatedArray<T>(pi: ExtensionAPI, cwd: string, endpoint: string): Promise<T[]> {
  const pages = await ghJson<T[][]>(pi, cwd, ["api", "--paginate", "--slurp", endpoint]);
  return pages.flat();
}

function authorLogin(user: GitHubUser): string {
  return user?.login ?? "unknown";
}

function normalizeComments(issueComments: IssueComment[], reviews: Review[], reviewComments: ReviewComment[], includeEmptyReviews: boolean): NormalizedComment[] {
  const comments: NormalizedComment[] = [];

  for (const comment of issueComments) {
    comments.push({
      kind: "issue",
      id: comment.id,
      author: authorLogin(comment.user),
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      url: comment.html_url,
      body: comment.body ?? "",
    });
  }

  for (const review of reviews) {
    const body = review.body ?? "";
    if (!includeEmptyReviews && body.trim() === "") continue;
    comments.push({
      kind: "review",
      id: review.id,
      author: authorLogin(review.user),
      state: review.state,
      createdAt: review.submitted_at ?? undefined,
      url: review.html_url ?? undefined,
      body,
    });
  }

  for (const comment of reviewComments) {
    comments.push({
      kind: "review_comment",
      id: comment.id,
      author: authorLogin(comment.user),
      path: comment.path,
      line: comment.line ?? comment.original_line ?? undefined,
      inReplyToId: comment.in_reply_to_id,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      url: comment.html_url,
      body: comment.body ?? "",
    });
  }

  return comments.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) || a.id - b.id);
}

function formatComment(comment: NormalizedComment): string {
  const location = comment.path ? ` ${comment.path}${comment.line ? `:${comment.line}` : ""}` : "";
  const state = comment.state ? ` [${comment.state}]` : "";
  const reply = comment.inReplyToId ? ` (reply to ${comment.inReplyToId})` : "";
  return `- ${comment.kind}${state} #${comment.id}${location}${reply} by ${comment.author} at ${comment.createdAt ?? "unknown"}\n  ${comment.body.replace(/\n/g, "\n  ")}${comment.url ? `\n  ${comment.url}` : ""}`;
}

export default function githubPullRequestCommentsExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "github_pr_comments",
    label: "GitHub PR Comments",
    description: "Read GitHub pull request issue comments, reviews, and inline review comments using the GitHub CLI (`gh`).",
    promptSnippet: "Read comments from a GitHub pull request",
    promptGuidelines: [
      "Use github_pr_comments when the user asks to inspect, summarize, or respond to GitHub pull request comments or review feedback.",
      "github_pr_comments requires the GitHub CLI (`gh`) to be installed and authenticated.",
    ],
    parameters: toolSchema,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const pr = await resolvePullRequest(pi, ctx.cwd, params);
      if (!pr.ok) {
        return { content: [{ type: "text", text: `github_pr_comments: ${pr.error}` }], isError: true };
      }

      onUpdate?.({ content: [{ type: "text", text: `Loading comments for ${pr.repo}#${pr.number}...` }] });

      try {
        const [summary, issueComments, reviews, reviewComments] = await Promise.all([
          ghJson<PullRequestSummary>(pi, ctx.cwd, ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "number,title,url,author"]),
          ghPaginatedArray<IssueComment>(pi, ctx.cwd, `repos/${pr.repo}/issues/${pr.number}/comments?per_page=100`),
          ghPaginatedArray<Review>(pi, ctx.cwd, `repos/${pr.repo}/pulls/${pr.number}/reviews?per_page=100`),
          ghPaginatedArray<ReviewComment>(pi, ctx.cwd, `repos/${pr.repo}/pulls/${pr.number}/comments?per_page=100`),
        ]);

        const maxComments = params.maxComments ?? 200;
        const allComments = normalizeComments(issueComments, reviews, reviewComments, params.includeEmptyReviews ?? false);
        const comments = allComments.slice(0, maxComments);
        const truncated = allComments.length > comments.length;
        const header = `GitHub PR comments for ${pr.repo}#${summary.number}: ${summary.title ?? "(untitled)"}\n${summary.url ?? ""}\nAuthor: ${authorLogin(summary.author)}\nCounts: ${issueComments.length} issue comments, ${reviews.length} reviews, ${reviewComments.length} inline review comments${truncated ? `; showing first ${comments.length} of ${allComments.length}` : ""}`;
        const body = comments.length > 0 ? comments.map(formatComment).join("\n\n") : "No comments found.";

        return {
          content: [{ type: "text", text: `${header}\n\n${body}` }],
          details: { repo: pr.repo, prNumber: pr.number, summary, counts: { issueComments: issueComments.length, reviews: reviews.length, reviewComments: reviewComments.length }, comments, truncated },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `github_pr_comments failed: ${message}` }], isError: true };
      }
    },
  });
}
