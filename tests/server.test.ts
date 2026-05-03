import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { startHttpServer, stopHttpServer } from "../src/server.js";
import { initDb, closeDb, addProfile, listProfiles, ensureDefaultProfiles } from "../src/store.js";
import fetch from "node-fetch";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Profile } from "../src/types.js";

let tmpDir: string;
const PORT = 7779; // Use a different port than default to avoid conflicts

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-test-server-"));
  const dbPath = path.join(tmpDir, "test.db");
  initDb(dbPath);
  startHttpServer(PORT);
});

afterAll(() => {
  stopHttpServer();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/profiles", () => {
  it("returns profiles with redacted api_key", async () => {
    addProfile("test-profile", "/tmp/test", 5, "deepseek-balance", 10, "sk-12345");

    const response = await fetch(`http://localhost:${PORT}/api/profiles`);
    const profiles = (await response.json()) as Profile[];

    expect(response.status).toBe(200);
    expect(profiles).toBeInstanceOf(Array);

    const testProfile = profiles.find((p) => p.name === "test-profile");
    expect(testProfile).toBeDefined();
    expect(testProfile?.api_key).toBe("***");
  });

  it("returns profiles with null api_key for profiles without one", async () => {
    ensureDefaultProfiles(); // these have null api_key by default

    const response = await fetch(`http://localhost:${PORT}/api/profiles`);
    const profiles = (await response.json()) as Profile[];

    expect(response.status).toBe(200);
    const defaultProfile = profiles.find(p => p.name === 'claude-hd');
    expect(defaultProfile).toBeDefined();
    expect(defaultProfile?.api_key).toBeNull();
  });
});
