import { describe, expect, test } from "bun:test"
import { parseDecision } from "../src/verdict.ts"

describe("parseDecision", () => {
  test("accepts an exact structured decision", () => {
    expect(
      parseDecision({ decision: "allow", reasonCode: "routine_test", reason: "Runs local tests." }),
    ).toEqual({ kind: "allow", reasonCode: "routine_test", reason: "Runs local tests." })
  })

  test("accepts a session-scoped approval decision", () => {
    expect(
      parseDecision({ decision: "allow_session", reasonCode: "repeatable_read", reason: "Safe for this session." }),
    ).toEqual({ kind: "allow_session", reasonCode: "repeatable_read", reason: "Safe for this session." })
  })

  test("accepts ask only when the ask option is on", () => {
    const value = { decision: "ask", reasonCode: "human_rule_conflict", reason: "AGENTS.md forbids pushing to main." }
    expect(parseDecision(value)).toBeNull()
    expect(parseDecision(value, { ask: true })).toEqual({
      kind: "ask",
      reasonCode: "human_rule_conflict",
      reason: "AGENTS.md forbids pushing to main.",
    })
  })

  test("truncates an over-long reason at the boundary", () => {
    const decision = parseDecision({
      decision: "allow",
      reasonCode: "x",
      reason: "a".repeat(300),
    })
    expect(decision?.reason.length).toBe(240)
  })

  test.each([
    "",
    null,
    { decision: "allow", reasonCode: "x", reason: "ok", extra: true },
    { decision: "SAFE", reasonCode: "x", reason: "ok" },
    { decision: "ask", reasonCode: "x", reason: "Needs a human." },
    { decision: "allow", reasonCode: "Not-Snake", reason: "ok" },
    { decision: "allow", reasonCode: "x", reason: "" },
  ])("rejects malformed output %#", (value) => {
    expect(parseDecision(value)).toBeNull()
  })
})
