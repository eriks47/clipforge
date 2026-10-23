import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"

export default defineConfig(({ mode }) => {
  // The API port lives in the repo-root .env (shared with the server); a real env var wins.
  const rootEnv = loadEnv(mode, resolve(import.meta.dirname, "../.."), "")
  const api = `http://127.0.0.1:${process.env.PORT ?? rootEnv.PORT ?? 5174}`
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve(import.meta.dirname, "./src"),
      },
    },
    // local-only app: one bundle is fine
    build: { chunkSizeWarningLimit: 3000 },
    server: {
      port: 5173,
      proxy: {
        "/api": { target: api, changeOrigin: false },
        "/files": { target: api, changeOrigin: false },
      },
    },
  }
})
