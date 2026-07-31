import { afterEach, describe, expect, it } from "vitest";
import { PG_PORT, pgWirePort } from "./daemon.js";

describe("pgWirePort", () => {
  afterEach(() => {
    delete process.env.MEMLOOM_PG_PORT;
  });

  it("defaults to PG_PORT when unset", () => {
    delete process.env.MEMLOOM_PG_PORT;
    expect(pgWirePort()).toBe(PG_PORT);
  });

  it("uses MEMLOOM_PG_PORT when it is a real port", () => {
    process.env.MEMLOOM_PG_PORT = "45432";
    expect(pgWirePort()).toBe(45432);
  });

  // A typo must not take the wire down silently in a way that reads like the default is broken;
  // falling back is fine because the daemon prints the port it actually bound.
  it("falls back to the default on a value that is not a number", () => {
    process.env.MEMLOOM_PG_PORT = "not-a-port";
    expect(pgWirePort()).toBe(PG_PORT);
  });
});
