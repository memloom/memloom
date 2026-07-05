import { describe, expect, it } from "vitest";
import { VERSION } from "./index.js";

describe("package", () => {
  it("exposes a version", () => {
    expect(VERSION).toBe("0.0.0");
  });
});
