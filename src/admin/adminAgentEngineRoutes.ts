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
import { readBody, requireStore, writeJson } from "./adminRouteUtils.js";
import type { Router } from "./router.js";

const log = getLogger("admin-agent-engines");

export interface AgentEngineRouteDeps {
  agentEngines?: AgentEngineStateStore | undefined;
  integrationStore?: Pick<IntegrationStore, "getIntegrations"> | undefined;
  auditStore?: AuditCapableStore | undefined;
}

/** Agent integrations grouped by the engine they run. */
async function integrationsByEngine(
  store: Pick<IntegrationStore, "getIntegrations"> | undefined,
): Promise<Map<AgentEngine, string[]>> {
  const grouped = new Map<AgentEngine, string[]>();
  for (const integration of (await store?.getIntegrations()) ?? []) {
    if (!isAgentEngine(integration.provider)) continue;
    grouped.set(integration.provider, [...(grouped.get(integration.provider) ?? []), integration.name]);
  }
  return grouped;
}

/**
 * Agent engine selection. The orchestrator cannot build images, so saving a
 * selection only records it; `scripts/start.sh` builds requested engines and
 * prunes the rest on its next run, then reports what is installed.
 */
export function registerAgentEngineRoutes(router: Router, deps: AgentEngineRouteDeps): void {
  const respond = async (store: AgentEngineStateStore): Promise<Record<string, unknown>> => {
    const [requested, installed, usage] = await Promise.all([
      store.readRequested(),
      store.readInstalled(),
      integrationsByEngine(deps.integrationStore),
    ]);
    const engines = describeAgentEngines({
      requested: requested ?? [DEFAULT_AGENT_ENGINE],
      installed,
      integrationCounts: new Map([...usage].map(([engine, names]) => [engine, names.length])),
    });
    return {
      engines,
      installStateKnown: installed !== undefined,
      rebuildRequired: installed !== undefined
        && engines.some((engine) => engine.requested !== engine.installed),
    };
  };

  router.add("GET", "/api/admin/agent-engines", async (_req, res, _params) => {
    if (!requireStore(deps.agentEngines, res, "Agent engine state is not available")) return;
    writeJson(res, 200, await respond(deps.agentEngines));
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

    const usage = await integrationsByEngine(deps.integrationStore);
    const blocked = [...usage].filter(([engine]) => engine !== DEFAULT_AGENT_ENGINE && !nextSet.has(engine));
    if (blocked.length > 0) {
      const lines = blocked.map(([engine, names]) => `- ${AGENT_ENGINE_LABELS[engine]}: ${names.map((name) => `"${name}"`).join(", ")}`);
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
    writeJson(res, 200, await respond(deps.agentEngines));
  }, { permission: "system.write" });
}
