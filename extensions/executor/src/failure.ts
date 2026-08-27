function approvalExpiredMessage(message: string): string | undefined {
  if (!message.includes('"_tag":"ApprovalExpiredError"')) return undefined;

  const executionId = message.match(/"executionId":"([^"]+)"/)?.[1];
  const execution = executionId ? ` ${executionId}` : "";
  return `Executor could not resume execution${execution}. The approval expired or the gateway could not reconstruct the paused execution. Trigger the original action again.`;
}

export function formatExecutorFailure(
  stdout: string,
  stderr: string,
  code: number | null,
): string {
  const message = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  const approvalExpired = approvalExpiredMessage(message);
  if (approvalExpired) return approvalExpired;

  if (message === "[object Object]" || message.endsWith("\n[object Object]")) {
    return "Executor failed but its CLI returned an unreadable error. Run the command with `--log-level debug` for the real failure details.";
  }

  const bounded = message.length > 8_000 ? `${message.slice(0, 8_000)}…` : message;
  return bounded || `executor exited with code ${code ?? "unknown"}`;
}
