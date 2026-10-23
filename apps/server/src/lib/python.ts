import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { config } from "../config"
import { run } from "./proc"

let ldPathCache: string | null = null

/** pip-installed NVIDIA libs (cuBLAS/cuDNN) live in site-packages/nvidia/<pkg>/lib; expose them to CTranslate2. */
function nvidiaLibPath(): string {
  if (ldPathCache !== null) return ldPathCache
  const libRoot = join(config.pyWorkersDir, ".venv", "lib")
  const dirs: string[] = []
  if (existsSync(libRoot)) {
    for (const py of readdirSync(libRoot)) {
      const nv = join(libRoot, py, "site-packages", "nvidia")
      if (!existsSync(nv)) continue
      for (const pkg of readdirSync(nv)) {
        const lib = join(nv, pkg, "lib")
        if (existsSync(lib)) dirs.push(lib)
      }
    }
  }
  ldPathCache = dirs.join(":")
  return ldPathCache
}

export function pythonAvailable(): boolean {
  return existsSync(config.python)
}

export interface PyEvents {
  log: (msg: string) => void
  progress: (p: number) => void
}

/**
 * Run a worker script that speaks the JSON-lines protocol
 * ({type: "log"|"progress"|"result"|"error"}).
 */
export async function runPythonWorker(
  script: string,
  args: string[],
  ev: PyEvents,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<Record<string, unknown>> {
  if (!pythonAvailable()) {
    throw new Error(`Python venv not found at ${config.python}. Run ./setup.sh to create it.`)
  }
  let result: Record<string, unknown> = {}
  let workerError: string | null = null
  const ld = [nvidiaLibPath(), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":")
  try {
    await run(config.python, ["-u", join(config.pyWorkersDir, script), ...args], {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 8 * 3600 * 1000,
      env: {
        ...process.env,
        LD_LIBRARY_PATH: ld,
        PYTHONUNBUFFERED: "1",
        HF_HUB_DISABLE_PROGRESS_BARS: "1",
      },
      onStdoutLine: (line) => {
        let msg: { type?: string; value?: number; message?: string } & Record<string, unknown>
        try {
          msg = JSON.parse(line) as typeof msg
        } catch {
          if (line.trim()) ev.log(line)
          return
        }
        if (msg.type === "progress" && typeof msg.value === "number") ev.progress(msg.value)
        else if (msg.type === "log") ev.log(String(msg.message ?? ""))
        else if (msg.type === "result") result = msg
        else if (msg.type === "error") workerError = String(msg.message ?? "unknown error")
      },
      onStderrLine: (line) => {
        // Skip noisy TF/absl and progress-bar chatter
        if (/^\s*$|^W0000|^I0000|it\/s\]|%\|/.test(line)) return
        ev.log(line)
      },
    })
  } catch (e) {
    if (workerError) throw new Error(workerError, { cause: e })
    throw e
  }
  if (workerError) throw new Error(workerError)
  return result
}
