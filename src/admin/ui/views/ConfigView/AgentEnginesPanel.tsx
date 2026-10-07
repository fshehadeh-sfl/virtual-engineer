import { useEffect, useState } from "react";
import { api } from "../../api.ts";
import type { ApiAgentEngine, ApiAgentEngines } from "../../types.ts";

interface AgentEnginesPanelProps {
  canWrite: boolean;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}

function engineStatus(engine: ApiAgentEngine): { label: string; color: string } {
  if (engine.installed === null) return { label: "Unknown", color: "var(--text-faint)" };
  if (engine.requested && engine.installed) return { label: "Installed", color: "var(--accent-strong)" };
  if (engine.requested) return { label: "Pending rebuild", color: "var(--warn)" };
  if (engine.forced) return { label: "Kept by launcher", color: "var(--text-faint)" };
  if (engine.installed) return { label: "Removal pending", color: "var(--warn)" };
  return { label: "Not installed", color: "var(--text-faint)" };
}

/**
 * Selects which agent engine images `scripts/start.sh` builds. Saving only
 * records the selection; images are built or pruned on the next launcher run.
 */
export function AgentEnginesPanel({ canWrite, onDirtyChange }: AgentEnginesPanelProps) {
  const [state, setState] = useState<ApiAgentEngines | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function apply(next: ApiAgentEngines): void {
    setState(next);
    setSelected(new Set(next.engines.filter((engine) => engine.requested).map((engine) => engine.id)));
  }

  useEffect(() => {
    let cancelled = false;
    api.get<ApiAgentEngines>("/api/admin/agent-engines")
      .then((next) => { if (!cancelled) apply(next); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load agent engines"); });
    return () => { cancelled = true; };
  }, []);

  const dirty = state !== null && state.engines.some((engine) => engine.requested !== selected.has(engine.id));

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  if (!state) {
    return error ? <div style={{ color: "var(--danger)", fontSize: "12.5px" }}>{error}</div> : null;
  }

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleSave(): Promise<void> {
    setError(null);
    setSaving(true);
    try {
      apply(await api.put<ApiAgentEngines>("/api/admin/agent-engines", { requested: [...selected] }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const lastRowStart = state.engines.length - (state.engines.length % 2 || 2);

  return (
    <>
      <div className="eyebrow" style={{ marginBottom: "8px" }}>Agent engines</div>
      <div className="card" data-tour="system-agent-engines" style={{ padding: "16px 18px", marginBottom: "22px" }}>
        <p style={{ margin: "0 0 12px", color: "var(--text-faint)", fontSize: "13px" }}>
          Copilot is always installed. Other engines are built locally as separate images only when selected.
          Changes take effect the next time <span className="mono">./scripts/start.sh</span> runs.
        </p>
        {state.rebuildRequired && !dirty && (
          <div role="status" style={{ marginBottom: "12px", fontSize: "12.5px", color: "var(--warn)" }}>
            Rerun <span className="mono">./scripts/start.sh</span> to build or remove the pending engines.
          </div>
        )}
        <div data-testid="agent-engines-grid" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", columnGap: "24px" }}>
        {state.engines.map((engine, i) => {
          const status = engineStatus(engine);
          const locked = engine.isDefault || !canWrite || (engine.integrationCount > 0 && selected.has(engine.id));
          return (
            <label
              key={engine.id}
              style={{
                display: "flex", alignItems: "center", gap: "12px", padding: "10px 0",
                borderBottom: i < lastRowStart ? "1px solid var(--border-soft)" : "none",
              }}
            >
              <input
                type="checkbox"
                aria-label={engine.label}
                checked={selected.has(engine.id)}
                disabled={locked}
                onChange={() => toggle(engine.id)}
              />
              <span style={{ flex: 1, fontSize: "13px", fontWeight: 500 }}>
                {engine.label}
                {engine.isDefault && <span style={{ color: "var(--text-faint)", fontWeight: 400 }}> · default</span>}
                {engine.integrationCount > 0 && (
                  <span style={{ color: "var(--text-faint)", fontWeight: 400 }}>
                    {` · used by ${engine.integrationCount} integration${engine.integrationCount === 1 ? "" : "s"}`}
                  </span>
                )}
              </span>
              <span className="mono" style={{ fontSize: "12px", color: status.color }}>{status.label}</span>
            </label>
          );
        })}
        </div>
        {error && <div style={{ color: "var(--danger)", fontSize: "12.5px", marginTop: "10px" }}>{error}</div>}
        {canWrite && (
          <div style={{ marginTop: "12px" }}>
            <button className="btn primary" onClick={() => void handleSave()} disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save engine selection"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
