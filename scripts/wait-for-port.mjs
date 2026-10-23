// Wait until a TCP port accepts connections (used by `pnpm dev` so the web UI starts after the API).
// Usage: node scripts/wait-for-port.mjs [port] — default: PORT from the environment or the root .env, else 5174.
import { connect } from "node:net"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

function portFromEnvFile() {
  const file = resolve(import.meta.dirname, "../.env")
  if (!existsSync(file)) return null
  const m = /^\s*PORT\s*=\s*(\d+)/m.exec(readFileSync(file, "utf8"))
  return m ? Number(m[1]) : null
}

const port = Number(process.argv[2] ?? process.env.PORT ?? portFromEnvFile() ?? 5174)
const timeoutMs = 120_000
const started = Date.now()

function attempt() {
  const socket = connect({ port, host: "127.0.0.1" })
  socket.once("connect", () => {
    socket.end()
    process.exit(0)
  })
  socket.once("error", () => {
    socket.destroy()
    if (Date.now() - started > timeoutMs) {
      console.error(`API server did not open port ${port} within ${timeoutMs / 1000}s`)
      process.exit(1)
    }
    setTimeout(attempt, 150)
  })
}
attempt()
