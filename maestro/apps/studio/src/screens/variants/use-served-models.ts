import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../auth/AuthProvider.tsx";
import { listConnectionModels, type ConnectionModelRow } from "./model-source.ts";

/**
 * The model ids some ENABLED connection actually serves, read from
 * `/studio/connections`. A model on this list is reachable by definition,
 * whatever its name looks like — "anthropic/claude-sonnet-4.5" behind an
 * OpenRouter connection was being flagged "unreachable cloud model" on the
 * pilot, on the strength of its name alone, on a platform that had just
 * listed it from that very connection.
 */
export function useServedModels(): ReadonlySet<string> {
  const api = useApi();
  const query = useQuery({
    queryKey: ["connections"],
    queryFn: ({ signal }) =>
      api.get<{ connections: readonly ConnectionModelRow[] }>("/studio/connections", { signal }),
    staleTime: 60_000,
    retry: false,
  });
  return new Set(listConnectionModels(query.data?.connections).map((row) => row.model));
}
