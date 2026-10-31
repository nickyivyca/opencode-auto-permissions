import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ReviewUsage } from "./types.ts"

// One line per model attempt that reported usage. Unlike the diagnostics
// file this ledger is never truncated: it exists so usage can be totalled
// after the reviewer sessions themselves are gone.
export interface UsageRecord extends ReviewUsage {
  ts: string
  requestID: string
  sessionID: string
  providerID: string
  modelID: string
  variant?: string
  attempt: number
  outcome: "decision" | "failure" | "cancelled"
}

export function defaultUsagePath(): string {
  const stateRoot = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")
  return join(stateRoot, "opencode", "auto-permissions", "usage.jsonl")
}

export function writeUsage(path: string | undefined, record: UsageRecord): void {
  if (!path) return
  // A single append of one short line is atomic, so concurrent plugin
  // processes sharing the ledger need no queue.
  void mkdir(dirname(path), { recursive: true })
    .then(() => appendFile(path, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 }))
    .catch(() => undefined)
}
