import { useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { StatePill } from "../../components/StatePill.tsx";
import { Tag } from "../../components/Tag.tsx";
import { ProviderGlyph } from "../../components/ProviderGlyph.tsx";
import { classifyWorkflowBucket, isActiveState } from "../../states.ts";
import { relativeTime } from "../../api.ts";
import type { ApiTask, TaskWorkflowBucket } from "../../types.ts";

const FILTERS: { id: "all" | TaskWorkflowBucket; label: string }[] = [
  { id: "all",      label: "All" },
  { id: "active",   label: "Active" },
  { id: "watching", label: "Watching" },
  { id: "done",     label: "Done" },
  { id: "failed",   label: "Failed" },
];

interface TaskRowProps {
  task: ApiTask;
  selected: boolean;
  onClick: () => void;
}

function TaskRow({ task, selected, onClick }: TaskRowProps) {
  const running = isActiveState(task.state);
  const primaryLink = task.ticketUrl ?? task.reviewUrl;
  return (
    <div
      style={{
        position: "relative", width: "100%", textAlign: "left", cursor: "pointer",
        borderLeft: `2px solid ${selected ? "var(--accent)" : "transparent"}`,
        background: selected ? "var(--panel-2)" : "transparent",
        padding: `${11 * (1)}px 14px`,
        display: "flex", flexDirection: "column", gap: "7px",
        borderBottom: "1px solid var(--border-soft)",
        transition: "background 0.12s var(--ease)", color: "inherit",
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "color-mix(in oklab, var(--panel-2) 55%, transparent)"; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
    >
      <button
        type="button"
        aria-label={`Inspect task ${task.ticketTitle || task.ticketId}`}
        onClick={onClick}
        style={{ position: "absolute", inset: 0, zIndex: 1, width: "100%", border: 0, background: "transparent", cursor: "pointer" }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
        <ProviderGlyph provider={task.ticketSourceLabel} size={22} />
        {primaryLink ? (
          <a
            href={primaryLink}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mono"
            style={{ position: "relative", zIndex: 2, fontSize: "11px", color: "var(--accent-strong)", textDecoration: "none" }}
            title="Open task/review"
          >
            {task.ticketSourceLabel.toUpperCase()} #{task.displayId ?? task.ticketId}
          </a>
        ) : (
          <span className="mono" style={{ fontSize: "11px", color: "var(--text-faint)" }}>
            {task.ticketSourceLabel.toUpperCase()} #{task.displayId ?? task.ticketId}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {running && <span className="live-dot" style={{ width: 6, height: 6, borderRadius: 99, background: "var(--accent-strong)" }} />}
      </div>
      <div
        style={{
          fontSize: "13px", fontWeight: 500, lineHeight: 1.35,
          color: selected ? "var(--text)" : "var(--text-dim)",
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
        }}
      >
        {task.ticketTitle || task.ticketId}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <StatePill state={task.state} size="sm" />
        {task.waitingForAgentSlot && <Tag tone="warn">Queued</Tag>}
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: "10px", color: "var(--text-ghost)" }}>
          {relativeTime(task.updatedAt)}
        </span>
      </div>
    </div>
  );
}

interface TaskListProps {
  tasks: ApiTask[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  compact?: boolean | undefined;
}

export function TaskList({ tasks, selectedId, onSelect, compact = false }: TaskListProps) {
  const [filter, setFilter] = useState<"all" | TaskWorkflowBucket>("all");
  const [query, setQuery] = useState("");

  const filtered = tasks.filter((t) => {
    if (filter !== "all" && classifyWorkflowBucket(t.state) !== filter) return false;
    if (query) {
      const q = query.toLowerCase();
      return (
        (t.ticketTitle ?? "").toLowerCase().includes(q) ||
        (t.ticketId ?? "").toLowerCase().includes(q) ||
        (t.displayId ?? "").toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div
      style={{
        width: compact ? "100%" : "340px", flex: compact ? 1 : "none",
        borderRight: "1px solid var(--border-soft)", background: "var(--rail)",
        display: "flex", flexDirection: "column", minHeight: 0,
      }}
    >
      {/* header */}
      <div style={{ padding: "13px 14px 10px", borderBottom: "1px solid var(--border-soft)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "11px" }}>
          <span className="eyebrow">Task queue</span>
          <span className="mono" style={{ fontSize: "11px", color: "var(--text-faint)" }}>
            {filtered.length}/{tasks.length}
          </span>
        </div>

        {/* search */}
        <div style={{ position: "relative", marginBottom: "10px" }}>
          <Icon
            name="search" size={14}
            style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", color: "var(--text-ghost)" }}
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by title or #id"
            style={{
              width: "100%",
              background: "var(--panel)", border: "1px solid var(--border-soft)",
              borderRadius: "var(--radius-sm)", color: "var(--text)",
              fontFamily: "var(--font-sans)", fontSize: "12.5px",
              padding: "7px 10px 7px 30px", outline: "none",
            }}
          />
        </div>

        {/* filter chips */}
        <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              style={{
                border: `1px solid ${filter === f.id ? "var(--accent-line)" : "var(--border-soft)"}`,
                background: filter === f.id ? "var(--accent-soft)" : "transparent",
                color: filter === f.id ? "var(--accent-strong)" : "var(--text-faint)",
                fontSize: "11.5px", fontWeight: 500, padding: "4px 10px",
                borderRadius: "99px", cursor: "pointer", transition: "all 0.13s var(--ease)",
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* list */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {filtered.length === 0 ? (
          <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-faint)", fontSize: "13px" }}>
            No tasks match the current filters.
          </div>
        ) : (
          filtered.map((t) => (
            <TaskRow
              key={t.taskId} task={t}
              selected={t.taskId === selectedId}
              onClick={() => onSelect(t.taskId)}
            />
          ))
        )}
      </div>
    </div>
  );
}
