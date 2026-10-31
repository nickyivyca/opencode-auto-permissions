import { readFile, stat } from "node:fs/promises"
import { homedir as osHomedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

export interface InstructionFile {
  path: string
  content: string
}

export interface InstructionLocation {
  directory: string
  // The instance worktree: the git root, or "/" outside git. Without it the
  // project walk runs to the filesystem root.
  worktree?: string
}

export interface InstructionEnvironment {
  env?: Readonly<Record<string, string | undefined>>
  homedir?: string
}

const OPENING_TAG = "<instruction_file"
const CLOSING_TAG = "</instruction_file>"

/**
 * Mirrors OpenCode 1.x `Instruction.systemPaths()` (session/instruction.ts,
 * v1.18.30-v1.19.5) so the reviewer reads the same files the session agent
 * received: the first global file that exists, then every match of the first
 * project filename found between the session directory and the worktree,
 * nearest first. Config `instructions` entries are not followed. OpenCode 2.x
 * discovers differently and needs its own variant.
 */
export async function discoverInstructionPaths(
  location: InstructionLocation,
  environment: InstructionEnvironment = {},
): Promise<string[]> {
  const env = environment.env ?? process.env
  const home = environment.homedir ?? osHomedir()
  const disableClaudeCode = effectBoolean(env.OPENCODE_DISABLE_CLAUDE_CODE) ||
    effectBoolean(env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT)
  const configDirectory = env.OPENCODE_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode")
  const paths = new Set<string>()

  const globalFiles = [
    join(configDirectory, "AGENTS.md"),
    ...(disableClaudeCode ? [] : [join(env.OPENCODE_TEST_HOME ?? home, ".claude", "CLAUDE.md")]),
  ]
  for (const file of globalFiles) {
    if (await exists(file)) {
      paths.add(resolve(file))
      break
    }
  }

  if (!truthy(env.OPENCODE_DISABLE_PROJECT_CONFIG)) {
    const projectFiles = ["AGENTS.md", ...(disableClaudeCode ? [] : ["CLAUDE.md"]), "CONTEXT.md"]
    for (const file of projectFiles) {
      const matches = await findUp(file, location.directory, location.worktree)
      if (matches.length > 0) {
        for (const match of matches) paths.add(resolve(match))
        break
      }
    }
  }
  return [...paths]
}

/** Resolves configured paths: `~/` from the home directory, others from the session directory. */
export function explicitInstructionPaths(
  paths: readonly string[],
  directory: string | undefined,
  environment: InstructionEnvironment = {},
): string[] {
  const env = environment.env ?? process.env
  const home = env.OPENCODE_TEST_HOME ?? environment.homedir ?? osHomedir()
  return paths.flatMap((path) => {
    if (path.startsWith("~/")) return [join(home, path.slice(2))]
    if (isAbsolute(path)) return [resolve(path)]
    return directory ? [resolve(directory, path)] : []
  })
}

/** Reads each file fresh. Empty or unreadable files are skipped, as OpenCode does. */
export async function readInstructionFiles(
  paths: readonly string[],
  onMissing?: (path: string) => void,
): Promise<InstructionFile[]> {
  const files = await Promise.all(paths.map(async (path) => {
    const content = await readFile(path, "utf8").catch(() => undefined)
    if (content === undefined) onMissing?.(path)
    return content ? { path, content } : undefined
  }))
  return files.filter((file): file is InstructionFile => file !== undefined)
}

/**
 * Renders the files as tagged blocks, global first. Closing tags inside a file
 * are neutralized so a file cannot end its block early and pose as other
 * prompt sections. Over `maxChars`, the middle is cut: the start and the end
 * are kept because deny-style rules tend to sit at the end of these files.
 */
export function renderInstructions(
  files: readonly InstructionFile[],
  maxChars: number,
): { text: string; chars: number; truncated: boolean } {
  const text = files
    .map((file) => `${OPENING_TAG} path=${JSON.stringify(file.path)}>\n${neutralize(file.content)}\n${CLOSING_TAG}`)
    .join("\n\n")
  if (text.length <= maxChars) return { text, chars: text.length, truncated: false }
  const marker = (omitted: number) => `\n\n[... ${omitted} characters omitted by Auto Permissions ...]\n\n`
  const budget = maxChars - marker(text.length).length
  const head = Math.ceil(budget / 2)
  const tail = Math.floor(budget / 2)
  return {
    text: text.slice(0, head) + marker(text.length - head - tail) + text.slice(text.length - tail),
    chars: text.length,
    truncated: true,
  }
}

function neutralize(content: string): string {
  return content.replace(/<\/\s*instruction_file\s*>/gi, "<\\/instruction_file>")
}

// Same walk as OpenCode's FSUtil.findUp: the start directory, then each parent
// up to and including `stop`, or the filesystem root.
async function findUp(target: string, start: string, stop?: string): Promise<string[]> {
  const result: string[] = []
  let current = start
  while (true) {
    const search = join(current, target)
    if (await exists(search)) result.push(search)
    if (stop === current) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return result
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

// Effect's Config.boolean, which OpenCode uses for the Claude Code flags.
// Case-sensitive; any other value makes OpenCode fail at startup.
function effectBoolean(value: string | undefined): boolean {
  return value === "true" || value === "yes" || value === "on" || value === "1" || value === "y"
}

// OpenCode's Flag.truthy, used for OPENCODE_DISABLE_PROJECT_CONFIG.
function truthy(value: string | undefined): boolean {
  const lower = value?.toLowerCase()
  return lower === "true" || lower === "1"
}
