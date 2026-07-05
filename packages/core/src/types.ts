export type MemoryStatus = "active" | "stale";

export interface Memory {
  id: string;
  ownerId: string;
  status: MemoryStatus;
  memoryType: string;
  canonical: string | null;
  content: string;
  summary: string | null;
  assertedAt: string;
  createdAt: string;
  /** Cosine similarity to the query, present on recall results. */
  similarity?: number;
}

export interface SaveInput {
  content: string;
  canonical?: string;
  memoryType?: string;
  /** Defaults to the fixed sentinel owner in the embedded (single-user) tier. */
  ownerId?: string;
}

export interface SaveResult {
  id: string;
}

export interface RecallOptions {
  limit?: number;
  ownerId?: string;
}
