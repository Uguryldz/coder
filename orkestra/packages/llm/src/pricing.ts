/**
 * Per-million-token pricing in USD. Numbers reflect Anthropic public pricing
 * for Claude 4.x tier at the time of writing. Update as needed.
 */
export const PRICING: Record<
  string,
  { inputPerM: number; outputPerM: number; cacheReadPerM: number }
> = {
  "claude-opus-4-7": { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5 },
  "claude-sonnet-4-6": { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  "claude-haiku-4-5-20251001": { inputPerM: 0.8, outputPerM: 4, cacheReadPerM: 0.08 },
};

export function estimateCostUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
  cacheHits = 0,
): number {
  const p = PRICING[model] ?? PRICING["claude-sonnet-4-6"]!;
  const billableIn = Math.max(0, tokensIn - cacheHits);
  const cost =
    (billableIn * p.inputPerM) / 1_000_000 +
    (cacheHits * p.cacheReadPerM) / 1_000_000 +
    (tokensOut * p.outputPerM) / 1_000_000;
  return cost;
}
