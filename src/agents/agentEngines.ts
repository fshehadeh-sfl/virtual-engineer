import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Agent engines are the CLIs/SDKs an agent sandbox can run. Only the default
 * engine ships in the base sandbox image; every other engine lives in its own
 * opt-in image (`<base>-<engine>`) built by `scripts/start.sh` from the
 * matching `Dockerfile.agent` target. Engine ids equal the worker's
 * `AGENT_PROVIDER` values and the agent integration provider ids.
 */
export const AGENT_ENGINES = [
  "copilot",
  "claude",
  "aider",
  "goose",
  "codex",
  "gemini",
  "opencode",
  "cursor",
] as const;

export type AgentEngine = (typeof AGENT_ENGINES)[number];

export const DEFAULT_AGENT_ENGINE: AgentEngine = "copilot";

export const AGENT_ENGINE_LABELS: Readonly<Record<AgentEngine, string>> = {
  copilot: "GitHub Copilot",
  claude: "Claude",
  aider: "Aider",
  goose: "Goose",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  cursor: "Cursor",
};

/** Written by the orchestrator (admin UI); read by `scripts/start.sh`. */
export const REQUESTED_ENGINES_FILE = "agent-engines.requested";
/** Written by `scripts/start.sh` after building; read by the orchestrator. */
export const INSTALLED_ENGINES_FILE = "agent-engines.installed";

export function isAgentEngine(value: unknown): value is AgentEngine {
  return typeof value === "string" && (AGENT_ENGINES as readonly string[]).includes(value);
}

/**
 * Sandbox image for an engine: the base image for the default engine (or an
 * unknown provider), otherwise the base repository suffixed with `-<engine>`
 * and the same tag. A digest cannot carry over to a different image, so it is
 * dropped.
 */
export function agentEngineImage(baseImage: string, engine: string | undefined): string {
  if (!isAgentEngine(engine) || engine === DEFAULT_AGENT_ENGINE) return baseImage;
  const withoutDigest = baseImage.split("@", 1)[0] ?? baseImage;
  const lastSlash = withoutDigest.lastIndexOf("/");
  const tagSeparator = withoutDigest.lastIndexOf(":");
  const hasTag = tagSeparator > lastSlash;
  const repository = hasTag ? withoutDigest.slice(0, tagSeparator) : withoutDigest;
  const tag = hasTag ? withoutDigest.slice(tagSeparator) : "";
  return `${repository}-${engine}${tag}`;
}

/** Parse a one-engine-per-line list; blank lines, `#` comments and unknown ids are ignored. */
export function parseEngineList(text: string): AgentEngine[] {
  const found = new Set<AgentEngine>();
  for (const line of text.split(/\r?\n/u)) {
    const value = line.replace(/#.*/u, "").trim();
    if (isAgentEngine(value)) found.add(value);
  }
  return sortEngines(found);
}

/** Canonical catalog order with the default engine always present. */
export function normalizeRequestedEngines(engines: Iterable<AgentEngine>): AgentEngine[] {
  return sortEngines(new Set<AgentEngine>([DEFAULT_AGENT_ENGINE, ...engines]));
}

function sortEngines(engines: ReadonlySet<AgentEngine>): AgentEngine[] {
  return AGENT_ENGINES.filter((engine) => engines.has(engine));
}

export interface AgentEngineStatus {
  id: AgentEngine;
  label: string;
  isDefault: boolean;
  requested: boolean;
  /** `null` when the launcher has not reported install state (e.g. `npm run dev`). */
  installed: boolean | null;
  integrationCount: number;
}

export function describeAgentEngines(input: {
  requested: readonly AgentEngine[];
  installed: readonly AgentEngine[] | undefined;
  integrationCounts: ReadonlyMap<AgentEngine, number>;
}): AgentEngineStatus[] {
  return AGENT_ENGINES.map((id) => ({
    id,
    label: AGENT_ENGINE_LABELS[id],
    isDefault: id === DEFAULT_AGENT_ENGINE,
    requested: id === DEFAULT_AGENT_ENGINE || input.requested.includes(id),
    installed: input.installed === undefined ? null : input.installed.includes(id),
    integrationCount: input.integrationCounts.get(id) ?? 0,
  }));
}

/**
 * Error message when `provider` is an agent engine the launcher reported as
 * not installed; `undefined` when it is usable or install state is unknown.
 */
export function agentEngineUnavailableMessage(
  provider: string,
  installed: readonly AgentEngine[] | undefined,
): string | undefined {
  if (installed === undefined || !isAgentEngine(provider) || provider === DEFAULT_AGENT_ENGINE) {
    return undefined;
  }
  if (installed.includes(provider)) return undefined;
  return `Agent engine "${AGENT_ENGINE_LABELS[provider]}" is not installed. Request it under Configuration → System → Agent engines, then rerun ./scripts/start.sh.`;
}

/** File-backed handshake between the admin UI and the host launcher. */
export class AgentEngineStateStore {
  constructor(private readonly dataDir: string) {}

  /** Requested engines, or `undefined` when no selection was ever saved. */
  async readRequested(): Promise<AgentEngine[] | undefined> {
    const text = await this.readOptional(REQUESTED_ENGINES_FILE);
    return text === undefined ? undefined : normalizeRequestedEngines(parseEngineList(text));
  }

  /** Engines whose image the launcher built, or `undefined` when never reported. */
  async readInstalled(): Promise<AgentEngine[] | undefined> {
    const text = await this.readOptional(INSTALLED_ENGINES_FILE);
    return text === undefined ? undefined : parseEngineList(text);
  }

  async writeRequested(engines: Iterable<AgentEngine>): Promise<AgentEngine[]> {
    const normalized = normalizeRequestedEngines(engines);
    await mkdir(this.dataDir, { recursive: true });
    const target = join(this.dataDir, REQUESTED_ENGINES_FILE);
    const temporary = `${target}.${process.pid}.tmp`;
    const body = [
      "# Agent engines requested in the admin UI; scripts/start.sh builds these images.",
      ...normalized,
      "",
    ].join("\n");
    await writeFile(temporary, body, { mode: 0o644 });
    await rename(temporary, target);
    return normalized;
  }

  /**
   * Create the requested list on first start so upgraded installs keep every
   * engine an existing integration uses. An existing selection is never changed.
   */
  async seedRequested(engines: Iterable<AgentEngine>): Promise<AgentEngine[]> {
    return (await this.readRequested()) ?? this.writeRequested(engines);
  }

  private async readOptional(name: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.dataDir, name), "utf8");
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") return undefined;
      throw err;
    }
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export interface AgentEngineStartupState {
  requested: AgentEngine[];
  installed: AgentEngine[] | undefined;
  /** Enabled agent integrations whose engine the launcher has not installed. */
  missing: Array<{ integrationName: string; engine: AgentEngine }>;
}

/**
 * Boot-time reconciliation: seed the requested list from existing agent
 * integrations (so an upgrade never drops an engine in use) and report enabled
 * integrations whose engine image is absent.
 */
export async function initializeAgentEngineState(
  store: AgentEngineStateStore,
  integrations: ReadonlyArray<{ provider: string; name: string; enabled: boolean }>,
): Promise<AgentEngineStartupState> {
  const used = integrations.map((integration) => integration.provider).filter(isAgentEngine);
  const requested = await store.seedRequested(used);
  const installed = await store.readInstalled();
  const missing = integrations.flatMap((integration) =>
    integration.enabled && agentEngineUnavailableMessage(integration.provider, installed) !== undefined && isAgentEngine(integration.provider)
      ? [{ integrationName: integration.name, engine: integration.provider }]
      : []);
  return { requested, installed, missing };
}
