import { Worker } from "node:worker_threads"

/** Run a worker module (TypeScript under tsx) with workerData and resolve with its first message. */
export function runWorker<T>(url: URL, data: unknown, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const bootstrap = new URL("./worker-bootstrap.mjs", import.meta.url)
    const w = new Worker(bootstrap, { workerData: { ...(data as object), __entry: url.href } })
    const onAbort = () => {
      void w.terminate()
      reject(new Error("Canceled"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    w.once("message", (m: T) => {
      signal?.removeEventListener("abort", onAbort)
      resolve(m)
      void w.terminate()
    })
    w.once("error", (e) => {
      signal?.removeEventListener("abort", onAbort)
      reject(e)
    })
    w.once("exit", (code) => {
      if (code !== 0 && code !== 1) reject(new Error(`worker exited with code ${code}`))
    })
  })
}
