import type { AgentMessageMeta } from "../lib/agentMessageMeta";

/**
 * 답변에서 걷어낸 공급자 내부 메타 블록. 본문에 XML로 새어 나오면 안 되지만 출처라서
 * 버리지도 않으므로, 접힌 채로 답변 끝에 붙여 필요할 때만 펼치게 한다.
 */
export function AgentMessageMetaList({ meta }: { meta: AgentMessageMeta[] }) {
  if (meta.length === 0) return null;
  return <>{meta.map((block, index) => <details className="agent-message-meta" key={`${block.tag}-${index}`}>
    <summary>{block.label}</summary>
    <pre>{block.text}</pre>
  </details>)}</>;
}
