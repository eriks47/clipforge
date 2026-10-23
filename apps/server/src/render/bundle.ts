import { join } from "node:path"
import { bundle } from "@remotion/bundler"
import { ensureBrowser } from "@remotion/renderer"
import { config, ROOT_DIR } from "../config"

let bundlePromise: Promise<string> | null = null

/** Bundle the Remotion project once per server process (webpack takes a few seconds). */
export function getBundle(log: (s: string) => void): Promise<string> {
  if (!bundlePromise) {
    log("Bundling Remotion composition (first render only)…")
    bundlePromise = bundle({
      entryPoint: join(ROOT_DIR, "packages/remotion/src/entry.ts"),
      outDir: join(config.dataDir, ".remotion-bundle"),
      onProgress: () => undefined,
    }).catch((e: unknown) => {
      bundlePromise = null
      throw e
    })
  }
  return bundlePromise
}

let browserReady: Promise<unknown> | null = null
export function ensureRemotionBrowser(log: (s: string) => void) {
  if (!browserReady) {
    browserReady = ensureBrowser({
      onBrowserDownload: () => {
        log("Downloading Chrome Headless Shell for Remotion (one-time)…")
        return { version: null, onProgress: () => undefined }
      },
    }).catch((e: unknown) => {
      browserReady = null
      throw e
    })
  }
  return browserReady
}
