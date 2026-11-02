import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blobMirrorFromEnv, S3Mirror } from "./blob-mirror.js";

// The bucket copy of uploaded recordings: what is sent, where, and how a lost file comes back.

let root: string;
const objects = new Map<string, Uint8Array>();
const seen: { method: string; url: string; auth: string | null }[] = [];

const fakeS3: typeof fetch = async (input) => {
  const req = input as Request;
  seen.push({ method: req.method, url: req.url, auth: req.headers.get("authorization") });
  const key = new URL(req.url).pathname;
  if (req.method === "PUT") {
    objects.set(key, new Uint8Array(await req.arrayBuffer()));
    return new Response(null, { status: 200 });
  }
  const body = objects.get(key);
  return body ? new Response(body) : new Response("NoSuchKey", { status: 404 });
};

function mirror() {
  return new S3Mirror({
    endpoint: "https://acct.r2.cloudflarestorage.com/",
    bucket: "memloom",
    accessKeyId: "AKID",
    secretAccessKey: "secret",
    root,
    fetch: fakeS3,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "memloom-blobs-"));
  objects.clear();
  seen.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("S3Mirror", () => {
  it("stores an upload under its path in the uploads folder, signed", async () => {
    mkdirSync(join(root, "u-abc"));
    const file = join(root, "u-abc", "voice note.m4a");
    writeFileSync(file, "audio bytes");
    await mirror().put(file);
    expect(seen[0]?.method).toBe("PUT");
    expect(seen[0]?.url).toBe(
      "https://acct.r2.cloudflarestorage.com/memloom/u-abc/voice%20note.m4a",
    );
    expect(seen[0]?.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\//);
    expect(new TextDecoder().decode(objects.get("/memloom/u-abc/voice%20note.m4a"))).toBe(
      "audio bytes",
    );
  });

  it("brings a lost file back from the bucket", async () => {
    mkdirSync(join(root, "u-abc"));
    const file = join(root, "u-abc", "a.wav");
    writeFileSync(file, "wav");
    await mirror().put(file);
    rmSync(join(root, "u-abc"), { recursive: true });

    expect(await mirror().ensureLocal(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("wav");
  });

  it("does not fetch a file that is already there", async () => {
    const file = join(root, "here.wav");
    writeFileSync(file, "x");
    expect(await mirror().ensureLocal(file)).toBe(true);
    expect(seen).toEqual([]);
  });

  it("reports a file the bucket never had", async () => {
    expect(await mirror().ensureLocal(join(root, "u-x", "gone.wav"))).toBe(false);
    expect(existsSync(join(root, "u-x", "gone.wav"))).toBe(false);
  });

  it("leaves files outside the uploads folder alone", async () => {
    const outside = join(tmpdir(), "not-an-upload.wav");
    expect(mirror().key(outside)).toBeNull();
    await mirror().put(outside);
    expect(seen).toEqual([]);
  });
});

describe("blobMirrorFromEnv", () => {
  it("is off when nothing is set", () => {
    expect(blobMirrorFromEnv({})).toBeUndefined();
  });

  it("names what is missing from a partial setup", () => {
    expect(() =>
      blobMirrorFromEnv({ MEMLOOM_S3_ENDPOINT: "https://x", MEMLOOM_S3_BUCKET: "b" }),
    ).toThrow(/MEMLOOM_S3_ACCESS_KEY_ID, MEMLOOM_S3_SECRET_ACCESS_KEY/);
  });
});
