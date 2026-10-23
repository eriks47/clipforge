import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** kill after this many ms (default 6h) */
  timeoutMs?: number
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
  /** keep this many trailing stderr chars for error messages */
  stderrTailChars?: number
  /** collect stdout into the result (avoid for huge outputs) */
  collectStdout?: boolean
  /** written to the child's stdin, which is then closed */
  input?: string
}

export interface RunResult {
  code: number
  stdout: string
  stderrTail: string
}

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderrTail: string,
    /** stdout collected so far (only with collectStdout) */
    readonly stdout = ""
  ) {
    super(message)
  }
}

export class CanceledError extends Error {
  constructor() {
    super("Canceled")
  }
}

/**
 * Spawn a process, stream its output line-by-line, enforce a timeout and honour an AbortSignal.
 * Rejects with ProcessError on non-zero exit (message includes the stderr tail).
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CanceledError())
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    child.stdin.on("error", () => undefined) // child may exit before reading everything
    child.stdin.end(opts.input ?? "")
    const tailMax = opts.stderrTailChars ?? 4000
    let stderrTail = ""
    let stdout = ""
    let settled = false
    let killedReason: "timeout" | "abort" | null = null

    const kill = (reason: "timeout" | "abort") => {
      killedReason = reason
      child.kill("SIGTERM")
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL")
      }, 3000).unref()
    }
    const timer = setTimeout(() => kill("timeout"), opts.timeoutMs ?? 6 * 3600 * 1000)
    const onAbort = () => kill("abort")
    opts.signal?.addEventListener("abort", onAbort, { once: true })

    createInterface({ input: child.stdout }).on("line", (line) => {
      if (opts.collectStdout) stdout += line + "\n"
      opts.onStdoutLine?.(line)
    })
    // ffmpeg uses \r for progress lines; split on both
    let errBuf = ""
    child.stderr.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8")
      stderrTail = (stderrTail + s).slice(-tailMax)
      errBuf += s
      const parts = errBuf.split(/\r\n|\n|\r/)
      errBuf = parts.pop() ?? ""
      for (const p of parts) if (p) opts.onStderrLine?.(p)
    })

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
      fn()
    }
    child.on("error", (err) =>
      finish(() =>
        reject(
          new ProcessError(
            (err as NodeJS.ErrnoException).code === "ENOENT"
              ? `Command not found: ${cmd}`
              : `Failed to start ${cmd}: ${err.message}`,
            null,
            ""
          )
        )
      )
    )
    child.on("close", (code) =>
      finish(() => {
        if (errBuf) opts.onStderrLine?.(errBuf)
        if (killedReason === "abort") return reject(new CanceledError())
        if (killedReason === "timeout")
          return reject(new ProcessError(`${cmd} timed out`, code, stderrTail))
        if (code !== 0) {
          const lastLines = stderrTail.trim().split(/\n/).slice(-6).join("\n")
          return reject(
            new ProcessError(
              `${cmd} exited with code ${code}${lastLines ? `:\n${lastLines}` : ""}`,
              code,
              stderrTail,
              stdout
            )
          )
        }
        resolve({ code: code ?? 0, stdout, stderrTail })
      })
    )
  })
}

/** Run and return stdout (small outputs only). */
export async function capture(
  cmd: string,
  args: string[],
  opts: Omit<RunOptions, "collectStdout"> = {}
): Promise<string> {
  const r = await run(cmd, args, { timeoutMs: 60_000, ...opts, collectStdout: true })
  return r.stdout
}
