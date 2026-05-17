const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|uninstall|update|ci|link|publish|add|remove)\b/i,
  /\b(?:git|jj)\s+(?:add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone|new|squash|describe|bookmark)\b/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill(?:all)?\b/i,
  /\bpkill\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(?:start|stop|restart|enable|disable)\b/i,
  /\bservice\s+\S+\s+(?:start|stop|restart)\b/i,
  /\b(?:vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
  /^\s*(?:cat|head|tail|less|more|grep|rg|find|fd|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|env|printenv|uname|whoami|id|date|ps)\b/i,
  /^\s*(?:git|jj)\s+(?:status|st|log|diff|show|branch|remote|root|config\s+--get)\b/i,
  /^\s*npm\s+(?:list|ls|view|info|search|outdated|audit)\b/i,
  /^\s*(?:node|python|python3|ruby|go|rustc|cargo)\s+(?:--version|version|-V)\b/i,
  /^\s*curl\s/i,
  /^\s*wget\s+-O\s*-/i,
  /^\s*(?:jq|sed\s+-n|awk|bat|eza)\b/i,
];

export type TodoItem = {
  step: number;
  text: string;
  completed: boolean;
};

export function isSafeCommand(command: string): boolean {
  return !DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command)) && SAFE_PATTERNS.some((pattern) => pattern.test(command));
}

export function extractTodoItems(message: string): TodoItem[] {
  const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
  if (!headerMatch) return [];

  const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
  const items: TodoItem[] = [];

  for (const match of planSection.matchAll(/^\s*(\d+)[.)]\s+(.+)$/gm)) {
    const text = match[2]
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\s+/g, " ")
      .trim();

    if (text.length > 5 && !text.startsWith("/") && !text.startsWith("-")) {
      items.push({ step: items.length + 1, text: text.length > 80 ? `${text.slice(0, 77)}...` : text, completed: false });
    }
  }

  return items;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
  let completed = 0;
  for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    const item = items.find((candidate) => candidate.step === step);
    if (item && !item.completed) {
      item.completed = true;
      completed += 1;
    }
  }
  return completed;
}
