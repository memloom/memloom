import { createReadStream } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { AwsClient } from "aws4fetch";
import { uploadStoreDir } from "./queue.js";

// Uploaded recordings, kept somewhere that outlives the machine.
//
// memloom works on files: ffmpeg reads them, playback streams them, the queue holds their paths.
// On a laptop the uploads folder is as durable as the laptop. A hosted server's disk is not: a
// replaced machine starts empty, and the documents in the database would point at nothing.
//
// So the folder stays the working copy, and every upload is also written to an S3-compatible
// bucket (Cloudflare R2, or any S3). A file the folder has lost is fetched back the first time
// something needs it. Keys are paths under the uploads folder, so the bucket mirrors it exactly.

export interface BlobMirror {
  /** Copy a file from the uploads folder to the bucket. */
  put(localPath: string): Promise<void>;
  /** Make sure the file is on disk, fetching it from the bucket if needed. False if neither has it. */
  ensureLocal(localPath: string): Promise<boolean>;
}

export interface S3MirrorConfig {
  /** e.g. https://<account-id>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 takes "auto"; AWS needs the bucket's region. */
  region?: string;
  /** Defaults to the store's uploads folder. */
  root?: string;
  fetch?: typeof fetch;
}

export class S3Mirror implements BlobMirror {
  readonly #client: AwsClient;
  readonly #base: string;
  readonly #root: string;
  readonly #fetch: typeof fetch;

  constructor(config: S3MirrorConfig) {
    this.#client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: config.region ?? "auto",
    });
    this.#base = `${config.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(config.bucket)}`;
    this.#root = config.root ?? uploadStoreDir();
    this.#fetch = config.fetch ?? fetch;
  }

  /** The object key for a file under the uploads folder, or null for anything outside it. */
  key(localPath: string): string | null {
    const rel = relative(this.#root, localPath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel.split(sep).map(encodeURIComponent).join("/");
  }

  async #send(method: string, key: string, init: RequestInit = {}): Promise<Response> {
    const signed = await this.#client.sign(`${this.#base}/${key}`, { method, ...init });
    return this.#fetch(signed);
  }

  async put(localPath: string): Promise<void> {
    const key = this.key(localPath);
    if (!key) return;
    const { size } = await stat(localPath);
    const res = await this.#send("PUT", key, {
      body: Readable.toWeb(createReadStream(localPath)) as ReadableStream,
      headers: { "content-length": String(size), "x-amz-content-sha256": "UNSIGNED-PAYLOAD" },
      duplex: "half",
    } as RequestInit);
    if (!res.ok) {
      throw new Error(
        `memloom: could not store ${key} in the bucket (${res.status} ${await res.text()})`,
      );
    }
  }

  async ensureLocal(localPath: string): Promise<boolean> {
    if (
      await stat(localPath).then(
        () => true,
        () => false,
      )
    )
      return true;
    const key = this.key(localPath);
    if (!key) return false;
    const res = await this.#send("GET", key);
    if (res.status === 404) return false;
    if (!res.ok) {
      throw new Error(`memloom: could not fetch ${key} from the bucket (${res.status})`);
    }
    await mkdir(dirname(localPath), { recursive: true });
    // Write beside and rename, so a half-downloaded file is never mistaken for the real one.
    const partial = `${localPath}.partial`;
    await writeFile(partial, new Uint8Array(await res.arrayBuffer()));
    await rename(partial, localPath);
    return true;
  }
}

/**
 * The mirror the environment asks for: MEMLOOM_S3_ENDPOINT, MEMLOOM_S3_BUCKET,
 * MEMLOOM_S3_ACCESS_KEY_ID and MEMLOOM_S3_SECRET_ACCESS_KEY (MEMLOOM_S3_REGION optional).
 * Undefined when none is set; a partial set is an error rather than a silent local-only store.
 */
export function blobMirrorFromEnv(env: NodeJS.ProcessEnv = process.env): BlobMirror | undefined {
  const names = [
    "MEMLOOM_S3_ENDPOINT",
    "MEMLOOM_S3_BUCKET",
    "MEMLOOM_S3_ACCESS_KEY_ID",
    "MEMLOOM_S3_SECRET_ACCESS_KEY",
  ] as const;
  const values = names.map((n) => env[n]?.trim());
  if (values.every((v) => !v)) return undefined;
  const missing = names.filter((_, i) => !values[i]);
  if (missing.length > 0) {
    throw new Error(`memloom: uploads to a bucket need ${missing.join(", ")} as well.`);
  }
  const [endpoint, bucket, accessKeyId, secretAccessKey] = values as string[];
  return new S3Mirror({
    endpoint: endpoint as string,
    bucket: bucket as string,
    accessKeyId: accessKeyId as string,
    secretAccessKey: secretAccessKey as string,
    ...(env.MEMLOOM_S3_REGION ? { region: env.MEMLOOM_S3_REGION } : {}),
  });
}
