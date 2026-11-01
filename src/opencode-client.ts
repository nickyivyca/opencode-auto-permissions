import type { ReviewModel, ReviewTokens, ReviewUsage, ReviewerClient } from "./types.ts"
import { decisionSchema, REVIEWER_AGENT_ID } from "./agent.ts"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REVIEWER_PERMISSIONS = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "StructuredOutput", pattern: "*", action: "allow" },
] as const
const REVIEWER_DIRECTORY = join(tmpdir(), "opencode-auto-permissions", "reviewer")
const REVIEWER_SESSION_TITLE = "Auto Permissions review"

function decisionChoices(ask: boolean | undefined): string {
  return ask ? `"allow", "allow_session", "deny", or "ask"` : `"allow", "allow_session", or "deny"`
}

export class OpenCodeClientAdapter implements ReviewerClient {
  constructor(private readonly client: any) {}

  async prewarm(): Promise<void> {
    await mkdir(REVIEWER_DIRECTORY, { recursive: true })
    const location = { directory: REVIEWER_DIRECTORY }
    const requests: Promise<unknown>[] = []
    if (typeof this.client.app?.agents === "function") requests.push(this.client.app.agents(location))
    if (typeof this.client.app?.skills === "function") requests.push(this.client.app.skills(location))
    if (typeof this.client.v2?.agent?.list === "function") {
      requests.push(this.client.v2.agent.list({ location }))
    }
    if (typeof this.client.v2?.skill?.list === "function") {
      requests.push(this.client.v2.skill.list({ location }))
    }
    if (typeof this.client.agent?.list === "function") requests.push(this.client.agent.list({ location }))
    if (typeof this.client.skill?.list === "function") requests.push(this.client.skill.list({ location }))
    if (requests.length === 0) throw new Error("OpenCode reviewer prewarm APIs are unavailable")
    await Promise.all(requests)
  }

  async generate(input: {
    prompt: string
    model: ReviewModel
    parentSessionID: string
    location?: { directory?: string; workspaceID?: string }
    signal: AbortSignal
    onTokens?(tokens: ReviewTokens): void
    onUsage?(usage: ReviewUsage): void
    ask?: boolean
  }): Promise<unknown> {
    if (typeof this.client.permission?.request?.list === "function") return this.generateCurrent(input)
    const stable = typeof this.client.postSessionIdPermissionsPermissionId === "function"
    const session = stable ? this.client.session : (this.client.v2?.session ?? this.client.session)
    if (!session || typeof session.create !== "function" || typeof session.prompt !== "function") {
      throw new Error("OpenCode reviewer session API is unavailable")
    }

    await mkdir(REVIEWER_DIRECTORY, { recursive: true })
    const location = { directory: REVIEWER_DIRECTORY }
    let sessionID: string | undefined
    // Each turn's result, kept for its token and cost counts. The reviewer
    // session is deleted below, and with it the only other record of them.
    const turns: unknown[] = []
    const abortRemote = () => {
      if (!sessionID || typeof session.abort !== "function") return
      const abortInput = stable
        ? { path: { id: sessionID }, query: location }
        : { sessionID, ...location }
      void Promise.resolve(session.abort(abortInput)).catch(() => undefined)
    }
    input.signal.addEventListener("abort", abortRemote, { once: true })

    try {
      if (input.signal.aborted) throw abortError(input.signal.reason)
      const createInput = stable
        ? {
            query: location,
            body: {
              title: REVIEWER_SESSION_TITLE,
              permission: REVIEWER_PERMISSIONS,
            },
          }
        : {
            ...location,
            title: REVIEWER_SESSION_TITLE,
            agent: REVIEWER_AGENT_ID,
            model: input.model,
            metadata: { source: "opencode-auto-permissions" },
            permission: REVIEWER_PERMISSIONS,
          }
      const created = unwrapData(await session.create(createInput, { signal: input.signal }))
      if (!isRecord(created) || typeof created.id !== "string") {
        throw new Error("OpenCode failed to create a reviewer session")
      }
      sessionID = created.id

      const promptBody = {
        model: { providerID: input.model.providerID, modelID: input.model.id },
        variant: input.model.variant,
        agent: REVIEWER_AGENT_ID,
        format: {
          type: "json_schema",
          schema: decisionSchema(input.ask === true),
          retryCount: 1,
        },
        parts: [{ type: "text", text: input.prompt }],
      }
      const promptInput = stable
        ? { path: { id: sessionID }, query: location, body: promptBody }
        : {
            sessionID,
            ...location,
            ...promptBody,
          }
      try {
        const result = unwrapData(await session.prompt(promptInput, { signal: input.signal }))
        turns.push(result)
        const structured = assistantStructured(result)
        reportTokens(result, input.onTokens)
        return structured
      } catch (error) {
        if (!isStructuredOutputError(error)) throw error
        // The failed turn's user message, which holds the full prompt, stays in
        // the reviewer session. Repeating the prompt here would double the
        // input and put a second copy after the request, out of cache reach.
        const fallbackBody = {
          ...promptBody,
          format: { type: "text" },
          parts: [{
            type: "text",
            text: `Structured output was unavailable. Return only one JSON object without Markdown fences. It must have exactly these three keys:\n- "decision": one of ${decisionChoices(input.ask)}\n- "reasonCode": lower_snake_case, starting with a letter, at most 64 characters\n- "reason": one non-empty sentence, at most 240 characters\n\nExample: {"decision":"allow","reasonCode":"authorized_action","reason":"The action reasonably supports the user's request."}`,
          }],
        }
        const fallbackInput = stable
          ? { path: { id: sessionID }, query: location, body: fallbackBody }
          : { sessionID, ...location, ...fallbackBody }
        const result = unwrapData(await session.prompt(fallbackInput, { signal: input.signal }))
        turns.push(result)
        reportTokens(result, input.onTokens)
        return JSON.parse(assistantText(result))
      }
    } finally {
      input.signal.removeEventListener("abort", abortRemote)
      const usage = sumUsage(turns)
      if (usage) input.onUsage?.(usage)
      if (sessionID && typeof session.delete === "function") {
        const deleteInput = stable
          ? { path: { id: sessionID }, query: location }
          : { sessionID, ...location }
        await Promise.resolve(session.delete(deleteInput)).catch(() => undefined)
      }
    }
  }

  async reply(input: {
    sessionID: string
    requestID: string
    reply: "once" | "always" | "reject"
    message?: string
    protocol: "stable" | "v2"
  }): Promise<"replied" | "replied_with_reason" | "not_found"> {
    try {
      if (typeof this.client.permission?.request?.list === "function") {
        await this.client.permission.reply({
          sessionID: input.sessionID,
          requestID: input.requestID,
          decision: input.reply,
          ...(input.message ? { message: input.message } : {}),
        })
        return "replied"
      }
      const scoped = this.client.v2?.session?.permission ?? this.client.session?.permission
      if (input.protocol === "v2" && typeof scoped?.reply === "function") {
        try {
          const result = await scoped.reply(input)
          throwForResultError(result)
          return "replied"
        } catch (error) {
          if (!isNotFound(error) || typeof this.client.permission?.reply !== "function") throw error
        }
      }

      // The 1.x client only generates the old session-scoped route, which takes
      // no message, and OpenCode ends the agent's turn on a plain rejection. The
      // newer route takes the message and turns it into feedback the agent can
      // act on in the same turn. Any failure there falls back to the old route,
      // so the rejection itself is always delivered.
      const transport = this.client._client
      if (input.reply === "reject" && input.message && typeof transport?.post === "function") {
        const result = await Promise.resolve(transport.post({
          url: "/permission/{requestID}/reply",
          path: { requestID: input.requestID },
          body: { reply: input.reply, message: input.message },
          headers: { "Content-Type": "application/json" },
        })).catch((error: unknown) => ({ error }))
        if (!isRecord(result) || result.error === undefined) return "replied_with_reason"
      }

      const legacy = this.client.permission
      const result = typeof legacy?.reply === "function"
        ? await legacy.reply(input)
        : typeof this.client.postSessionIdPermissionsPermissionId === "function"
          ? await this.client.postSessionIdPermissionsPermissionId({
              path: { id: input.sessionID, permissionID: input.requestID },
              body: { response: input.reply },
            })
          : (() => { throw new Error("OpenCode permission reply API is unavailable") })()
      throwForResultError(result)
      return "replied"
    } catch (error) {
      if (isNotFound(error)) return "not_found"
      throw error
    }
  }

  private async generateCurrent(input: {
    prompt: string
    model: ReviewModel
    signal: AbortSignal
    ask?: boolean
  }): Promise<unknown> {
    await mkdir(REVIEWER_DIRECTORY, { recursive: true })
    let sessionID: string | undefined
    const abortRemote = () => {
      if (sessionID) void Promise.resolve(this.client.session.interrupt({ sessionID })).catch(() => undefined)
    }
    input.signal.addEventListener("abort", abortRemote, { once: true })
    try {
      if (input.signal.aborted) throw abortError(input.signal.reason)
      const session = await this.client.session.create({
        title: REVIEWER_SESSION_TITLE,
        agent: REVIEWER_AGENT_ID,
        model: input.model,
        location: { directory: REVIEWER_DIRECTORY },
      }, { signal: input.signal })
      if (!isRecord(session) || typeof session.id !== "string") throw new Error("OpenCode failed to create a reviewer session")
      sessionID = session.id
      const strictPrompt = `${input.prompt}\n\nReturn only one JSON object without Markdown fences with exactly these keys: "decision" (${decisionChoices(input.ask)}), "reasonCode" (lower_snake_case), and "reason" (one sentence).`
      const result = await this.client.session.generate({ sessionID, prompt: strictPrompt }, { signal: input.signal })
      if (!isRecord(result) || typeof result.text !== "string") throw new Error("OpenCode reviewer returned no text output")
      return JSON.parse(result.text)
    } finally {
      input.signal.removeEventListener("abort", abortRemote)
      if (sessionID) await Promise.resolve(this.client.session.remove({ sessionID })).catch(() => undefined)
    }
  }
}

function assistantStructured(value: unknown): unknown {
  if (!isRecord(value)) throw new Error("OpenCode reviewer returned an invalid response")
  if (isRecord(value.info) && value.info.error) throw value.info.error
  if (!isRecord(value.info) || !("structured" in value.info)) {
    throw new Error("OpenCode reviewer returned no structured output")
  }
  return value.info.structured
}

function assistantText(value: unknown): string {
  if (!isRecord(value)) throw new Error("OpenCode reviewer returned an invalid response")
  if (isRecord(value.info) && value.info.error) throw value.info.error
  if (!Array.isArray(value.parts)) throw new Error("OpenCode reviewer returned no text output")
  const text = value.parts
    .filter((part): part is Record<string, any> => isRecord(part) && part.type === "text")
    .map((part) => part.text)
    .filter((part): part is string => typeof part === "string")
    .join("")
    .trim()
  if (!text) throw new Error("OpenCode reviewer returned no text output")
  return text
}

function reportTokens(value: unknown, onTokens: ((tokens: ReviewTokens) => void) | undefined): void {
  if (!onTokens || !isRecord(value) || !isRecord(value.info)) return
  const tokens = value.info.tokens
  if (!isRecord(tokens) || !isRecord(tokens.cache)) return
  const { input, output, reasoning } = tokens
  const { read, write } = tokens.cache
  if (![input, output, read, write].every((count) => typeof count === "number")) return
  onTokens({ input, output, ...(typeof reasoning === "number" ? { reasoning } : {}), cache: { read, write } })
}

// Listing the reviewer session's messages instead would also catch aborted
// turns, but OpenCode 1.18 rejects that listing with a 400: it cannot decode
// the json_schema format stored on the review's own user message.
function sumUsage(messages: unknown[]): ReviewUsage | undefined {
  const usage: ReviewUsage = { turns: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
  let cost: number | undefined
  for (const message of messages) {
    const info = isRecord(message) && isRecord(message.info) ? message.info : message
    if (!isRecord(info) || info.role !== "assistant" || !isRecord(info.tokens)) continue
    const tokens = info.tokens
    const cache = isRecord(tokens.cache) ? tokens.cache : {}
    usage.turns++
    usage.tokens.input += count(tokens.input)
    usage.tokens.output += count(tokens.output)
    usage.tokens.reasoning += count(tokens.reasoning)
    usage.tokens.cache.read += count(cache.read)
    usage.tokens.cache.write += count(cache.write)
    if (typeof info.cost === "number" && Number.isFinite(info.cost)) cost = (cost ?? 0) + info.cost
  }
  if (usage.turns === 0) return undefined
  return cost === undefined ? usage : { ...usage, cost }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function isStructuredOutputError(error: unknown): boolean {
  if (!isRecord(error)) return false
  if (error.name === "StructuredOutputError" || error._tag === "StructuredOutputError") return true
  if (
    typeof error.message === "string" &&
    /thinking mode does not support this tool_choice|tool_choice ['"]?required['"]? is incompatible with thinking/i.test(error.message)
  ) return true
  return isStructuredOutputError(error.error) || isStructuredOutputError(error.data) || isStructuredOutputError(error.cause)
}

function unwrapData(result: unknown): unknown {
  throwForResultError(result)
  let value = result
  for (let depth = 0; depth < 3; depth++) {
    if (!isRecord(value) || !("data" in value)) break
    value = value.data
  }
  return value
}

function throwForResultError(result: unknown): void {
  if (!isRecord(result) || !("error" in result) || result.error === undefined) return
  throw result.error
}

function isNotFound(error: unknown): boolean {
  if (!isRecord(error)) return false
  const status = error.status ?? Reflect.get(error, "statusCode")
  if (status === 404) return true
  const tag = error._tag ?? error.name
  return tag === "PermissionNotFoundError" || tag === "Permission.NotFoundError"
}

function abortError(reason: unknown): Error {
  return new DOMException(typeof reason === "string" ? reason : "Review aborted", "AbortError")
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
