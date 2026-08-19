import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

interface ChatActivityGroupProps<Entry> {
  entries: Entry[];
  active: boolean;
  status: string;
  statusText: string;
  summary: string;
  meta?: string;
  entryKey: (entry: Entry) => string;
  renderEntry: (entry: Entry) => ReactNode;
}

export function ChatActivityGroup<Entry>({
  entries,
  active,
  status,
  statusText,
  summary,
  meta,
  entryKey,
  renderEntry,
}: ChatActivityGroupProps<Entry>) {
  const [expanded, setExpanded] = useState(false);

  const visible = expanded ? entries : active ? entries.slice(-1) : [];
  return (
    <div className={`turn-activity-summary${expanded ? " expanded" : ""}${active ? " active" : ""}`}>
      <button
        type="button"
        className="turn-activity-toggle"
        aria-expanded={expanded}
        title={expanded ? "작업 내역 접기" : "작업 내역 펼치기"}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className={`chat-tool-state chat-tool-state-${status}`} />
        <strong>{summary}</strong>
        <em>{statusText}{meta ? ` · ${meta}` : ""}</em>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {visible.length > 0 && <div>
        {visible.map((entry) => <div className="turn-activity-entry" key={entryKey(entry)}>{renderEntry(entry)}</div>)}
      </div>}
    </div>
  );
}
