// Render a JS number[] as a pgvector literal: [0.1,-0.4,...]. Bound as a text param and cast
// to ::vector at the call site, so it works identically on PGLite and real Postgres.
export function toVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(",")}]`;
}
