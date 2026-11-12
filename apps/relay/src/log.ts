// The relay's only logging. It never takes request data: a stage and an error's class, nothing a
// client or device sent (agent-run-security.md, "What the relay keeps"). A test fails the build if
// `console` is used anywhere else in src.

export function logFailure(stage: string, error: unknown): void {
  const kind = error instanceof Error ? error.constructor.name : typeof error
  console.error(`relay: ${stage} failed (${kind})`)
}
