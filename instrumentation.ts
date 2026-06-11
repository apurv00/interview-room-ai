/**
 * Next.js instrumentation hook — runs ONCE per server process at startup
 * (enabled via `experimental.instrumentationHook` on Next 14).
 *
 * Registers process-level handlers for unhandled promise rejections and
 * uncaught exceptions. Why this exists:
 *
 *   A floating-promise rejection (e.g. a TypeError in a fire-and-forget side
 *   effect) was crashing the Node process — Node >= 15 terminates on an
 *   unhandled rejection by default. In the `/api/inngest` function host, which
 *   runs SIX background functions concurrently, that crash silently killed
 *   co-located jobs mid-flight, leaving pathway/analysis sessions stuck at
 *   `pending` (~20% per QA matrix run, stable across runs). The QA matrix
 *   surfaced a recurring `Unhandled Rejection: TypeError` on both /api/inngest
 *   and /api/generate-feedback, plus a `fatal: Node.js process exited` log.
 *
 * These handlers:
 *   1. Log the FULL error + stack (structured, via pino) so the exact origin
 *      is visible — until now these reached only Node's truncated stderr, which
 *      made the offending line impossible to locate from the log API.
 *   2. Keep the process alive. One request's bad rejection must not take down
 *      the other five functions sharing the host. Serverless instances are
 *      ephemeral and the platform recycles them, so surviving with a logged
 *      error is strictly safer here than crashing the whole function host.
 */
export async function register(): Promise<void> {
  // Only the Node.js server runtime has a real `process` with these events.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // Guard against double-registration (HMR in dev can call register twice).
  const g = globalThis as typeof globalThis & { __processErrorHandlersRegistered?: boolean }
  if (g.__processErrorHandlersRegistered) return
  g.__processErrorHandlersRegistered = true

  const { logger } = await import('@shared/logger')
  const log = logger.child({ module: 'process' })

  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    log.error(
      { err, kind: 'unhandledRejection' },
      'process: unhandled promise rejection captured — process kept alive',
    )
  })

  process.on('uncaughtException', (err: Error) => {
    // A genuine uncaught (synchronous) exception can leave shared DB / queue
    // clients or in-flight Inngest work half-mutated; resuming would serve later
    // invocations from a corrupted process. So unlike unhandledRejection above,
    // we log the full stack for diagnosis and then EXIT, letting the platform
    // recycle a clean worker. The crash this PR targets is an unhandled
    // rejection (handled above with survive-and-log). Codex P2 on PR #450.
    // In production pino writes synchronously to stdout, so the log flushes
    // before exit.
    log.fatal(
      { err, kind: 'uncaughtException' },
      'process: uncaught exception — logging and exiting',
    )
    process.exit(1)
  })
}
