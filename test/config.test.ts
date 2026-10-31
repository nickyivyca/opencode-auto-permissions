import { describe, expect, test } from "bun:test"
import { parseConfig } from "../src/config.ts"

describe("parseConfig", () => {
  test("parses an arbitrary provider/model reference", () => {
    expect(parseConfig({ model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" })).toEqual({
      model: { providerID: "cloudflare-workers-ai", id: "@cf/deepseek-ai/deepseek-v4-flash-0731" },
      modelLabel: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731",
      variant: undefined,
      timeoutMs: 30_000,
      userMessageCount: 8,
      shadow: false,
      ask: false,
      sessionApprovals: true,
      runtime: "auto",
      diagnosticsPath: undefined,
      usagePath: undefined,
      instructions: false,
      instructionsMaxChars: 64_000,
    })
  })

  test("parses the ask option", () => {
    expect(parseConfig({ model: "a/b", ask: true }).ask).toBeTrue()
    expect(parseConfig({ model: "a/b", ask: false }).ask).toBeFalse()
    for (const ask of ["true", 1, null]) {
      expect(() => parseConfig({ model: "a/b", ask })).toThrow(/ask/)
    }
  })

  test("parses the instructions option", () => {
    expect(parseConfig({ model: "a/b", instructions: true }).instructions).toBeTrue()
    expect(parseConfig({ model: "a/b", instructions: false }).instructions).toBeFalse()
    expect(parseConfig({ model: "a/b", instructions: [" AGENTS.md ", "~/rules.md"] }).instructions)
      .toEqual(["AGENTS.md", "~/rules.md"])
    for (const instructions of ["AGENTS.md", [], [""], [1], null]) {
      expect(() => parseConfig({ model: "a/b", instructions })).toThrow(/instructions/)
    }
    expect(parseConfig({ model: "a/b", instructionsMaxChars: 32_000 }).instructionsMaxChars).toBe(32_000)
    for (const instructionsMaxChars of [999, 500_001, 1.5, "64000"]) {
      expect(() => parseConfig({ model: "a/b", instructionsMaxChars })).toThrow(/instructionsMaxChars/)
    }
  })

  test("allows slashes inside the model id", () => {
    expect(parseConfig({ model: "provider/org/model" }).model).toEqual({
      providerID: "provider",
      id: "org/model",
    })
  })

  test("applies an optional reviewer variant", () => {
    expect(parseConfig({ model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731", variant: "high" }).model).toEqual({
      providerID: "cloudflare-workers-ai",
      id: "@cf/deepseek-ai/deepseek-v4-flash-0731",
      variant: "high",
    })
    expect(() => parseConfig({ model: "a/b", variant: "" })).toThrow(/variant/)
  })

  test("inherits the requesting session model by default", () => {
    expect(parseConfig({})).toMatchObject({ model: undefined, modelLabel: undefined, variant: undefined })
  })

  test.each([{ model: "" }, { model: "deepseek-v4-flash-0731" }, { model: "/deepseek-v4-flash-0731" }, { model: "provider/" }])(
    "rejects invalid model option %#",
    (options) => expect(() => parseConfig(options)).toThrow(),
  )

  test("rejects out-of-range runtime options", () => {
    expect(() => parseConfig({ model: "a/b", timeoutMs: 99 })).toThrow(/timeoutMs/)
    expect(() => parseConfig({ model: "a/b", userMessageCount: 21 })).toThrow(/userMessageCount/)
  })

  test("supports a diagnostics-only runtime override", () => {
    expect(parseConfig({ model: "a/b", runtime: "stable" }).runtime).toBe("stable")
    expect(parseConfig({ model: "a/b", runtime: "v2" }).runtime).toBe("v2")
    expect(() => parseConfig({ model: "a/b", runtime: "other" })).toThrow(/runtime/)
  })

  test("allows session approvals to be disabled", () => {
    expect(parseConfig({ model: "a/b" }).sessionApprovals).toBeTrue()
    expect(parseConfig({ model: "a/b", sessionApprovals: false }).sessionApprovals).toBeFalse()
  })

  test("enables bounded diagnostics with a default or explicit path", () => {
    expect(parseConfig({ model: "a/b", debug: true }).diagnosticsPath).toEndWith("opencode/auto-permissions/decisions.jsonl")
    expect(parseConfig({ model: "a/b", debug: "/tmp/decisions.jsonl" }).diagnosticsPath).toBe("/tmp/decisions.jsonl")
    expect(parseConfig({ model: "a/b", usage: true }).usagePath).toEndWith("opencode/auto-permissions/usage.jsonl")
    expect(parseConfig({ model: "a/b", usage: "/tmp/usage.jsonl" }).usagePath).toBe("/tmp/usage.jsonl")
    expect(() => parseConfig({ model: "a/b", usage: 1 })).toThrow("usage must be true, false, or a file path")
    expect(() => parseConfig({ model: "a/b", debug: 1 })).toThrow(/debug/)
  })
})
