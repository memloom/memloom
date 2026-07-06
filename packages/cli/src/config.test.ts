import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, dataDir, ensureConfig, loadConfigEnv, memloomHome } from "./config.js";

describe("config", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "memloom-config-"));
    process.env.MEMLOOM_HOME = home;
    delete process.env.TEST_MEMLOOM_KEY;
  });

  afterEach(() => {
    delete process.env.MEMLOOM_HOME;
    delete process.env.TEST_MEMLOOM_KEY;
    rmSync(home, { recursive: true, force: true });
  });

  it("layout: data/ under the home, config.env beside it", () => {
    expect(dataDir()).toBe(join(memloomHome(), "data"));
    expect(configPath()).toBe(join(memloomHome(), "config.env"));
  });

  it("ensureConfig writes a template once and never overwrites", () => {
    const path = ensureConfig();
    expect(existsSync(path)).toBe(true);
    writeFileSync(path, "TEST_MEMLOOM_KEY=from-file\n");
    ensureConfig(); // must not clobber
    loadConfigEnv();
    expect(process.env.TEST_MEMLOOM_KEY).toBe("from-file");
  });

  it("parses comments, blanks, and quoted values; real env wins", () => {
    ensureConfig();
    writeFileSync(
      configPath(),
      '# comment\n\nTEST_MEMLOOM_KEY="quoted-value"\nMALFORMED LINE\n=nokey\n',
    );
    process.env.TEST_MEMLOOM_KEY = "from-env";
    loadConfigEnv();
    expect(process.env.TEST_MEMLOOM_KEY).toBe("from-env"); // env precedence

    delete process.env.TEST_MEMLOOM_KEY;
    loadConfigEnv();
    expect(process.env.TEST_MEMLOOM_KEY).toBe("quoted-value"); // file value, quotes stripped
  });
});
