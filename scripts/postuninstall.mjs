#!/usr/bin/env node
/**
 * Postuninstall script for failproofai.
 * Automatically cleans up failproofai hook entries from Claude Code & CLI settings files
 * when `npm uninstall -g failproofai` or `bun remove -g failproofai` is executed.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

function isFailproofaiHook(hook) {
  if (!hook || typeof hook !== "object") return false;
  if (hook.is_failproofai === true || hook.__failproofai_hook === true) return true;
  const cmd = typeof hook.command === "string" ? hook.command : "";
  return cmd.includes("failproofai") && cmd.includes("--hook");
}

export function cleanClaudeSettings(settingsPath) {
  if (!existsSync(settingsPath)) return 0;
  try {
    const raw = readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw);
    if (!settings.hooks) return 0;

    let removed = 0;
    for (const eventType of Object.keys(settings.hooks)) {
      const matchers = settings.hooks[eventType];
      if (!Array.isArray(matchers)) continue;
      for (let i = matchers.length - 1; i >= 0; i--) {
        const matcher = matchers[i];
        if (!matcher.hooks) continue;
        const before = matcher.hooks.length;
        matcher.hooks = matcher.hooks.filter((h) => !isFailproofaiHook(h));
        removed += before - matcher.hooks.length;
        if (matcher.hooks.length === 0) matchers.splice(i, 1);
      }
      if (matchers.length === 0) delete settings.hooks[eventType];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    return removed;
  } catch {
    return 0;
  }
}

try {
  const userClaudePath = resolve(homedir(), ".claude", "settings.json");
  const projectClaudePath = resolve(process.cwd(), ".claude", "settings.json");
  const localClaudePath = resolve(process.cwd(), ".claude", "settings.local.json");

  let count = 0;
  count += cleanClaudeSettings(userClaudePath);
  count += cleanClaudeSettings(projectClaudePath);
  count += cleanClaudeSettings(localClaudePath);

  if (count > 0) {
    console.log(`[failproofai] Postuninstall: Cleaned up ${count} hook entry(ies) from Claude settings.`);
  }
} catch {
  // Fail-open: postuninstall script must never throw
}
