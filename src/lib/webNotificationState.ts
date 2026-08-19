type AttentionStateItem = {
  id: string;
  kind: string;
};

function attentionStateKey(item: AttentionStateItem): string {
  return `${item.id}\u0000${item.kind}`;
}

export function attentionStateKeys(items: AttentionStateItem[]): Set<string> {
  return new Set(items.map(attentionStateKey));
}

export function freshAttentionStates<T extends AttentionStateItem>(
  items: T[],
  previousStates: Set<string>,
): T[] {
  return items.filter((item) => !previousStates.has(attentionStateKey(item)));
}
