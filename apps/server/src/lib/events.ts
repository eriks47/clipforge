import { EventEmitter } from "node:events"
import type { ServerEvent } from "@clipforge/shared"

/** In-process event bus feeding the SSE endpoint. */
class EventBus extends EventEmitter {
  emitEvent(ev: ServerEvent) {
    this.emit("event", ev)
  }
  subscribe(fn: (ev: ServerEvent) => void): () => void {
    this.on("event", fn)
    return () => this.off("event", fn)
  }
}

export const bus = new EventBus()
bus.setMaxListeners(100)
