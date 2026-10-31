// Structural equivalent of the OpenCode ModelRef used by both the stable and
// V2 clients. Declared locally because the stable and beta SDK packages type
// the same field set under different module paths.
export interface ReviewModel {
  providerID: string
  id: string
  variant?: string
}

export type PermissionProtocol = "stable" | "v2"

export interface PermissionRequest {
  id: string
  sessionID: string
  action: string
  resources: string[]
  always: string[]
  source?: { type: "tool"; messageID: string; callID: string }
  protocol: PermissionProtocol
}

export type Decision =
  | { kind: "allow"; reasonCode: string; reason: string }
  | { kind: "allow_session"; reasonCode: string; reason: string }
  | { kind: "deny"; reasonCode: string; reason: string }

// Where a user-role message came from. Root-session messages are typed by the
// human; a subagent session's user messages are task prompts the coding agent
// wrote when it delegated work, so they are the agent's words, not the human's.
export type MessageSource = "human" | "subagent_prompt"

export interface ReviewMessage {
  source: MessageSource
  text: string
}

export interface ReviewInput {
  request: {
    action: string
    resources: string[]
    sessionPatterns: string[]
    toolInput?: unknown
  }
  context: {
    rootSessionID: string
    directory?: string
    userMessages: ReviewMessage[]
    model?: ReviewModel
  }
}

export interface SessionData {
  root(sessionID: string): string | Promise<string>
  get(sessionID: string): { id: string; parentID?: string } | undefined
  message: {
    list(sessionID: string): unknown[]
    get(sessionID: string, messageID: string): unknown
    sync(sessionID: string): Promise<void>
  }
  permission: {
    list(sessionID: string): PermissionRequest[] | undefined
    sync(sessionID: string): Promise<void>
  }
}

export interface RuntimeContext {
  options: Readonly<Record<string, unknown>>
  client: unknown
  data: {
    on(type: string, handler: (event: unknown) => void): () => void
    session: SessionData
    location?: {
      default(): { directory?: string; workspaceID?: string }
    }
  }
  location?: { directory?: string; workspaceID?: string }
  showToast?(input: {
    title?: string
    message: string
    variant?: "info" | "success" | "warning" | "error"
    duration?: number
  }): void
  resumeAfterDenial?(sessionID: string, reason: string): void
}

// Token usage of the reviewer turn that produced a decision, as reported by
// the provider. Cache counts show whether the stable prompt prefix was reused.
export interface ReviewTokens {
  input: number
  output: number
  cache: { read: number; write: number }
}

export interface ReviewerClient {
  prewarm?(): Promise<void>
  generate(input: {
    prompt: string
    model: ReviewModel
    parentSessionID: string
    location?: { directory?: string; workspaceID?: string }
    signal: AbortSignal
    onTokens?(tokens: ReviewTokens): void
  }): Promise<unknown>
  reply(input: {
    sessionID: string
    requestID: string
    reply: "once" | "always" | "reject"
    message?: string
    protocol: PermissionProtocol
  }): Promise<"replied" | "not_found">
}
