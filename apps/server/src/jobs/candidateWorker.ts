import { parentPort, workerData } from "node:worker_threads"
import { generateCandidates, type CandidateInput } from "@clipforge/shared"

/** Runs candidate generation off the main thread (it can take a while for multi-hour videos). */
const { input, poolSize } = workerData as { input: CandidateInput; poolSize: number }
parentPort?.postMessage(generateCandidates(input, poolSize))
