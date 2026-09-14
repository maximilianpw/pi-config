import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
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

export type NormalizedComment = {
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

const DEFAULT_MAX_COMMENTS = 200;
const MAX_MAX_COMMENTS = 500;
const MAX_COMMENT_BODY_CHARS = 16 * 1024;
const MAX_OUTPUT_CHARS = 40 * 1024;
const GITHUB_REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

const toolSchema = Type.Object({
  prNumber: Type.Optional(Type.Integer({ minimum: 1, description: "Pull request number. If omitted, uses the PR for the current git branch or jj bookmark." })),
  repo: Type.Optional(Type.String({ minLength: 3, description: "GitHub repository in owner/name form. If omitted, inferred from git or jj git remotes." })),
  includeEmptyReviews: Type.Optional(Type.Boolean({ description: "Include approval/change-request review records even when the review body is empty. Defaults to false." })),
  maxComments: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_MAX_COMMENTS, description: `Maximum number of the newest normalized comments to return. Defaults to ${DEFAULT_MAX_COMMENTS}; maximum ${MAX_MAX_COMMENTS}.` })),
});

type ToolInput = Static<typeof toolSchema>;

export function parseOwnerNameRepo(value: string): string | undefined {
  const repo = value.trim();
  return GITHUB_REPO_PATTERN.test(repo) ? repo : undefined;
}

export function parseGitHubRepo(remoteUrl: string): string | undefined {
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (sshMatch) return parseOwnerNameRepo(sshMatch[1]);

  const urlMatch = remoteUrl.match(/^(?:https?|ssh):\/\/(?:git@)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (urlMatch) return parseOwnerNameRepo(urlMatch[1]);

  return undefined;
}

async function resolveGitHubRepo(pi: ExtensionAPI, cwd: string, explicitRepo?: string, signal?: AbortSignal): Promise<RepoResolution> {
  if (explicitRepo) {
    const repo = parseOwnerNameRepo(explicitRepo);
    return repo
      ? { ok: true, repo }
      : { ok: false, error: `invalid GitHub repo "${explicitRepo}"; expected owner/name` };
  }

  const gitResult = await pi.exec("git", ["remote", "-v"], { cwd, signal, timeout: 5_000 });
  if (gitResult.code === 0) {
    for (const line of gitResult.stdout.split("\n")) {
      const remoteUrl = line.trim().split(/\s+/)[1];
      if (!remoteUrl) continue;
      const repo = parseGitHubRepo(remoteUrl);
      if (repo) return { ok: true, repo };
    }
  }

  const jjResult = await pi.exec("jj", ["git", "remote", "list"], { cwd, signal, timeout: 5_000 });
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

async function getJjBookmarkCandidates(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string[]> {
  const result = await pi.exec("jj", ["log", "--no-graph", "-r", "@ | @-", "--template", 'bookmarks ++ "\\n"'], { cwd, signal, timeout: 5_000 });
  if (result.code !== 0) return [];

  return unique(result.stdout.split(/\s+/).filter((bookmark) => bookmark !== ""));
}

async function getGitBranchCandidate(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string[]> {
  const result = await pi.exec("git", ["branch", "--show-current"], { cwd, signal, timeout: 5_000 });
  if (result.code !== 0) return [];
  return unique([result.stdout.trim()]);
}

async function ghPrNumber(pi: ExtensionAPI, cwd: string, repo: string, selector?: string, signal?: AbortSignal): Promise<number | undefined> {
  const args = selector ? ["pr", "view", selector, "--repo", repo, "--json", "number"] : ["pr", "view", "--repo", repo, "--json", "number"];
  const result = await pi.exec("gh", args, { cwd, signal, timeout: 10_000 });
  if (result.code !== 0) return undefined;

  try {
    const parsed = JSON.parse(result.stdout) as { number?: number };
    return typeof parsed.number === "number" ? parsed.number : undefined;
  } catch {
    return undefined;
  }
}

async function resolvePullRequest(pi: ExtensionAPI, cwd: string, params: ToolInput, signal?: AbortSignal): Promise<PullRequestResolution> {
  const repo = await resolveGitHubRepo(pi, cwd, params.repo, signal);
  if (!repo.ok) return repo;
  if (params.prNumber !== undefined) return { ok: true, repo: repo.repo, number: params.prNumber };

  const directNumber = await ghPrNumber(pi, cwd, repo.repo, undefined, signal);
  if (directNumber !== undefined) return { ok: true, repo: repo.repo, number: directNumber };

  const candidates = unique([...(await getGitBranchCandidate(pi, cwd, signal)), ...(await getJjBookmarkCandidates(pi, cwd, signal))]);
  for (const candidate of candidates) {
    const number = await ghPrNumber(pi, cwd, repo.repo, candidate, signal);
    if (number !== undefined) return { ok: true, repo: repo.repo, number };
  }

  return { ok: false, error: `failed to resolve PR from current git branch or jj bookmarks${candidates.length > 0 ? ` (${candidates.join(", ")})` : ""}; pass prNumber explicitly` };
}

async function ghJson<T>(pi: ExtensionAPI, cwd: string, args: string[], signal?: AbortSignal): Promise<T> {
  const result = await pi.exec("gh", args, { cwd, signal, timeout: 20_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `gh exited ${result.code}`);
  return JSON.parse(result.stdout) as T;
}

async function ghPaginatedArray<T>(pi: ExtensionAPI, cwd: string, endpoint: string, signal?: AbortSignal): Promise<T[]> {
  const pages = await ghJson<T[][]>(pi, cwd, ["api", "--paginate", "--slurp", endpoint], signal);
  return pages.flat();
}

function authorLogin(user: GitHubUser | undefined): string {
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

function truncateBody(body: string, maxChars: number): { body: string; truncated: boolean } {
  if (body.length <= maxChars) return { body, truncated: false };
  return {
    body: `${body.slice(0, Math.max(0, maxChars - 20))}\n… [body truncated]`,
    truncated: true,
  };
}

function formatComment(comment: NormalizedComment): string {
  const location = comment.path ? ` ${comment.path}${comment.line ? `:${comment.line}` : ""}` : "";
  const state = comment.state ? ` [${comment.state}]` : "";
  const reply = comment.inReplyToId ? ` (reply to ${comment.inReplyToId})` : "";
  return `- ${comment.kind}${state} #${comment.id}${location}${reply} by ${comment.author} at ${comment.createdAt ?? "unknown"}\n  ${comment.body.replace(/\n/g, "\n  ")}${comment.url ? `\n  ${comment.url}` : ""}`;
}

export type CommentSelection = {
  comments: NormalizedComment[];
  text: string;
  omittedByCount: number;
  omittedBySize: number;
  truncatedBodies: number;
};

export function selectCommentsForOutput(
  allComments: NormalizedComment[],
  maxComments: number,
  limits: { maxBodyChars?: number; maxOutputChars?: number } = {},
): CommentSelection {
  const maxBodyChars = limits.maxBodyChars ?? MAX_COMMENT_BODY_CHARS;
  const maxOutputChars = limits.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const countLimited = allComments.slice(-maxComments);
  const candidates = countLimited.map((comment) => {
    const body = truncateBody(comment.body, maxBodyChars);
    const bounded = { ...comment, body: body.body };
    return { comment: bounded, formatted: formatComment(bounded), bodyTruncated: body.truncated };
  });

  const selected: typeof candidates = [];
  let outputChars = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (!candidate) continue;
    const separatorChars = selected.length === 0 ? 0 : 2;
    if (outputChars + separatorChars + candidate.formatted.length > maxOutputChars) break;
    selected.push(candidate);
    outputChars += separatorChars + candidate.formatted.length;
  }
  selected.reverse();

  return {
    comments: selected.map(({ comment }) => comment),
    text: selected.map(({ formatted }) => formatted).join("\n\n"),
    omittedByCount: allComments.length - countLimited.length,
    omittedBySize: countLimited.length - selected.length,
    truncatedBodies: selected.filter(({ bodyTruncated }) => bodyTruncated).length,
  };
}

export default function githubPullRequestCommentsExtension(pi: ExtensionAPI): void {
  const tempDirectories = new Set<string>();

  async function boundedOutput(output: string, fullOutput: string, preserveFull: boolean): Promise<string> {
    const truncation = truncateHead(output, {
      maxBytes: DEFAULT_MAX_BYTES - 1024,
      maxLines: DEFAULT_MAX_LINES - 2,
    });
    if (!truncation.truncated && !preserveFull) return truncation.content;

    const directory = await mkdtemp(join(tmpdir(), "pi-github-pr-comments-"));
    const file = join(directory, "comments.txt");
    tempDirectories.add(directory);
    await writeFile(file, fullOutput, { encoding: "utf8", mode: 0o600 });
    const reason = truncation.truncated
      ? `Output truncated to ${truncation.outputLines} lines / ${formatSize(truncation.outputBytes)}`
      : "Some comments or bodies were omitted from the tool result";
    return `${truncation.content}\n\n[${reason}. Full output saved to: ${file}]`;
  }

  pi.registerTool({
    name: "github_pr_comments",
    label: "GitHub PR Comments",
    description: "Read GitHub pull request issue comments, reviews, and inline review comments using the GitHub CLI (`gh`). Returns the newest comments within a 50KB output limit and saves full output to a temporary file when truncated.",
    promptSnippet: "Read comments from a GitHub pull request",
    promptGuidelines: [
      "Use github_pr_comments when the user asks to inspect, summarize, or respond to GitHub pull request comments or review feedback.",
      "github_pr_comments requires the GitHub CLI (`gh`) to be installed and authenticated.",
    ],
    parameters: toolSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const pr = await resolvePullRequest(pi, ctx.cwd, params, signal);
      if (!pr.ok) throw new Error(`github_pr_comments: ${pr.error}`);

      onUpdate?.({ content: [{ type: "text", text: `Loading comments for ${pr.repo}#${pr.number}...` }], details: {} });

      try {
        const [summary, issueComments, reviews, reviewComments] = await Promise.all([
          ghJson<PullRequestSummary>(pi, ctx.cwd, ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "number,title,url,author"], signal),
          ghPaginatedArray<IssueComment>(pi, ctx.cwd, `repos/${pr.repo}/issues/${pr.number}/comments?per_page=100`, signal),
          ghPaginatedArray<Review>(pi, ctx.cwd, `repos/${pr.repo}/pulls/${pr.number}/reviews?per_page=100`, signal),
          ghPaginatedArray<ReviewComment>(pi, ctx.cwd, `repos/${pr.repo}/pulls/${pr.number}/comments?per_page=100`, signal),
        ]);

        const maxComments = params.maxComments ?? DEFAULT_MAX_COMMENTS;
        const allComments = normalizeComments(issueComments, reviews, reviewComments, params.includeEmptyReviews ?? false);
        const selection = selectCommentsForOutput(allComments, maxComments);
        const omitted = selection.omittedByCount + selection.omittedBySize;
        const truncation = [
          omitted > 0 ? `showing latest ${selection.comments.length} of ${allComments.length}` : undefined,
          selection.truncatedBodies > 0 ? `${selection.truncatedBodies} comment bodies truncated` : undefined,
        ].filter((value): value is string => value !== undefined);
        const baseHeader = `GitHub PR comments for ${pr.repo}#${summary.number}: ${summary.title ?? "(untitled)"}\n${summary.url ?? ""}\nAuthor: ${authorLogin(summary.author)}\nCounts: ${issueComments.length} issue comments, ${reviews.length} reviews, ${reviewComments.length} inline review comments`;
        const header = `${baseHeader}${truncation.length > 0 ? `; ${truncation.join("; ")}` : ""}`;
        const body = selection.comments.length > 0
          ? selection.text
          : allComments.length > 0
            ? "Comments were found, but none fit the output budget."
            : "No comments found.";
        const truncated = omitted > 0 || selection.truncatedBodies > 0;
        const fullBody = allComments.length > 0 ? allComments.map(formatComment).join("\n\n") : "No comments found.";
        const text = await boundedOutput(`${header}\n\n${body}`, `${baseHeader}\n\n${fullBody}`, truncated);

        return {
          content: [{ type: "text", text }],
          details: {
            repo: pr.repo,
            prNumber: pr.number,
            summary,
            counts: { issueComments: issueComments.length, reviews: reviews.length, reviewComments: reviewComments.length },
            comments: selection.comments,
            truncated,
            omittedByCount: selection.omittedByCount,
            omittedBySize: selection.omittedBySize,
            truncatedBodies: selection.truncatedBodies,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`github_pr_comments failed: ${message}`);
      }
    },
  });

  pi.on("session_shutdown", async () => {
    const directories = [...tempDirectories];
    tempDirectories.clear();
    await Promise.allSettled(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  });
}
