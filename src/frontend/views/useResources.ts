import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { failureOf, type Api, type ResourceList } from "../api";
import { describeFailure } from "./ConnectionForm";

export interface ResourcesState {
  list: ResourceList | null;
  loading: boolean;
  error: string | null;
  /** Fetches again; `refresh` skips the backend's 20 second cache. */
  reload: (refresh?: boolean) => Promise<void>;
}

/**
 * One connection's resources, shared by the Overview and Resources sections
 * so switching between them doesn't fetch again. The list belongs to the
 * connection's id and revision: a new address, token or TLS setting clears it
 * and loads it again.
 */
export function useResources(
  api: Api,
  connectionId: number | null,
  revision: string | null = null,
): ResourcesState {
  const { t } = useTranslation();
  const [list, setList] = useState<ResourceList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A new id or revision is a new `reload`, so the effect below loads again.
  const key = connectionId === null ? null : `${connectionId}:${revision}`;
  // Each request takes the next generation, and only the latest may set
  // state: an answer for A that arrives after switching A, B and back to A is
  // dropped, as is an older reload's answer that arrives after a newer one.
  const requests = useRef(0);

  const reload = useCallback(
    async (refresh = false) => {
      const generation = ++requests.current;
      const latest = () => generation === requests.current;
      if (connectionId === null || key === null) return;
      setLoading(true);
      try {
        const answer = await api.listResources(connectionId, { refresh });
        if (!latest()) return;
        setList(answer);
        setError(null);
      } catch (err) {
        if (!latest()) return;
        setError(
          failureOf(err) ? describeFailure(t, err) : t("resources.loadFailed"),
        );
      } finally {
        if (latest()) setLoading(false);
      }
    },
    [api, connectionId, key, t],
  );

  useEffect(() => {
    setList(null);
    setError(null);
    void reload();
  }, [reload]);

  return { list, loading, error, reload };
}
