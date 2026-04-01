import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import os from "node:os";

const execFileAsync = promisify(execFile);

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string;
  rateLimitTier: string;
}

interface KeychainCredentials {
  claudeAiOauth?: OAuthTokens;
  [key: string]: unknown;
}

function log(msg: string): void {
  process.stderr.write(`[claude-pulse] ${new Date().toISOString()} ${msg}\n`);
}

function configDirHash(configDir: string): string {
  return createHash("sha256").update(configDir).digest("hex").slice(0, 8);
}

/**
 * Read OAuth credentials from the macOS Keychain.
 * Claude Code stores credentials under service "Claude Code-credentials-{sha256(configDir)[:8]}".
 */
async function readFromMacKeychain(configDir: string): Promise<OAuthTokens | null> {
  if (process.platform !== "darwin") return null;

  const hash = configDirHash(configDir);
  const service = `Claude Code-credentials-${hash}`;
  const account = os.userInfo().username;

  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s", service,
      "-a", account,
      "-w",
    ]);

    const creds: KeychainCredentials = JSON.parse(stdout.trim());
    if (!creds.claudeAiOauth?.accessToken) {
      log(`No OAuth tokens in keychain for ${configDir} (service: ${service})`);
      return null;
    }
    return creds.claudeAiOauth;
  } catch (err) {
    log(`Failed to read keychain for ${configDir} (service: ${service}): ${err}`);
    return null;
  }
}

/**
 * Get OAuth tokens for a config dir.
 * Reads fresh from the keychain each time — the CLI handles token refresh,
 * so the keychain stays up-to-date as long as a session is active.
 */
export async function getOAuthTokens(configDir: string): Promise<OAuthTokens | null> {
  const tokens = await readFromMacKeychain(configDir);
  if (!tokens) return null;

  if (tokens.expiresAt < Date.now()) {
    log(`OAuth token expired for ${configDir} (expired ${new Date(tokens.expiresAt).toISOString()}), will attempt request anyway`);
  }

  return tokens;
}

export function hasProfileScope(tokens: OAuthTokens): boolean {
  return tokens.scopes?.includes("user:profile") ?? false;
}

export function hasInferenceScope(tokens: OAuthTokens): boolean {
  return tokens.scopes?.includes("user:inference") ?? false;
}
