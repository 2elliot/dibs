import type { Intent } from "@dibs/shared";

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

/**
 * Active intents from other agents that look like the same work, closest first. Brute force
 * replaces pgvector: with tens of intents in the local cache it's instant.
 */
export function nearestIntents(
  intents: Iterable<Intent>,
  embedding: number[],
  excludeAgentId: bigint,
  threshold = 0.75,
  limit = 5,
): { intent: Intent; similarity: number }[] {
  const matches: { intent: Intent; similarity: number }[] = [];
  for (const intent of intents) {
    if (intent.status !== "active" || intent.agentId === excludeAgentId) continue;
    const similarity = cosine(embedding, intent.embedding);
    if (similarity > threshold) matches.push({ intent, similarity });
  }
  return matches.sort((x, y) => y.similarity - x.similarity).slice(0, limit);
}
