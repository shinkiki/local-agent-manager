import { useEffect, useMemo, useState } from "react";
import { getMenuTranslations } from "./ipc";
import type { MenuTranslations, TranslationMenu, TranslationSummary } from "../types";

export function useMenuTranslations(menu: TranslationMenu, revision: number) {
  const [data, setData] = useState<MenuTranslations | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getMenuTranslations(menu)
      .then((value) => {
        if (!active) return;
        setData(value);
        setError(null);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { active = false; };
  }, [menu, revision]);

  const records = useMemo(
    () => new Map<string, TranslationSummary>((data?.records ?? []).map((record) => [record.resourceId, record])),
    [data?.records],
  );
  return { data, records, error };
}

export function artifactGroupTranslationId(rootName: string, conversationId: string): string {
  return `group:${rootName}:${conversationId}`;
}

export function artifactTranslationId(rootName: string, conversationId: string, name: string): string {
  return `artifact:${rootName}:${conversationId}:${name}`;
}
