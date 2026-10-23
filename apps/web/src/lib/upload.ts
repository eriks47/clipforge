import { api, ApiError } from "./api"

const CHUNK = 32 * 1024 * 1024

export interface UploadProgress {
  loaded: number
  total: number
}

async function putChunk(
  projectId: string,
  offset: number,
  blob: Blob,
  signal: AbortSignal
): Promise<number> {
  const res = await fetch(
    `/api/projects/${projectId}/upload?offset=${offset}`,
    {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: blob,
      signal,
    }
  )
  if (!res.ok) {
    let msg = res.statusText
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg
    } catch {
      // ignore
    }
    throw new ApiError(res.status, msg)
  }
  return ((await res.json()) as { uploadedBytes: number }).uploadedBytes
}

/**
 * Resumable upload: asks the server how much it has, then streams 32 MB chunks from that offset.
 * Network hiccups are retried; a page reload can resume via "Resume upload" with the same file.
 */
export async function uploadFile(
  projectId: string,
  file: File,
  onProgress: (p: UploadProgress) => void,
  signal: AbortSignal
) {
  let { uploadedBytes: offset } = await api.uploadStatus(projectId)
  onProgress({ loaded: offset, total: file.size })
  let failures = 0
  while (offset < file.size) {
    if (signal.aborted) throw new DOMException("Upload canceled", "AbortError")
    const end = Math.min(file.size, offset + CHUNK)
    try {
      offset = await putChunk(
        projectId,
        offset,
        file.slice(offset, end),
        signal
      )
      failures = 0
      onProgress({ loaded: offset, total: file.size })
    } catch (e) {
      if (signal.aborted) throw e
      failures++
      if (failures > 5) throw e
      await new Promise((r) => setTimeout(r, 1000 * failures))
      // re-sync with what the server actually has
      offset = (await api.uploadStatus(projectId)).uploadedBytes
    }
  }
  return api.completeUpload(projectId)
}
