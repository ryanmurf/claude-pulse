import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { initDb, closeDb, addProfile } from "../src/store.js";
import { startHttpServer, stopHttpServer } from "../src/server.js";

let tmpDir: string;
let port: number;

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

async function fetchJson(pathname: string): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
      return await response.json();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-server-test-"));
  initDb(path.join(tmpDir, "test.db"));
  port = await getFreePort();
  startHttpServer(port);
});

afterEach(() => {
  stopHttpServer();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/profiles", () => {
  it("redacts stored profile API keys", async () => {
    addProfile("with-key", "/tmp/with-key", 5, "deepseek-balance", 10, "sk-secret");

    const profiles = await fetchJson("/api/profiles");

    expect(profiles).toEqual([
      expect.objectContaining({
        name: "with-key",
        api_key: "***",
      }),
    ]);
  });
});
