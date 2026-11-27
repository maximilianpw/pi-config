import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  fuzzyFilter,
} from "@earendil-works/pi-tui";

type GitHubIssue = {
  number: number;
  title: string;
  state: string;
};

type RepoResolution = { ok: true; repo: string } | { ok: false; error: string; silent?: boolean };

const MAX_ISSUES = 100;
const MAX_SUGGESTIONS = 20;

function extractIssueToken(textBeforeCursor: string): string | undefined {
  const match = textBeforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
  return match?.[1];
}

export function parseGitHubRepo(remoteUrl: string): string | undefined {
  const match = remoteUrl.match(
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/(?:[^@/]+@)?github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/,
  );
  return match?.[1];
}

async function resolveGitHubRepo(pi: ExtensionAPI, cwd: string): Promise<RepoResolution> {
  const result = await pi.exec("git", ["remote", "-v"], { cwd, timeout: 5_000 });
  if (result.code !== 0) return { ok: false, error: "cwd is not a git repository", silent: true };

  for (const line of result.stdout.split("\n")) {
    const remoteUrl = line.trim().split(/\s+/)[1];
    if (!remoteUrl) continue;
    const repo = parseGitHubRepo(remoteUrl);
    if (repo) return { ok: true, repo };
  }

  return { ok: false, error: "repository has no GitHub remote", silent: true };
}

function formatIssueItem(issue: GitHubIssue): AutocompleteItem {
  return {
    value: `#${issue.number}`,
    label: `#${issue.number}`,
    description: `[${issue.state.toLowerCase()}] ${issue.title}`,
  };
}

function filterIssues(issues: GitHubIssue[], query: string): AutocompleteItem[] {
  if (!query.trim()) return issues.slice(0, MAX_SUGGESTIONS).map(formatIssueItem);

  if (/^\d+$/.test(query)) {
    const numericMatches = issues
      .filter((issue) => String(issue.number).startsWith(query))
      .slice(0, MAX_SUGGESTIONS)
      .map(formatIssueItem);
    if (numericMatches.length > 0) return numericMatches;
  }

  return fuzzyFilter(issues, query, (issue) => `${issue.number} ${issue.title}`).slice(0, MAX_SUGGESTIONS).map(formatIssueItem);
}

function createIssueAutocompleteProvider(
  current: AutocompleteProvider,
  getIssues: () => Promise<GitHubIssue[] | undefined>,
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const currentLine = lines[cursorLine] ?? "";
      const token = extractIssueToken(currentLine.slice(0, cursorCol));
      if (token === undefined) return current.getSuggestions(lines, cursorLine, cursorCol, options);

      const issues = await getIssues();
      if (options.signal.aborted || !issues || issues.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const suggestions = filterIssues(issues, token);
      if (suggestions.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);

      return { items: suggestions, prefix: `#${token}` };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

const ISSUE_CACHE_MS = 5 * 60_000;
const FAILURE_RETRY_MS = 30_000;

type IssueCache =
  | { readonly _tag: "empty" }
  | { readonly _tag: "loading"; readonly promise: Promise<GitHubIssue[] | undefined> }
  | { readonly _tag: "loaded"; readonly issues: GitHubIssue[] | undefined; readonly expiresAt: number };

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    let cache: IssueCache = { _tag: "empty" };
    let loadErrorShown = false;
    const warnOnce = (message: string) => {
      if (loadErrorShown) return;
      loadErrorShown = true;
      ctx.ui.notify(`github-issue-autocomplete: ${message}`, "warning");
    };

    // The repository and issues are looked up on the first `#`, so sessions that never
    // complete an issue spawn nothing. A non-GitHub cwd caches "no issues" like a success.
    const loadIssues = async (): Promise<{ issues: GitHubIssue[] | undefined; failed: boolean }> => {
      const resolved = await resolveGitHubRepo(pi, ctx.cwd);
      if (!resolved.ok) {
        if (!resolved.silent) warnOnce(resolved.error);
        return { issues: undefined, failed: false };
      }
      const result = await pi.exec(
        "gh",
        ["issue", "list", "--repo", resolved.repo, "--state", "open", "--limit", String(MAX_ISSUES), "--json", "number,title,state"],
        { cwd: ctx.cwd, timeout: 5_000 },
      );
      if (result.code !== 0) {
        warnOnce(`gh issue list failed: ${result.stderr.trim() || result.code}`);
        return { issues: undefined, failed: true };
      }
      try {
        return { issues: JSON.parse(result.stdout) as GitHubIssue[], failed: false };
      } catch {
        warnOnce("failed to parse gh issue list output");
        return { issues: undefined, failed: true };
      }
    };

    const getIssues = (): Promise<GitHubIssue[] | undefined> => {
      if (cache._tag === "loading") return cache.promise;
      if (cache._tag === "loaded" && cache.expiresAt > Date.now()) return Promise.resolve(cache.issues);
      const promise = loadIssues().then(({ issues, failed }) => {
        cache = {
          _tag: "loaded",
          issues,
          expiresAt: Date.now() + (failed ? FAILURE_RETRY_MS : ISSUE_CACHE_MS),
        };
        return issues;
      });
      cache = { _tag: "loading", promise };
      return promise;
    };

    ctx.ui.addAutocompleteProvider((current) => createIssueAutocompleteProvider(current, getIssues));
  });
}
