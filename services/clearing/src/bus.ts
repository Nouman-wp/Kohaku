import { EventEmitter } from "node:events";
import type { LiveEvent } from "@kohaku/core";

/**
 * In-process event bus. Every state change the UI cares about is published here; the
 * WebSocket hub fans it out and a ring buffer keeps the recent past so a freshly opened
 * live floor is not empty.
 */
class Bus extends EventEmitter {
  private recent: LiveEvent[] = [];
  private readonly keep = 400;

  publish(event: LiveEvent): void {
    if (event.type !== "stats") {
      this.recent.push(event);
      if (this.recent.length > this.keep) this.recent.splice(0, this.recent.length - this.keep);
    }
    this.emit("event", event);
  }

  history(): LiveEvent[] {
    return [...this.recent];
  }

  clear(): void {
    this.recent = [];
  }
}

export const bus = new Bus();
bus.setMaxListeners(1000);

type Level = "info" | "warn" | "error";

export function log(level: Level, source: string, message: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${source}] ${message}`;
  if (level === "error") console.error(line, extra ?? "");
  else if (level === "warn") console.warn(line, extra ?? "");
  else console.log(line);
  bus.publish({ type: "log", at: Date.now(), level, source, message });
}
