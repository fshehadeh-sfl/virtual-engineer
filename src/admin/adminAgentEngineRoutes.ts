import type { IncomingMessage } from "node:http";
import type { IntegrationStore } from "../interfaces.js";
import { getLogger } from "../logger.js";
import {
  AGENT_ENGINE_LABELS,
  DEFAULT_AGENT_ENGINE,
  describeAgentEngines,
  isAgentEngine,
  type AgentEngine,
  type AgentEngineStateStore,
} from "../agents/agentEngines.js";
import { recordAudit, type AuditCapableStore } from "./adminAudit.js";
import { filterVisibleIntegrations } from "./adminIntegrationRoutes.js";
import { readBody, requireStore, writeJson } from "./adminRouteUtils.js";
import type { Router } from "./router.js";

const log = getLogger("admin-agent-engines");

export interface AgentEngineRouteDeps {
  agentEngines?: AgentEngineStateStore | undefined;
  integrationStore?: Pick<IntegrationStore, "getIntegrations"> | undefined;
  auditStore?: AuditCapableStore | undefined;
}

interface EngineUsage {
  /** Names of integrations the caller may read. */
  visible: string[];
  /** Integrations hidden from the caller; counted for removal safety, never named. */
  hidden: number;
}

/** Agent integrations grouped by engine, split by what the caller may see. */
async function integrationsByEngine(
  req: IncomingMessage,
  store: Pick<IntegrationStore, "getIntegrations"> | undefined,
): Promise<Map<AgentEngine, EngineUsage>> {
  const all = (await store?.getIntegrations()) ?? [];
  const visibleIds = new Set(filterVisibleIntegrations(req, all).map((integration) => integration.id));
  const grouped = new Map<AgentEngine, EngineUsage>();
  for (const integration of all) {
    if (!isAgentEngine(integration.provider)) continue;
    const usage = grouped.get(integration.provider) ?? { visible: [], hidden: 0 };
    if (visibleIds.has(integration.id)) usage.visible.push(integration.name);
    else usage.hidden += 1;
    grouped.set(integration.provider, usage);
  }
  return grouped;
}

function describeBlocker(engine: AgentEngine, usage: EngineUsage): string {
  const parts = usage.visible.map((name) => `"${name}"`);
  if (usage.hidden > 0) parts.push(`${usage.hidden} integration${usage.hidden === 1 ? "" : "s"} you cannot view`);
  return `- ${AGENT_ENGINE_LABELS[engine]}: ${parts.join(", ")}`;
}

/**
 * Agent engine selection. The orchestrator cannot build images, so saving a
 * selection only records it; `scripts/start.sh` builds requested engines and
 * prunes the rest on its next run, then reports what is installed.
 */
export function registerAgentEngineRoutes(router: Router, deps: AgentEngineRouteDeps): void {
  const respond = async (req: IncomingMessage, store: AgentEngineStateStore): Promise<Record<string, unknown>> => {
    const [requested, installed, forced, usage] = await Promise.all([
      store.readRequested(),
      store.readInstalled(),
      store.readForced(),
      integrationsByEngine(req, deps.integrationStore),
    ]);
    const engines = describeAgentEngines({
      requested: requested ?? [DEFAULT_AGENT_ENGINE],
      installed,
      forced,
      integrationCounts: new Map([...usage].map(([engine, entry]) => [engine, entry.visible.length])),
    });
    return {
      engines,
      installStateKnown: installed !== undefined,
      rebuildRequired: installed !== undefined
        && engines.some((engine) => engine.requested !== engine.installed && !engine.forced),
    };
  };

  router.add("GET", "/api/admin/agent-engines", async (req, res, _params) => {
    if (!requireStore(deps.agentEngines, res, "Agent engine state is not available")) return;
    writeJson(res, 200, await respond(req, deps.agentEngines));
  }, { permission: "system.read" });

  router.add("PUT", "/api/admin/agent-engines", async (req, res, _params) => {
    if (!requireStore(deps.agentEngines, res, "Agent engine state is not available")) return;
    const body = await readBody(req);
    const raw = body?.["requested"];
    if (!Array.isArray(raw) || !raw.every((value): value is string => typeof value === "string")) {
      writeJson(res, 400, { error: "requested must be an array of agent engine ids" });
      return;
    }
    const unknown = raw.filter((value) => !isAgentEngine(value));
    if (unknown.length > 0) {
      writeJson(res, 400, { error: `Unknown agent engine(s): ${unknown.join(", ")}` });
      return;
    }
    const nextSet = new Set(raw.filter(isAgentEngine));

    const usage = await integrationsByEngine(req, deps.integrationStore);
    const blocked = [...usage].filter(([engine]) => engine !== DEFAULT_AGENT_ENGINE && !nextSet.has(engine));
    if (blocked.length > 0) {
      const lines = blocked.map(([engine, entry]) => describeBlocker(engine, entry));
      writeJson(res, 409, {
        error: `These engines are still used by agent integrations:\n${lines.join("\n")}\nDelete those integrations before removing the engine.`,
      });
      return;
    }

    const previous = (await deps.agentEngines.readRequested()) ?? [DEFAULT_AGENT_ENGINE];
    const requested = await deps.agentEngines.writeRequested(nextSet);
    const added = requested.filter((engine) => !previous.includes(engine));
    const removed = previous.filter((engine) => !requested.includes(engine));
    log.info({ requested, added, removed }, "agent engine selection updated");
    recordAudit(deps.auditStore, req, {
      action: "agent_engine.update",
      targetType: "agent_engine",
      targetId: "selection",
      details: { requested, added, removed },
    });
    writeJson(res, 200, await respond(req, deps.agentEngines));
  }, { permission: "system.write" });
}
