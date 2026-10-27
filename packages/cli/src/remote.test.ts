import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { remoteServer } from "./connect.js";
import { hostedConfig } from "./daemon.js";

// Where a client sends its requests, and when a server considers itself hosted. Both are read
// from the environment and ~/.memloom/config.env, so the tests own both.

const KEYS = [
  "MEMLOOM_HOME",
  "MEMLOOM_URL",
  "MEMLOOM_TOKEN",
  "MEMLOOM_PUBLIC_URL",
  "MEMLOOM_LOGIN_PASSWORD",
  "MEMLOOM_OWNER_ID",
  "PORT",
];
let saved: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  home = mkdtempSync(join(tmpdir(), "memloom-remote-"));
  process.env.MEMLOOM_HOME = home;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

describe("remoteServer", () => {
  it("is undefined for a local install", () => {
    expect(remoteServer()).toBeUndefined();
  });

  it("reads the URL and token from config.env when the environment has none", () => {
    writeFileSync(
      join(home, "config.env"),
      "MEMLOOM_URL=https://memloom.example.com/\nMEMLOOM_TOKEN=mlm_abc\n",
    );
    expect(remoteServer()).toEqual({ url: "https://memloom.example.com", token: "mlm_abc" });
  });

  it("lets the environment win over the file", () => {
    writeFileSync(join(home, "config.env"), "MEMLOOM_URL=https://file.example.com\n");
    process.env.MEMLOOM_URL = "https://env.example.com";
    expect(remoteServer()?.url).toBe("https://env.example.com");
  });

  it("refuses a URL without a scheme", () => {
    process.env.MEMLOOM_URL = "memloom.example.com";
    expect(() => remoteServer()).toThrow(/http:\/\/ or https:\/\//);
  });
});

describe("hostedConfig", () => {
  it("is off without MEMLOOM_PUBLIC_URL", () => {
    expect(hostedConfig()).toBeUndefined();
  });

  it("requires https away from localhost", () => {
    process.env.MEMLOOM_PUBLIC_URL = "http://memloom.example.com";
    expect(() => hostedConfig()).toThrow(/https/);
  });

  it("requires a long enough login password", () => {
    process.env.MEMLOOM_PUBLIC_URL = "https://memloom.example.com";
    process.env.MEMLOOM_LOGIN_PASSWORD = "short";
    expect(() => hostedConfig()).toThrow(/12 characters/);
  });

  it("takes the port Fly gives it", () => {
    process.env.MEMLOOM_PUBLIC_URL = "https://memloom.example.com/";
    process.env.PORT = "8080";
    expect(hostedConfig()).toMatchObject({
      publicUrl: "https://memloom.example.com",
      port: 8080,
      loginPassword: undefined,
    });
  });
});
