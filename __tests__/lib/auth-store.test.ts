// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteAuth,
  getAuthFilePath,
  readAuth,
  writeAuth,
  type StoredAuth,
} from "../../lib/auth/auth-store";

function fakeAuth(overrides: Partial<StoredAuth> = {}): StoredAuth {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: "access.jwt.token",
    refresh_token: "refresh.jwt.token",
    access_expires_at: now + 3600,
    refresh_expires_at: now + 86400,
    user: { id: "user-1", email: "alice@example.com" },
    ...overrides,
  };
}

describe("auth-store", () => {
  let dir: string;
  let originalAuthDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fpa-auth-test-"));
    originalAuthDir = process.env.FAILPROOFAI_AUTH_DIR;
    process.env.FAILPROOFAI_AUTH_DIR = dir;
  });

  afterEach(() => {
    if (originalAuthDir === undefined) delete process.env.FAILPROOFAI_AUTH_DIR;
    else process.env.FAILPROOFAI_AUTH_DIR = originalAuthDir;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe("auth", () => {
    it("returns null when no auth file exists", () => {
      expect(readAuth()).toBeNull();
    });

    it("round-trips a written auth file", () => {
      const auth = fakeAuth();
      writeAuth(auth);
      const out = readAuth();
      expect(out).not.toBeNull();
      expect(out?.user).toEqual(auth.user);
      expect(out?.access_token).toBe(auth.access_token);
    });

    it("rejects shape mismatches as null", () => {
      writeFileSync(getAuthFilePath(), JSON.stringify({ foo: 1 }), "utf-8");
      expect(readAuth()).toBeNull();
    });

    it("returns null on corrupt JSON", () => {
      writeFileSync(getAuthFilePath(), "{ not json", "utf-8");
      expect(readAuth()).toBeNull();
    });

    it("writes mode 0600 on the file", () => {
      writeAuth(fakeAuth());
      const mode = statSync(getAuthFilePath()).mode & 0o777;
      // World-readable bit must be cleared.
      expect(mode & 0o004).toBe(0);
      // Group-read also cleared.
      expect(mode & 0o040).toBe(0);
    });

    it("atomic write leaves no .tmp siblings behind on success", () => {
      writeAuth(fakeAuth());
      const leftover = readdirSync(dir).filter((f) => f.includes(".tmp"));
      expect(leftover).toEqual([]);
    });

    it("deleteAuth removes the file", () => {
      writeAuth(fakeAuth());
      expect(existsSync(getAuthFilePath())).toBe(true);
      deleteAuth();
      expect(existsSync(getAuthFilePath())).toBe(false);
    });

    it("backfills refresh_expires_at when omitted from the legacy file", () => {
      const now = Math.floor(Date.now() / 1000);
      writeFileSync(getAuthFilePath(), JSON.stringify({
        access_token: "a",
        refresh_token: "r",
        access_expires_at: now + 100,
        user: { id: "u", email: "e@e.com" },
      }), "utf-8");
      const out = readAuth();
      // Falls back to access_expires_at when the file pre-dated the field.
      expect(out?.refresh_expires_at).toBe(now + 100);
    });
  });

});
