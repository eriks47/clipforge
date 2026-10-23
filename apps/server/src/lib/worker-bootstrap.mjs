// Worker entry that enables TypeScript (via tsx) before importing the real worker module,
// so worker threads work the same under `tsx`, vitest and plain node.
import { workerData } from "node:worker_threads"
import { register } from "tsx/esm/api"

register()
await import(workerData.__entry)
