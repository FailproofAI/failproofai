// GENERATED — do not edit. Built from src/policy-runtime/sealed-entry.ts
// by scripts/build-sealed-bundle.ts. Regenerate: bun scripts/build-sealed-bundle.ts
// --- sealed prelude (see scripts/build-sealed-bundle.ts) ---
var process = Object.freeze({ env: Object.freeze(Object.create(null)) });
// --- end sealed prelude ---
(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  function __accessProp(key) {
    return this[key];
  }
  var __toCommonJS = (from) => {
    var entry = (__moduleCache ??= new WeakMap).get(from), desc;
    if (entry)
      return entry;
    entry = __defProp({}, "__esModule", { value: true });
    if (from && typeof from === "object" || typeof from === "function") {
      for (var key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(entry, key))
          __defProp(entry, key, {
            get: __accessProp.bind(from, key),
            enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
          });
    }
    __moduleCache.set(from, entry);
    return entry;
  };
  var __moduleCache;
  var __returnValue = (v) => v;
  function __exportSetter(name, newValue) {
    this[name] = __returnValue.bind(null, newValue);
  }
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, {
        get: all[name],
        enumerable: true,
        configurable: true,
        set: __exportSetter.bind(all, name)
      });
  };

  // src/policy-runtime/sealed-entry.ts
  var exports_sealed_entry = {};
  __export(exports_sealed_entry, {
    sealedPolicyNames: () => sealedPolicyNames,
    installSealedGlobals: () => installSealedGlobals,
    evaluate: () => evaluate
  });

  // src/hooks/policy-registry.ts
  var REGISTRY_KEY = "__FAILPROOFAI_POLICY_REGISTRY__";
  var INDEX_CACHE_KEY = "__FAILPROOFAI_POLICY_INDEX_CACHE__";
  var DEFAULT_POLICY_NAMESPACE = "failproofai";
  function normalizePolicyName(name) {
    return name.includes("/") ? name : `${DEFAULT_POLICY_NAMESPACE}/${name}`;
  }
  function getIndexCache() {
    return globalThis[INDEX_CACHE_KEY];
  }
  function setIndexCache(cache) {
    globalThis[INDEX_CACHE_KEY] = cache;
  }
  function getRegistry() {
    const g = globalThis;
    if (!g[REGISTRY_KEY]) {
      g[REGISTRY_KEY] = [];
    }
    return g[REGISTRY_KEY];
  }
  function registerPolicy(name, description, fn, match, priority = 0) {
    const canonical = normalizePolicyName(name);
    const registry = getRegistry();
    const idx = registry.findIndex((p) => p.name === canonical);
    const entry = { name: canonical, description, fn, match, priority };
    if (idx >= 0) {
      registry[idx] = entry;
    } else {
      registry.push(entry);
    }
    setIndexCache(null);
  }
  function getPoliciesForEvent(eventType, toolName) {
    let cache = getIndexCache();
    if (!cache) {
      cache = new Map;
      setIndexCache(cache);
    }
    const key = `${eventType}:${toolName ?? ""}`;
    const cached = cache.get(key);
    if (cached)
      return cached;
    const result = getRegistry().filter((p) => {
      if (p.match.events && p.match.events.length > 0) {
        if (!p.match.events.includes(eventType))
          return false;
      }
      if (p.match.toolNames && p.match.toolNames.length > 0) {
        if (!toolName || !p.match.toolNames.includes(toolName))
          return false;
      }
      return true;
    }).sort((a, b) => b.priority - a.priority);
    cache.set(key, result);
    return result;
  }
  function clearPolicies() {
    const g = globalThis;
    g[REGISTRY_KEY] = [];
    setIndexCache(null);
  }

  // src/policy-runtime/host-stubs.ts
  class SealedCapabilityError extends Error {
    capability;
    constructor(capability) {
      super(`failproofai sealed tier: '${capability}' is not available. ` + `The sealed execution tier has no filesystem, subprocess, or network access. ` + `A policy needing one of those is routed to the user-context tier at admission; ` + `reaching this error means something bypassed that routing.`);
      this.name = "SealedCapabilityError";
      this.capability = capability;
    }
  }
  function forbid(capability) {
    return () => {
      throw new SealedCapabilityError(capability);
    };
  }
  var homedir = forbid("os.homedir");
  var tmpdir = forbid("os.tmpdir");
  var userInfo = forbid("os.userInfo");
  var hostname = forbid("os.hostname");
  var platform = forbid("os.platform");
  var execSync = forbid("child_process.execSync");
  var execFileSync = forbid("child_process.execFileSync");
  var exec = forbid("child_process.exec");
  var execFile = forbid("child_process.execFile");
  var spawn = forbid("child_process.spawn");
  var spawnSync = forbid("child_process.spawnSync");
  var readFile = forbid("fs.readFile");
  var writeFile = forbid("fs.writeFile");
  var readFileSync = forbid("fs.readFileSync");
  var writeFileSync = forbid("fs.writeFileSync");
  var appendFileSync = forbid("fs.appendFileSync");
  var renameSync = forbid("fs.renameSync");
  var mkdirSync = forbid("fs.mkdirSync");
  var existsSync = forbid("fs.existsSync");
  var statSync = forbid("fs.statSync");
  var stat = forbid("fs.stat");
  var open = forbid("fs.open");
  var openSync = forbid("fs.openSync");
  var readSync = forbid("fs.readSync");
  var closeSync = forbid("fs.closeSync");
  var readdirSync = forbid("fs.readdirSync");
  var unlinkSync = forbid("fs.unlinkSync");
  var rmSync = forbid("fs.rmSync");

  // src/policy-runtime/runtime-stubs.ts
  function hookLogInfo(_msg) {}
  function hookLogWarn(_msg) {}
  async function trackHookEvent(_distinctId, _event, _properties) {}
  function getInstanceId() {
    return "sealed-worker";
  }

  // src/hooks/builtin/warn.ts
  var noop = () => {};
  var sink = noop;
  function setPolicyWarnSink(fn) {
    sink = fn;
  }
  function policyWarn(message) {
    sink(message);
  }

  // src/hooks/builtin/host-context.ts
  var inertFallback = {
    home: () => "",
    projectDir: () => {
      return;
    }
  };
  var fallback = inertFallback;
  function setHostContextFallback(next) {
    fallback = next;
  }
  function resolveHome(ctx) {
    const fromRequest = ctx.session?.home;
    if (typeof fromRequest === "string" && fromRequest !== "")
      return fromRequest;
    return fallback.home();
  }
  function resolveProjectDir(ctx) {
    const fromRequest = ctx.session?.projectDir;
    if (fromRequest)
      return fromRequest;
    return fallback.projectDir() || undefined;
  }

  // src/policy-runtime/pure-path.ts
  var SEALED_CWD = "/";
  function normalizeString(path, allowAboveRoot) {
    let res = "";
    let lastSegmentLength = 0;
    let lastSlash = -1;
    let dots = 0;
    let code = 0;
    for (let i = 0;i <= path.length; ++i) {
      if (i < path.length) {
        code = path.charCodeAt(i);
      } else if (code === 47) {
        break;
      } else {
        code = 47;
      }
      if (code === 47) {
        if (lastSlash === i - 1 || dots === 1) {} else if (dots === 2) {
          if (res.length < 2 || lastSegmentLength !== 2 || res.charCodeAt(res.length - 1) !== 46 || res.charCodeAt(res.length - 2) !== 46) {
            if (res.length > 2) {
              const lastSlashIndex = res.lastIndexOf("/");
              if (lastSlashIndex === -1) {
                res = "";
                lastSegmentLength = 0;
              } else {
                res = res.slice(0, lastSlashIndex);
                lastSegmentLength = res.length - 1 - res.lastIndexOf("/");
              }
              lastSlash = i;
              dots = 0;
              continue;
            } else if (res.length !== 0) {
              res = "";
              lastSegmentLength = 0;
              lastSlash = i;
              dots = 0;
              continue;
            }
          }
          if (allowAboveRoot) {
            res += res.length > 0 ? "/.." : "..";
            lastSegmentLength = 2;
          }
        } else {
          if (res.length > 0) {
            res += `/${path.slice(lastSlash + 1, i)}`;
          } else {
            res = path.slice(lastSlash + 1, i);
          }
          lastSegmentLength = i - lastSlash - 1;
        }
        lastSlash = i;
        dots = 0;
      } else if (code === 46 && dots !== -1) {
        ++dots;
      } else {
        dots = -1;
      }
    }
    return res;
  }
  function resolve(...args) {
    let resolvedPath = "";
    let resolvedAbsolute = false;
    for (let i = args.length - 1;i >= 0 && !resolvedAbsolute; i--) {
      const path = args[i];
      if (typeof path !== "string") {
        throw new TypeError(`Path must be a string. Received ${JSON.stringify(path)}`);
      }
      if (path.length === 0)
        continue;
      resolvedPath = `${path}/${resolvedPath}`;
      resolvedAbsolute = path.charCodeAt(0) === 47;
    }
    if (!resolvedAbsolute) {
      resolvedPath = `${SEALED_CWD}/${resolvedPath}`;
    }
    resolvedPath = normalizeString(resolvedPath, false);
    return resolvedPath.length > 0 ? `/${resolvedPath}` : "/";
  }
  function join(...args) {
    if (args.length === 0)
      return ".";
    let joined;
    for (let i = 0;i < args.length; ++i) {
      const arg = args[i];
      if (typeof arg !== "string") {
        throw new TypeError(`Path must be a string. Received ${JSON.stringify(arg)}`);
      }
      if (arg.length > 0) {
        if (joined === undefined)
          joined = arg;
        else
          joined += `/${arg}`;
      }
    }
    if (joined === undefined)
      return ".";
    return normalize(joined);
  }
  function normalize(path) {
    if (path.length === 0)
      return ".";
    const isAbsolute = path.charCodeAt(0) === 47;
    const trailingSeparator = path.charCodeAt(path.length - 1) === 47;
    let normalized = normalizeString(path, !isAbsolute);
    if (normalized.length === 0) {
      if (isAbsolute)
        return "/";
      return trailingSeparator ? "./" : ".";
    }
    if (trailingSeparator)
      normalized += "/";
    return isAbsolute ? `/${normalized}` : normalized;
  }

  // src/hooks/policy-helpers.ts
  function allow(reason) {
    return reason ? { decision: "allow", reason } : { decision: "allow" };
  }
  function deny(reason) {
    return { decision: "deny", reason };
  }
  function instruct(reason) {
    return { decision: "instruct", reason };
  }

  // src/hooks/builtin/shared.ts
  function getCommand(ctx) {
    return ctx.toolInput?.command ?? "";
  }
  function getFilePath(ctx) {
    return ctx.toolInput?.file_path ?? "";
  }
  function parseArgvTokens(cmd) {
    return cmd.trim().split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, ""));
  }
  var SHELL_OPERATORS = new Set(["&&", "||", "|", ";"]);
  var SHELL_METACHAR_RE = /[;&<>`$()\\]/;
  function matchesAllowedPattern(cmd, pattern) {
    const cmdTokens = parseArgvTokens(cmd);
    const patTokens = parseArgvTokens(pattern);
    if (cmdTokens.length < patTokens.length)
      return false;
    if (cmdTokens.some((tok) => SHELL_OPERATORS.has(tok)))
      return false;
    if (cmdTokens.some((tok) => SHELL_METACHAR_RE.test(tok)))
      return false;
    return patTokens.every((tok, i) => tok === "*" || tok === cmdTokens[i]);
  }
  function shellSegments(cmd) {
    return cmd.split(/&&|\|\||[|;\n]/).map((s) => s.trim()).filter((s) => s !== "");
  }

  // src/hooks/builtin/payload-only.ts
  function isAgentInternalPath(resolved, home) {
    const normResolved = resolved.replaceAll("\\", "/");
    for (const dir of [".claude", ".codex", ".copilot", ".cursor", ".opencode", ".pi", ".gemini"]) {
      const root = join(home, dir).replaceAll("\\", "/");
      if (normResolved === root || normResolved.startsWith(root + "/"))
        return true;
    }
    for (const sub of [join(".config", "opencode"), join(".local", "share", "opencode")]) {
      const root = join(home, sub).replaceAll("\\", "/");
      if (normResolved === root || normResolved.startsWith(root + "/"))
        return true;
    }
    return false;
  }
  function isAgentSettingsFile(resolved) {
    if (/[\\/]\.claude[\\/]settings(?:\.[^/\\]+)?\.json$/.test(resolved))
      return true;
    if (/[\\/]\.codex[\\/]hooks\.json$/.test(resolved))
      return true;
    if (/[\\/]\.copilot[\\/]hooks[\\/][^/\\]+\.json$/.test(resolved))
      return true;
    if (/[\\/]\.github[\\/]hooks[\\/][^/\\]+\.json$/.test(resolved))
      return true;
    if (/[\\/]\.cursor[\\/]hooks\.json$/.test(resolved))
      return true;
    if (/[\\/]\.opencode[\\/]opencode\.jsonc?$/.test(resolved))
      return true;
    if (/[\\/]\.opencode[\\/]plugins[\\/][^/\\]+\.(?:mjs|js|ts)$/.test(resolved))
      return true;
    if (/[\\/]\.config[\\/]opencode[\\/]opencode\.jsonc?$/.test(resolved))
      return true;
    if (/[\\/]\.config[\\/]opencode[\\/]config\.json$/.test(resolved))
      return true;
    if (/[\\/]\.config[\\/]opencode[\\/]plugins[\\/][^/\\]+\.(?:mjs|js|ts)$/.test(resolved))
      return true;
    if (/[\\/]\.pi[\\/](?:agent[\\/])?settings\.json$/.test(resolved))
      return true;
    if (/[\\/]\.pi[\\/](?:agent[\\/])?extensions[\\/]/.test(resolved))
      return true;
    if (/[\\/]\.gemini[\\/]settings\.json$/.test(resolved))
      return true;
    if (/[\\/]\.gemini[\\/]config[\\/]hooks\.json$/.test(resolved))
      return true;
    return false;
  }
  var isClaudeInternalPath = isAgentInternalPath;
  var isClaudeSettingsFile = isAgentSettingsFile;
  var JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
  var API_KEY_PATTERNS = [
    [/sk-ant-[A-Za-z0-9\-_]{20,}/, "Anthropic API key"],
    [/sk-proj-[A-Za-z0-9\-_]{20,}/, "OpenAI project API key"],
    [/sk-[A-Za-z0-9]{20,}/, "OpenAI API key"],
    [/ghp_[A-Za-z0-9]{36}/, "GitHub personal access token"],
    [/github_pat_[A-Za-z0-9_]{82}/, "GitHub fine-grained token"],
    [/AKIA[A-Z0-9]{16}/, "AWS access key ID"],
    [/sk_live_[A-Za-z0-9]{24,}/, "Stripe live secret key"],
    [/sk_test_[A-Za-z0-9]{24,}/, "Stripe test secret key"],
    [/AIza[0-9A-Za-z\-_]{35}/, "Google API key"]
  ];
  var CONNECTION_STRING_RE = /(?:postgresql|postgres|mysql|mongodb(?:\+srv)?|redis|amqps?|smtps?):\/\/[^@\s]+@/;
  var PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;
  var BEARER_TOKEN_RE = /Authorization:\s*Bearer\s+[A-Za-z0-9\-._~+/]{20,}/i;
  var SQL_TOOL_RE = /\b(?:psql|mysql|sqlite3|pgcli|clickhouse-client)\b/;
  var DESTRUCTIVE_SQL_RE = /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\b)/i;
  var DELETE_NO_WHERE_RE = /\bDELETE\s+FROM\b/i;
  var SQL_WHERE_RE = /\bWHERE\b/i;
  var SCHEMA_ALTER_RE = /\bALTER\s+TABLE\b[\s\S]*\b(?:DROP\s+COLUMN|ADD\s+COLUMN|RENAME\s+(?:COLUMN|TO)|MODIFY\s+COLUMN)\b/i;
  var PUBLISH_CMD_RE = /(?:npm\s+publish|bun\s+publish|pnpm\s+publish|yarn\s+npm\s+publish|twine\s+upload|poetry\s+publish|cargo\s+publish|gem\s+push)\b/;
  var ENV_PRINTENV_RE = /(?:^|\s|;|&&|\|\|)(?:env|printenv)(?:\s|$|;|&&|\|)/;
  var ECHO_ENV_RE = /echo\s+.*\$\{?[A-Za-z_]/;
  var EXPORT_RE = /(?:^|\s|;|&&|\|\|)export\s+\w+/;
  var PS_ENV_VAR_RE = /\$env:[A-Za-z_]/i;
  var PS_CHILDITEM_ENV_RE = /(?:Get-ChildItem|dir|gci|ls)\s+Env:/i;
  var DOTNET_GETENV_RE = /\[Environment\]::GetEnvironment/i;
  var CMD_ECHO_ENV_RE = /echo\s+%[A-Za-z_]/i;
  var ENV_FILE_PATH_RE = /(?:^|[\\/])\.env(?:\.|$)/;
  var ENV_CMD_RE = /\.env(?:\b|\s|$|\.)/;
  var SUDO_RE = /(?:^|;|&&|\|\|)\s*sudo\s/;
  var PS_ELEVATION_RE = /Start-Process\s+.*-Verb\s+RunAs/i;
  var RUNAS_RE = /(?:^|;|&&|\|\|)\s*runas\s/i;
  var CURL_PIPE_SH_RE = /(?:curl|wget)\s.*\|\s*(?:sh|bash|zsh|dash|ksh|csh|tcsh|fish|ash)\b/;
  var PS_WEB_PIPE_RE = /(?:Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\s+.*\|\s*(?:Invoke-Expression|iex)/i;
  var SHORT_FLAG_BUNDLE_RE = /^-[a-zA-Z]*f[a-zA-Z]*$/;
  var SAFE_FORCE_PREFIXES = ["--force-with-lease", "--force-if-includes"];
  var SECRET_FILE_RE = /\.(?:pem|key)$/;
  var SECRET_FILE_ID_RSA_RE = /id_rsa/;
  var SECRET_FILE_CREDENTIALS_RE = /credentials/;
  var FAILPROOFAI_CLI_RE = /(?:^|;|&&|\|\||\|)\s*failproofai(?:\s|$)/;
  var FAILPROOFAI_UNINSTALL_RE = /(?:npm\s+(?:uninstall|remove|un|r)\s.*failproofai|bun\s+remove\s.*failproofai|yarn\s+global\s+remove\s+failproofai|pnpm\s+(?:remove|uninstall|un)\s.*failproofai)/;
  var GIT_AMEND_RE = /\bgit\s+commit\b.*--amend\b/;
  var GIT_STASH_DROP_RE = /\bgit\s+stash\s+(?:drop|clear)\b/;
  var GIT_ADD_ALL_RE = /\bgit\s+add\s+(?:-A\b|--all\b|\.(?:\s|$|;|&&|\|\|))/;
  var NPM_GLOBAL_RE = /\bnpm\s+(?:install|i)\b(?=.*(?:\s-g\b|--global\b))/;
  var YARN_GLOBAL_RE = /\byarn\s+global\s+add\b/;
  var PNPM_GLOBAL_RE = /\bpnpm\s+(?:add|install|i)\b(?=.*(?:\s-g\b|--global\b))/;
  var BUN_GLOBAL_RE = /\bbun\s+(?:install|add)\b(?=.*(?:\s-g\b|--global\b))/;
  var CARGO_INSTALL_RE = /\bcargo\s+install\b/;
  var PIP_SYSTEM_RE = /\bpip(?:3)?\s+install\b(?=.*(?:--user\b|--break-system-packages\b))/;
  var PKG_MANAGER_DETECTORS = {
    pip: [/\bpip\b/, /\bpip3\b/, /\bpython3?\s+-m\s+pip\b/],
    npm: [/\bnpm\b/, /\bnpx\b/],
    yarn: [/\byarn\b/],
    pnpm: [/\bpnpm\b/, /\bpnpx\b/],
    bun: [/\bbun\b/, /\bbunx\b/],
    uv: [/\buv\b/],
    poetry: [/\bpoetry\b/],
    pipenv: [/\bpipenv\b/],
    conda: [/\bconda\b/],
    cargo: [/\bcargo\b/]
  };
  var NOHUP_RE = /\bnohup\s+\S/;
  var SCREEN_DETACH_RE = /\bscreen\s+-[A-Za-z]*d[A-Za-z]*\b/;
  var TMUX_DETACH_RE = /\btmux\s+(?:new-session|new)\b[^|&;]*-d\b/;
  var DISOWN_RE = /\bdisown\b/;
  var BACKGROUND_AMPERSAND_RE = /(?<![&|])\s?&\s*(?:$|#|;)/;
  var KUBECTL_RE = /(?:^|[;\n]|&&|\|\|?|&)\s*kubectl(?:\s|$)/;
  var TERRAFORM_RE = /(?:^|[;\n]|&&|\|\|?|&)\s*(?:terraform|tofu)(?:\s|$)/;
  var AWS_CLI_RE = /(?:^|[;\n]|&&|\|\|?|&)\s*aws(?:\s|$)/;
  var GCLOUD_RE = /(?:^|[;\n]|&&|\|\|?|&)\s*gcloud(?:\s|$)/;
  var AZ_CLI_RE = /(?:^|[;\n]|&&|\|\|?|&)\s*az(?:\s|$)/;
  var HELM_RE = /(?:^|[;\n]|&&|\|\|?|&)\s*helm(?:\s|$)/;
  var GH_PIPELINE_RE = /(?:^|[;\n]|&&|\|\|?|&)\s*gh\s+(?:workflow\s+(?:run|enable|disable)|run\s+(?:rerun|cancel)|pr\s+merge|release\s+(?:create|delete)|cache\s+delete|secret\s+(?:set|delete))\b/;
  function sanitizeJwt(ctx) {
    const output = JSON.stringify(ctx.payload);
    if (JWT_RE.test(output)) {
      return {
        decision: "deny",
        reason: "JWT token detected in tool output",
        message: "[REDACTED: JWT token removed by failproofai]"
      };
    }
    return allow();
  }
  function sanitizeApiKeys(ctx) {
    const output = JSON.stringify(ctx.payload);
    for (const [pattern, label] of API_KEY_PATTERNS) {
      if (pattern.test(output)) {
        return {
          decision: "deny",
          reason: `${label} detected in tool output`,
          message: `[REDACTED: ${label} removed by failproofai]`
        };
      }
    }
    const additional = ctx.params?.additionalPatterns ?? [];
    for (const { regex, label } of additional) {
      try {
        if (new RegExp(regex).test(output)) {
          return {
            decision: "deny",
            reason: `${label} detected in tool output`,
            message: `[REDACTED: ${label} removed by failproofai]`
          };
        }
      } catch {
        policyWarn(`additionalPatterns: invalid regex "${regex}", skipping`);
      }
    }
    return allow();
  }
  function sanitizeConnectionStrings(ctx) {
    const output = JSON.stringify(ctx.payload);
    if (CONNECTION_STRING_RE.test(output)) {
      return {
        decision: "deny",
        reason: "Database connection string with credentials detected in tool output",
        message: "[REDACTED: connection string removed by failproofai]"
      };
    }
    return allow();
  }
  function sanitizePrivateKeyContent(ctx) {
    const output = JSON.stringify(ctx.payload);
    if (PRIVATE_KEY_RE.test(output)) {
      return {
        decision: "deny",
        reason: "Private key content detected in tool output",
        message: "[REDACTED: private key content removed by failproofai]"
      };
    }
    return allow();
  }
  function sanitizeBearerTokens(ctx) {
    const output = JSON.stringify(ctx.payload);
    if (BEARER_TOKEN_RE.test(output)) {
      return {
        decision: "deny",
        reason: "Bearer token detected in tool output",
        message: "[REDACTED: Bearer token removed by failproofai]"
      };
    }
    return allow();
  }
  function warnDestructiveSql(ctx) {
    if (ctx.toolName !== "Bash")
      return allow();
    const cmd = getCommand(ctx);
    if (!SQL_TOOL_RE.test(cmd))
      return allow();
    if (DESTRUCTIVE_SQL_RE.test(cmd)) {
      return instruct("STOP: This command contains destructive SQL (DROP/TRUNCATE/DELETE). Confirm with the user before executing.");
    }
    if (DELETE_NO_WHERE_RE.test(cmd) && !SQL_WHERE_RE.test(cmd)) {
      return instruct("STOP: This command contains destructive SQL (DROP/TRUNCATE/DELETE). Confirm with the user before executing.");
    }
    return allow();
  }
  function warnLargeFileWrite(ctx) {
    if (ctx.toolName !== "Write")
      return allow();
    const content = ctx.toolInput?.content;
    if (typeof content !== "string")
      return allow();
    const thresholdKb = ctx.params?.thresholdKb ?? 1024;
    const thresholdBytes = thresholdKb * 1024;
    if (content.length > thresholdBytes) {
      return instruct(`STOP: You are writing a file larger than ${thresholdKb}KB (${Math.round(content.length / 1024)}KB). This is unusually large. Confirm this is intentional before proceeding.`);
    }
    return allow();
  }
  function warnPackagePublish(ctx) {
    if (ctx.toolName !== "Bash")
      return allow();
    const cmd = getCommand(ctx);
    if (PUBLISH_CMD_RE.test(cmd)) {
      return instruct("STOP: This command publishes a package to a public registry. Confirm with the user that this is intentional.");
    }
    return allow();
  }
  function protectEnvVars(ctx) {
    if (ctx.toolName !== "Bash")
      return allow();
    const cmd = getCommand(ctx);
    if (ENV_PRINTENV_RE.test(cmd)) {
      return deny("Command reads environment variables");
    }
    if (ECHO_ENV_RE.test(cmd)) {
      return deny("Command echoes environment variable");
    }
    if (EXPORT_RE.test(cmd)) {
      return deny("Command exports environment variable");
    }
    if (PS_ENV_VAR_RE.test(cmd)) {
      return deny("Command reads environment variable via PowerShell");
    }
    if (PS_CHILDITEM_ENV_RE.test(cmd)) {
      return deny("Command reads environment variables via PowerShell");
    }
    if (DOTNET_GETENV_RE.test(cmd)) {
      return deny("Command reads environment variable via .NET");
    }
    if (CMD_ECHO_ENV_RE.test(cmd)) {
      return deny("Command echoes environment variable via cmd");
    }
    return allow();
  }
  function blockEnvFiles(ctx) {
    const cmd = getCommand(ctx);
    const filePath = getFilePath(ctx);
    if (filePath && ENV_FILE_PATH_RE.test(filePath)) {
      return deny("Access to .env file blocked");
    }
    if (ctx.toolName === "Bash" && ENV_CMD_RE.test(cmd)) {
      return deny("Command references .env file");
    }
    return allow();
  }
  function blockSudo(ctx) {
    if (ctx.toolName !== "Bash")
      return allow();
    const cmd = getCommand(ctx).trimStart();
    if (SUDO_RE.test(cmd) || cmd.startsWith("sudo ")) {
      const allowPatterns = ctx.params?.allowPatterns ?? [];
      if (allowPatterns.some((p) => matchesAllowedPattern(cmd, p)))
        return allow();
      return deny("sudo commands are blocked");
    }
    if (PS_ELEVATION_RE.test(cmd)) {
      return deny("Elevated process launch is blocked");
    }
    if (RUNAS_RE.test(cmd)) {
      return deny("runas elevation is blocked");
    }
    return allow();
  }
  function blockCurlPipeSh(ctx) {
    if (ctx.toolName !== "Bash")
      return allow();
    const cmd = getCommand(ctx);
    if (CURL_PIPE_SH_RE.test(cmd)) {
      return deny("Piping downloads to shell is blocked");
    }
    if (PS_WEB_PIPE_RE.test(cmd)) {
      return deny("Piping downloads to Invoke-Expression is blocked");
    }
    return allow();
  }
  function extractGitPushArgs(cmd) {
    return cmd.split(/&&|\|\||[|;\n]/).map((s) => s.trim()).filter((s) => /^git\s+push\s/.test(s)).map((s) => s.replace(/^git\s+push\s+/, ""));
  }
  function blockPushMaster(ctx) {
    if (ctx.toolName !== "Bash")
      return allow();
    const protectedBranches = ctx.params?.protectedBranches ?? ["main", "master"];
    if (protectedBranches.length === 0)
      return allow();
    const args = extractGitPushArgs(getCommand(ctx));
    const branchPattern = new RegExp(`\\b(?:${protectedBranches.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`);
    if (args.some((a) => branchPattern.test(a))) {
      return deny(`Pushing to ${protectedBranches.join("/")} is blocked`);
    }
    return allow();
  }
  var HOME_PREFIX_RE = /^(?:~[A-Za-z0-9_.-]*|\$HOME|\$\{HOME\})(?=$|\/)/;
  var RM_CMD_RE = /^(?:\/\S*\/)?rm$/;
  var FIND_CMD_RE = /^(?:\/\S*\/)?find$/;
  var FIND_EXEC_RE = /^-(?:exec|execdir|ok|okdir)$/;
  var FIND_GLOBAL_OPT_RE = /^-(?:[HLP]|D|O\d*)$/;
  var FIND_EXPR_START_RE = /^(?:-|\\?[(!])/;
  var SCRATCH_ROOTS = ["/tmp", "/var/tmp"];
  var CATASTROPHIC_DEPTH = 2;
  function expandHomePrefix(path, home) {
    const m = path.match(/^(?:~|\$HOME|\$\{HOME\})(?=$|\/)/);
    return m ? home + path.slice(m[0].length) : path;
  }
  function stripTrailingGlob(path) {
    return path.replace(/\/\*$/, "").replace(/\/+$/, "");
  }
  function isCatastrophicTarget(token) {
    const raw = token.replace(/^['"]|['"]$/g, "");
    if (raw === "")
      return false;
    const homePrefix = raw.match(HOME_PREFIX_RE);
    if (!homePrefix && /^[$`]/.test(raw))
      return true;
    const belowRoot = homePrefix ? raw.slice(homePrefix[0].length) : raw.startsWith("/") ? raw : null;
    if (belowRoot === null)
      return false;
    const segments = stripTrailingGlob(belowRoot).split("/").filter(Boolean);
    if (!homePrefix && SCRATCH_ROOTS.some((r) => `/${segments.join("/")}`.startsWith(`${r}/`)))
      return false;
    return segments.length <= CATASTROPHIC_DEPTH;
  }
  function recursiveDeletionTargets(seg) {
    const tokens = parseArgvTokens(seg);
    const findIdx = tokens.findIndex((t) => FIND_CMD_RE.test(t));
    if (findIdx >= 0) {
      const expr = tokens.slice(findIdx + 1);
      const execIdx = expr.findIndex((t) => FIND_EXEC_RE.test(t));
      const deletes = expr.includes("-delete") || execIdx >= 0 && RM_CMD_RE.test(expr[execIdx + 1] ?? "");
      if (deletes) {
        let start = 0;
        while (start < expr.length && FIND_GLOBAL_OPT_RE.test(expr[start])) {
          start += expr[start] === "-D" ? 2 : 1;
        }
        const rest = expr.slice(start);
        const end = rest.findIndex((t) => FIND_EXPR_START_RE.test(t));
        return end < 0 ? rest : rest.slice(0, end);
      }
    }
    const rmIdx = tokens.findIndex((t) => RM_CMD_RE.test(t));
    if (rmIdx >= 0) {
      const args = tokens.slice(rmIdx + 1);
      const shortFlags = args.filter((t) => /^-[^-]/.test(t)).join("");
      const longFlags = args.filter((t) => /^--/.test(t));
      const recursive = /r/i.test(shortFlags) || longFlags.some((f) => /^--recursive$/i.test(f));
      const force = /f/.test(shortFlags) || longFlags.some((f) => /^--force$/i.test(f));
      if (recursive && force)
        return args.filter((t) => !t.startsWith("-"));
    }
    return null;
  }
  function deletionTargetIsAllowed(cmd, allowPaths, home) {
    if (allowPaths.length === 0)
      return false;
    const normalizedAllowPaths = allowPaths.map((p) => stripTrailingGlob(expandHomePrefix(p, home)) || "/");
    let sawRecursiveDelete = false;
    for (const seg of shellSegments(cmd)) {
      const targets = recursiveDeletionTargets(seg);
      if (targets === null)
        continue;
      sawRecursiveDelete = true;
      for (const target of targets) {
        const normalized = stripTrailingGlob(expandHomePrefix(target, home)) || "/";
        const covered = normalizedAllowPaths.some((np) => normalized === np || normalized.startsWith(np + "/"));
        if (!covered) {
          const segCovered = allowPaths.some((p) => {
            const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            return new RegExp(`${escaped}(?:[/"'\\s/*]|$)`).test(seg);
          });
          if (!segCovered)
            return false;
        }
      }
    }
    return sawRecursiveDelete;
  }
  function blockRmRf(ctx) {
    if (ctx.toolName !== "Bash")
      return allow();
    const cmd = getCommand(ctx);
    const hasCatastrophicTarget = shellSegments(cmd).some((seg) => {
      const targets = recursiveDeletionTargets(seg);
      return targets !== null && targets.some(isCatastrophicTarget);
    });
    if (hasCatastrophicTarget) {
      const allowPaths = ctx.params?.allowPaths ?? [];
      if (deletionTargetIsAllowed(cmd, allowPaths, resolveHome(ctx)))
        return allow();
      return deny("Catastrophic deletion blocked");
    }
    if (/Remove-Item\s+.*-Recurse.*-Force.*(?:[A-Z]:\\(?:\s|$)|\\\*)/i.test(cmd)) {
      return deny("Catastrophic deletion blocked");
    }
    if (/(?:rd|rmdir)\s+\/s\s+\/q\s+[A-Z]:\\/i.test(cmd)) {
      return deny("Catastrophic deletion blocked");
    }
    return allow();
  }
  function blockForcePush(ctx) {
    if (ctx.toolName !== "Bash")
      return allow();
    for (const segment of extractGitPushArgs(getCommand(ctx))) {
      let sawEndOfOptions = false;
      for (const token of segment.split(/\s+/)) {
        if (token === "--") {
          sawEndOfOptions = true;
          continue;
        }
        if (sawEndOfOptions)
          continue;
        if (isForcePushFlag(token)) {
          return deny("Force-pushing is blocked");
        }
      }
    }
    return allow();
  }
  function isForcePushFlag(token) {
    if (token === "--force")
      return true;
    if (SAFE_FORCE_PREFIXES.some((prefix) => token.startsWith(prefix)))
      return false;
    if (token.startsWith("--force"))
      return true;
    return SHORT_FLAG_BUNDLE_RE.test(token);
  }
  function blockSecretsWrite(ctx) {
    if (ctx.toolName !== "Write")
      return allow();
    const filePath = getFilePath(ctx);
    if (SECRET_FILE_RE.test(filePath) || SECRET_FILE_ID_RSA_RE.test(filePath) || SECRET_FILE_CREDENTIALS_RE.test(filePath)) {
      return deny("Writing secret key files is blocked");
    }
    const additionalPatterns = ctx.params?.additionalPatterns ?? [];
    for (const pattern of additionalPatterns) {
      if (filePath.includes(pattern)) {
        return deny(`Writing blocked file pattern: ${pattern}`);
      }
    }
    return allow();
  }
  var READ_LIKE_CMDS = /(?:^|;|&&|\|\||\|)\s*(?:ls|find|cat|head|tail|less|more|wc|file|stat|tree|du)\s/;
  function extractAbsolutePaths(command, home) {
    const paths = [];
    const pathRe = /(?<![a-zA-Z0-9_.\-~\\*?:=])(?:~\/[^\s;|&"'()\[\]{}]*|~(?=\s|$|[;|&"'()\[\]{}])|\/[^\s;|&"'()\[\]{}]*)/g;
    function addPaths(s) {
      pathRe.lastIndex = 0;
      let m;
      while ((m = pathRe.exec(s)) !== null) {
        let p = m[0];
        if (p === "~")
          p = home;
        else if (p.startsWith("~/"))
          p = join(home, p.slice(2));
        paths.push(p);
      }
    }
    let firstBarePipe = command.length;
    let inDouble = false, inSingle = false;
    for (let i = 0;i < command.length; i++) {
      const c = command[i];
      if (c === '"' && !inSingle)
        inDouble = !inDouble;
      else if (c === "'" && !inDouble)
        inSingle = !inSingle;
      else if (c === "|" && !inDouble && !inSingle) {
        firstBarePipe = i;
        break;
      }
    }
    const firstSegment = command.slice(0, firstBarePipe);
    const quotedRe = /"([^"]*)"|'([^']*)'/g;
    let qm;
    while ((qm = quotedRe.exec(firstSegment)) !== null) {
      const content = qm[1] ?? qm[2] ?? "";
      if (/[*?\[\]^$+()\\]/.test(content))
        continue;
      addPaths(content);
    }
    const stripped = command.replace(/"[^"]*"/g, (m) => " ".repeat(m.length)).replace(/'[^']*'/g, (m) => " ".repeat(m.length));
    addPaths(stripped);
    return paths;
  }
  function blockReadOutsideCwd(ctx) {
    const cwd = resolveProjectDir(ctx) || ctx.session?.cwd;
    if (!cwd)
      return allow();
    const home = resolveHome(ctx);
    const allowPaths = ctx.params?.allowPaths ?? [];
    if (ctx.toolName === "Bash") {
      const cmd = getCommand(ctx);
      if (!READ_LIKE_CMDS.test(cmd))
        return allow();
      const paths = extractAbsolutePaths(cmd, home);
      const cwdWithSep2 = cwd.endsWith("/") ? cwd : cwd + "/";
      for (const p of paths) {
        const resolved2 = resolve(cwd, p);
        if (isClaudeSettingsFile(resolved2)) {
          return deny(`Reading agent settings file blocked: ${resolved2}`);
        }
        if (isClaudeInternalPath(resolved2, home))
          continue;
        if (resolved2 === "/dev/null")
          continue;
        if (resolved2 !== cwd && !resolved2.startsWith(cwdWithSep2)) {
          if (allowPaths.some((ap) => resolved2 === ap || resolved2.startsWith(ap.endsWith("/") ? ap : ap + "/")))
            continue;
          return deny(`Bash read outside project directory blocked: ${resolved2}`);
        }
      }
      return allow();
    }
    const filePath = getFilePath(ctx);
    const searchPath = ctx.toolInput?.path ?? "";
    const target = filePath || searchPath;
    if (!target)
      return allow();
    const resolved = resolve(cwd, target);
    if (isClaudeSettingsFile(resolved)) {
      return deny(`Reading agent settings file blocked: ${resolved}`);
    }
    if (isClaudeInternalPath(resolved, home))
      return allow();
    if (resolved === "/dev/null")
      return allow();
    const cwdWithSep = cwd.endsWith("/") ? cwd : cwd + "/";
    if (resolved !== cwd && !resolved.startsWith(cwdWithSep)) {
      if (allowPaths.some((ap) => resolved === ap || resolved.startsWith(ap.endsWith("/") ? ap : ap + "/")))
        return allow();
      return deny(`Access outside project directory blocked: ${resolved}`);
    }
    return allow();
  }
  function blockFailproofaiCommands(ctx) {
    if (ctx.toolName !== "Bash")
      return allow();
    const cmd = getCommand(ctx);
    if (FAILPROOFAI_CLI_RE.test(cmd)) {
      return deny("Running failproofai CLI commands is blocked");
    }
    if (FAILPROOFAI_UNINSTALL_RE.test(cmd)) {
      return deny("Uninstalling failproofai is blocked");
    }
    return allow();
  }
  function blockInfraCli(ctx, re, denyMsg) {
    if (ctx.toolName !== "Bash")
      return allow();
    const cmd = getCommand(ctx);
    if (!re.test(cmd))
      return allow();
    const allowPatterns = ctx.params?.allowPatterns ?? [];
    if (allowPatterns.some((p) => matchesAllowedPattern(cmd, p)))
      return allow();
    return deny(denyMsg);
  }
  function blockKubectl(ctx) {
    return blockInfraCli(ctx, KUBECTL_RE, "kubectl commands are blocked");
  }
  function blockTerraform(ctx) {
    return blockInfraCli(ctx, TERRAFORM_RE, "terraform/tofu commands are blocked");
  }
  function blockAwsCli(ctx) {
    return blockInfraCli(ctx, AWS_CLI_RE, "aws CLI commands are blocked");
  }
  function blockGcloud(ctx) {
    return blockInfraCli(ctx, GCLOUD_RE, "gcloud commands are blocked");
  }
  function blockAzCli(ctx) {
    return blockInfraCli(ctx, AZ_CLI_RE, "az (Azure) CLI commands are blocked");
  }
  function blockHelm(ctx) {
    return blockInfraCli(ctx, HELM_RE, "helm commands are blocked");
  }
  function blockGhPipeline(ctx) {
    return blockInfraCli(ctx, GH_PIPELINE_RE, "gh pipeline-trigger commands are blocked");
  }
  function warnGitAmend(ctx) {
    if (ctx.toolName !== "Bash")
      return allow();
    const cmd = getCommand(ctx);
    if (GIT_AMEND_RE.test(cmd)) {
      return instruct("STOP: This command amends the last commit, which rewrites git history. If this commit has already been pushed to a shared branch, this will cause divergence for other contributors. Confirm with the user before executing.");
    }
    return allow();
  }
  function warnGitStashDrop(ctx) {
    if (ctx.toolName !== "Bash")
      return allow();
    const cmd = getCommand(ctx);
    if (GIT_STASH_DROP_RE.test(cmd)) {
      return instruct("STOP: This command permanently deletes stashed changes (git stash drop/clear). Stash entries cannot be recovered after deletion. Confirm with the user before executing.");
    }
    return allow();
  }
  function warnAllFilesStaged(ctx) {
    if (ctx.toolName !== "Bash")
      return allow();
    const cmd = getCommand(ctx);
    if (GIT_ADD_ALL_RE.test(cmd)) {
      return instruct("STOP: This command stages all files in the working tree (git add -A / --all / .). This may inadvertently include build artifacts, generated files, or sensitive files not covered by .gitignore. Confirm with the user before executing.");
    }
    return allow();
  }
  function warnSchemaAlteration(ctx) {
    if (ctx.toolName !== "Bash")
      return allow();
    const cmd = getCommand(ctx);
    if (!SQL_TOOL_RE.test(cmd))
      return allow();
    if (SCHEMA_ALTER_RE.test(cmd)) {
      return instruct("STOP: This command contains a schema-altering SQL statement (ALTER TABLE with column or rename operation). Schema changes on production databases are irreversible or disruptive. Confirm with the user before executing.");
    }
    return allow();
  }
  function warnGlobalPackageInstall(ctx) {
    if (ctx.toolName !== "Bash")
      return allow();
    const cmd = getCommand(ctx);
    const isGlobal = NPM_GLOBAL_RE.test(cmd) || YARN_GLOBAL_RE.test(cmd) || PNPM_GLOBAL_RE.test(cmd) || BUN_GLOBAL_RE.test(cmd) || CARGO_INSTALL_RE.test(cmd) || PIP_SYSTEM_RE.test(cmd);
    if (isGlobal) {
      return instruct("STOP: This command installs a package globally, which modifies the system-wide environment outside the project. This can conflict with other projects or system tools. Confirm with the user before executing.");
    }
    return allow();
  }
  var SEGMENT_SPLIT_RE = /\s*(?:&&|\|\||\||;)\s*/;
  function preferPackageManager(ctx) {
    if (ctx.toolName !== "Bash")
      return allow();
    const cmd = getCommand(ctx);
    if (!cmd)
      return allow();
    const allowed = ctx.params?.allowed ?? [];
    if (allowed.length === 0)
      return allow();
    const allowedSet = new Set(allowed.map((a) => a.toLowerCase()));
    const blocked = ctx.params?.blocked ?? [];
    const allowedList = allowed.join(", ");
    const segments = cmd.split(SEGMENT_SPLIT_RE);
    for (const segment of segments) {
      const trimmed = segment.trim();
      if (!trimmed)
        continue;
      let segmentAllowed = false;
      for (const manager of allowedSet) {
        const patterns = PKG_MANAGER_DETECTORS[manager];
        if (!patterns)
          continue;
        for (const pattern of patterns) {
          if (pattern.test(trimmed)) {
            segmentAllowed = true;
            break;
          }
        }
        if (segmentAllowed)
          break;
      }
      if (segmentAllowed)
        continue;
      for (const [manager, patterns] of Object.entries(PKG_MANAGER_DETECTORS)) {
        if (allowedSet.has(manager))
          continue;
        for (const pattern of patterns) {
          if (pattern.test(trimmed)) {
            return deny(`"${manager}" is not an allowed package manager. ` + `Allowed package managers for this project: ${allowedList}. ` + `Rewrite this command using an allowed package manager.`);
          }
        }
      }
      for (const name of blocked) {
        const lower = name.toLowerCase();
        if (allowedSet.has(lower))
          continue;
        const re = new RegExp(`\\b${lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (re.test(trimmed)) {
          return deny(`"${lower}" is not an allowed package manager. ` + `Allowed package managers for this project: ${allowedList}. ` + `Rewrite this command using an allowed package manager.`);
        }
      }
    }
    return allow();
  }
  function warnBackgroundProcess(ctx) {
    if (ctx.toolName !== "Bash")
      return allow();
    const cmd = getCommand(ctx);
    const isBackground = NOHUP_RE.test(cmd) || SCREEN_DETACH_RE.test(cmd) || TMUX_DETACH_RE.test(cmd) || DISOWN_RE.test(cmd) || BACKGROUND_AMPERSAND_RE.test(cmd);
    if (isBackground) {
      return instruct("STOP: This command starts a background or detached process (nohup, screen -d, tmux -d, or trailing &). Background processes persist after Claude's session and may be difficult to track or stop. Confirm with the user before executing.");
    }
    return allow();
  }
  var PAYLOAD_ONLY_POLICIES = [
    { name: "sanitize-jwt", fn: sanitizeJwt },
    { name: "sanitize-api-keys", fn: sanitizeApiKeys },
    { name: "sanitize-connection-strings", fn: sanitizeConnectionStrings },
    { name: "sanitize-private-key-content", fn: sanitizePrivateKeyContent },
    { name: "sanitize-bearer-tokens", fn: sanitizeBearerTokens },
    { name: "protect-env-vars", fn: protectEnvVars },
    { name: "block-env-files", fn: blockEnvFiles },
    { name: "block-read-outside-cwd", fn: blockReadOutsideCwd },
    { name: "block-sudo", fn: blockSudo },
    { name: "block-curl-pipe-sh", fn: blockCurlPipeSh },
    { name: "block-rm-rf", fn: blockRmRf },
    { name: "block-failproofai-commands", fn: blockFailproofaiCommands },
    { name: "block-kubectl", fn: blockKubectl },
    { name: "block-terraform", fn: blockTerraform },
    { name: "block-aws-cli", fn: blockAwsCli },
    { name: "block-gcloud", fn: blockGcloud },
    { name: "block-az-cli", fn: blockAzCli },
    { name: "block-helm", fn: blockHelm },
    { name: "block-gh-pipeline", fn: blockGhPipeline },
    { name: "block-secrets-write", fn: blockSecretsWrite },
    { name: "block-push-master", fn: blockPushMaster },
    { name: "block-force-push", fn: blockForcePush },
    { name: "warn-git-amend", fn: warnGitAmend },
    { name: "warn-git-stash-drop", fn: warnGitStashDrop },
    { name: "warn-all-files-staged", fn: warnAllFilesStaged },
    { name: "warn-destructive-sql", fn: warnDestructiveSql },
    { name: "warn-schema-alteration", fn: warnSchemaAlteration },
    { name: "warn-package-publish", fn: warnPackagePublish },
    { name: "warn-global-package-install", fn: warnGlobalPackageInstall },
    { name: "prefer-package-manager", fn: preferPackageManager },
    { name: "warn-large-file-write", fn: warnLargeFileWrite },
    { name: "warn-background-process", fn: warnBackgroundProcess }
  ];

  // src/hooks/builtin/host-access.ts
  var GIT_COMMIT_MERGE_RE = /git\s+(commit|merge|rebase|cherry-pick)\b/;
  var gitBranchCache = new Map;
  function getCurrentBranch(cwd) {
    try {
      let branch = gitBranchCache.get(cwd);
      if (branch === undefined) {
        branch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 3000
        }).trim();
        gitBranchCache.set(cwd, branch);
      }
      return branch || null;
    } catch {
      return null;
    }
  }
  function getHeadSha(cwd) {
    try {
      const sha = execSync("git rev-parse HEAD", {
        cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 3000
      }).trim();
      return sha || null;
    } catch {
      return null;
    }
  }
  function getThirdPartyCheckRuns(cwd, sha) {
    try {
      const json = execFileSync("gh", [
        "api",
        `repos/{owner}/{repo}/commits/${sha}/check-runs`,
        "--jq",
        '.check_runs | map(select(.app.slug != "github-actions")) | map({name: .name, status: .status, conclusion: (.conclusion // "")})'
      ], {
        cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000
      }).trim();
      if (!json || json === "[]")
        return [];
      return JSON.parse(json);
    } catch {
      return [];
    }
  }
  function getCommitStatuses(cwd, sha) {
    try {
      const json = execFileSync("gh", [
        "api",
        `repos/{owner}/{repo}/commits/${sha}/statuses`,
        "--jq",
        "map({name: .context, state: .state}) | unique_by(.name)"
      ], {
        cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000
      }).trim();
      if (!json || json === "[]")
        return [];
      const statuses = JSON.parse(json);
      return statuses.map((s) => ({
        name: s.name,
        status: s.state === "pending" ? "in_progress" : "completed",
        conclusion: s.state === "pending" ? "" : s.state === "success" ? "success" : "failure"
      }));
    } catch {
      return [];
    }
  }
  function blockWorkOnMain(ctx) {
    if (ctx.toolName !== "Bash")
      return allow();
    const cmd = getCommand(ctx);
    const match = cmd.match(GIT_COMMIT_MERGE_RE);
    if (!match)
      return allow();
    const cwd = ctx.session?.cwd;
    if (!cwd)
      return allow();
    const branch = getCurrentBranch(cwd);
    if (!branch)
      return allow();
    const protectedBranches = ctx.params?.protectedBranches ?? ["main", "master"];
    if (protectedBranches.includes(branch)) {
      return deny(`Git ${match[1]} on ${branch} is blocked. Create a feature branch first.`);
    }
    return allow();
  }
  var TOOL_CALL_TRACKER_MAX_BYTES = 65536;
  async function warnRepeatedToolCalls(ctx) {
    const THRESHOLD = 3;
    const transcriptPath = ctx.session?.transcriptPath;
    if (!transcriptPath || !ctx.toolName || !ctx.toolInput)
      return allow();
    const trackerPath = `${transcriptPath}.tool-calls.json`;
    const fingerprint = JSON.stringify({ tool: ctx.toolName, input: ctx.toolInput });
    let counts = {};
    try {
      const raw = await readFile(trackerPath, "utf8");
      counts = JSON.parse(raw);
    } catch {}
    const prevCount = counts[fingerprint] ?? 0;
    if (prevCount >= THRESHOLD) {
      return instruct(`STOP: You have already called ${ctx.toolName} ${prevCount} times with identical parameters. This is wasteful and unproductive. Do NOT repeat this call — use a different approach or ask the user for clarification.`);
    }
    counts[fingerprint] = prevCount + 1;
    try {
      const serialized = JSON.stringify(counts);
      if (serialized.length <= TOOL_CALL_TRACKER_MAX_BYTES) {
        await writeFile(trackerPath, serialized, "utf8");
      }
    } catch {}
    return allow();
  }
  function isPlanMode(ctx) {
    return ctx.session?.permissionMode === "plan";
  }
  function requireCommitBeforeStop(ctx) {
    if (isPlanMode(ctx))
      return allow("Plan mode — no changes made, skipping commit check.");
    const cwd = ctx.session?.cwd;
    if (!cwd)
      return allow("No working directory available, skipping commit check.");
    try {
      const status = execSync("git status --porcelain", {
        cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000
      }).trim();
      if (status.length > 0) {
        return deny("You have uncommitted changes in the working directory. Commit all changes now.");
      }
      return allow("All changes are committed.");
    } catch {
      return allow("Not a git repository, skipping commit check.");
    }
  }
  function requirePushBeforeStop(ctx) {
    if (isPlanMode(ctx))
      return allow("Plan mode — no changes made, skipping push check.");
    const cwd = ctx.session?.cwd;
    if (!cwd)
      return allow("No working directory available, skipping push check.");
    try {
      const remotes = execSync("git remote", {
        cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 3000
      }).trim();
      if (!remotes)
        return allow("No git remote configured, skipping push check.");
      const remote = ctx.params?.remote ?? "origin";
      const branch = getCurrentBranch(cwd);
      if (!branch || branch === "HEAD")
        return allow("Detached HEAD, skipping push check.");
      const baseBranch = ctx.params?.baseBranch ?? "main";
      if (branch === baseBranch) {
        return allow(`On base branch "${baseBranch}", skipping push check.`);
      }
      try {
        const ahead = execFileSync("git", ["log", `${remote}/${baseBranch}..HEAD`, "--oneline"], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 }).trim();
        if (!ahead) {
          return allow(`No commits ahead of ${remote}/${baseBranch}, skipping push check.`);
        }
        const diff = execFileSync("git", ["diff", "--stat", `${remote}/${baseBranch}`, "HEAD"], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 }).trim();
        if (!diff) {
          return allow(`No file changes compared to ${remote}/${baseBranch}, skipping push check.`);
        }
      } catch {}
      let hasTracking = false;
      try {
        execFileSync("git", ["rev-parse", "--verify", `${remote}/${branch}`], {
          cwd,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 3000
        });
        hasTracking = true;
      } catch {}
      if (!hasTracking) {
        return deny(`Branch "${branch}" has not been pushed to remote "${remote}". ` + `Run now: git push -u ${remote} ${branch}`);
      }
      const unpushed = execFileSync("git", ["log", `${remote}/${branch}..HEAD`, "--oneline"], {
        cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000
      }).trim();
      if (unpushed.length > 0) {
        const commitCount = unpushed.split(`
`).length;
        return deny(`You have ${commitCount} unpushed commit${commitCount > 1 ? "s" : ""} on branch "${branch}". ` + `Run now: git push`);
      }
      return allow(`All commits pushed to "${remote}".`);
    } catch {
      return allow("Could not check push status, skipping.");
    }
  }
  function requirePrBeforeStop(ctx) {
    if (isPlanMode(ctx))
      return allow("Plan mode — no changes made, skipping PR check.");
    const cwd = ctx.session?.cwd;
    if (!cwd)
      return allow("No working directory available, skipping PR check.");
    try {
      try {
        execSync("gh --version", { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 });
      } catch {
        return allow("GitHub CLI (gh) not installed, skipping PR check.");
      }
      const branch = getCurrentBranch(cwd);
      if (!branch || branch === "HEAD")
        return allow("Detached HEAD, skipping PR check.");
      const baseBranch = ctx.params?.baseBranch ?? "main";
      if (branch === baseBranch) {
        return allow(`On base branch "${baseBranch}", skipping PR check.`);
      }
      try {
        const ahead = execFileSync("git", ["log", `origin/${baseBranch}..HEAD`, "--oneline"], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 }).trim();
        if (!ahead) {
          return allow(`No commits ahead of origin/${baseBranch}, skipping PR check.`);
        }
        const diff = execFileSync("git", ["diff", "--stat", `origin/${baseBranch}`, "HEAD"], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 }).trim();
        if (!diff) {
          return allow(`No file changes compared to origin/${baseBranch}, skipping PR check.`);
        }
      } catch {}
      let prJson;
      try {
        prJson = execSync("gh pr view --json number,url,state", {
          cwd,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 15000
        }).trim();
      } catch {
        return deny(`No pull request found for branch "${branch}". ` + `Run now: gh pr create`);
      }
      const pr = JSON.parse(prJson);
      if (pr.state === "OPEN") {
        return allow(`PR #${pr.number} exists: ${pr.url}`);
      }
      if (pr.state === "MERGED") {
        return allow(`PR #${pr.number} was merged: ${pr.url}. ` + `Switch off this branch (e.g. 'git checkout ${baseBranch} && git pull') before stopping again.`);
      }
      return deny(`Pull request for branch "${branch}" is ${pr.state.toLowerCase()}. Run now: gh pr create`);
    } catch {
      return allow("Could not check PR status, skipping.");
    }
  }
  function requireNoConflictsBeforeStop(ctx) {
    if (isPlanMode(ctx))
      return allow("Plan mode — no changes made, skipping conflict check.");
    const cwd = ctx.session?.cwd;
    if (!cwd)
      return allow("No working directory available, skipping conflict check.");
    const branch = getCurrentBranch(cwd);
    if (!branch || branch === "HEAD")
      return allow("Detached HEAD, skipping conflict check.");
    const baseBranch = ctx.params?.baseBranch ?? "main";
    if (branch === baseBranch) {
      return allow(`On base branch "${baseBranch}", skipping conflict check.`);
    }
    try {
      execSync("gh --version", { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 });
    } catch {
      return allow("gh CLI not installed, skipping conflict check.");
    }
    let prJson;
    try {
      prJson = execSync("gh pr view --json mergeable,number,url,state", {
        cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000
      }).trim();
    } catch {
      return allow("No pull request found for branch, skipping conflict check.");
    }
    let pr;
    try {
      pr = JSON.parse(prJson);
    } catch {
      return allow("Could not parse gh pr view output, skipping conflict check.");
    }
    if (pr.state !== "OPEN") {
      return allow(`PR #${pr.number} is ${pr.state.toLowerCase()}; skipping conflict check.`);
    }
    try {
      execFileSync("git", ["rev-parse", "--verify", `origin/${baseBranch}`], {
        cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 3000
      });
      const ahead = execFileSync("git", ["log", `origin/${baseBranch}..HEAD`, "--oneline"], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 }).trim();
      if (ahead) {
        execFileSync("git", ["merge-tree", "--write-tree", "--name-only", `origin/${baseBranch}`, "HEAD"], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 1e4 });
      }
    } catch (err) {
      const e = err;
      if (e.status === 1) {
        const out = (typeof e.stdout === "string" ? e.stdout : e.stdout?.toString("utf8") ?? "").trim();
        const lines = out.split(`
`);
        const files = [];
        for (let i = 1;i < lines.length; i++) {
          const line = lines[i];
          if (line === "")
            break;
          files.push(line);
        }
        const fileList = files.length ? files.join(", ") : "one or more files";
        return deny(`Branch "${branch}" has merge conflicts with ${baseBranch} in: ${fileList}. ` + `Rebase or merge origin/${baseBranch} now and resolve the conflicts.`);
      }
    }
    if (pr.mergeable === "CONFLICTING") {
      return deny(`PR #${pr.number} has merge conflicts per GitHub (${pr.url}). ` + `Rebase or merge origin/${baseBranch} now and resolve the conflicts.`);
    }
    if (pr.mergeable === "UNKNOWN") {
      return deny(`GitHub is still computing mergeability for PR #${pr.number} (${pr.url}). ` + `Wait ~10 seconds, then re-check with \`gh pr view --json mergeable\` before attempting to stop again.`);
    }
    return allow(`PR #${pr.number} merges cleanly per GitHub.`);
  }
  function requireCiGreenBeforeStop(ctx) {
    if (isPlanMode(ctx))
      return allow("Plan mode — no changes made, skipping CI check.");
    const cwd = ctx.session?.cwd;
    if (!cwd)
      return allow("No working directory available, skipping CI check.");
    try {
      try {
        execSync("gh --version", { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 });
      } catch {
        return allow("GitHub CLI (gh) not installed, skipping CI check.");
      }
      const branch = getCurrentBranch(cwd);
      if (!branch || branch === "HEAD")
        return allow("Detached HEAD, skipping CI check.");
      const sha = getHeadSha(cwd);
      let workflowRuns = [];
      try {
        const runsJson = execFileSync("gh", ["run", "list", "--branch", branch, "--limit", "20", "--json", "status,conclusion,name,headSha"], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 }).trim();
        if (runsJson && runsJson !== "[]") {
          const allWorkflowRuns = JSON.parse(runsJson);
          const headRuns = sha ? allWorkflowRuns.filter((r) => r.headSha === sha) : allWorkflowRuns;
          const seen = new Set;
          workflowRuns = headRuns.filter((r) => {
            if (seen.has(r.name))
              return false;
            seen.add(r.name);
            return true;
          });
        }
      } catch {}
      let thirdPartyChecks = [];
      let commitStatuses = [];
      if (sha) {
        thirdPartyChecks = getThirdPartyCheckRuns(cwd, sha);
        commitStatuses = getCommitStatuses(cwd, sha);
      }
      const allChecks = [...workflowRuns, ...thirdPartyChecks, ...commitStatuses];
      if (allChecks.length === 0)
        return allow(`No CI runs found for branch "${branch}".`);
      const failing = allChecks.filter((r) => r.status === "completed" && r.conclusion !== "success" && r.conclusion !== "skipped" && r.conclusion !== "cancelled" && r.conclusion !== "neutral");
      if (failing.length > 0) {
        const names = failing.map((r) => `"${r.name}"`).join(", ");
        return deny(`CI checks are failing on branch "${branch}": ${names}. Fix the failing checks now.`);
      }
      const pending = allChecks.filter((r) => r.status === "in_progress" || r.status === "queued" || r.status === "waiting");
      if (pending.length > 0) {
        const names = pending.map((r) => `"${r.name}"`).join(", ");
        return deny(`CI checks are still running on branch "${branch}": ${names}. Wait for all checks to complete, then verify they pass.`);
      }
      return allow(`All CI checks passed on branch "${branch}".`);
    } catch {
      return allow("Could not check CI status, skipping.");
    }
  }

  // src/hooks/builtin-policies.ts
  setPolicyWarnSink(hookLogWarn);
  setHostContextFallback({
    home: () => homedir(),
    projectDir: () => process.env.CLAUDE_PROJECT_DIR
  });
  var BUILTIN_POLICIES = [
    {
      name: "sanitize-jwt",
      description: "Stop Claude from reading JWTs in tool responses",
      displayTitle: "Redacted JWT tokens from tool output",
      impact: "Stops the agent from echoing auth tokens it saw in command output.",
      fn: sanitizeJwt,
      match: { events: ["PostToolUse"] },
      defaultEnabled: true,
      category: "Sanitize"
    },
    {
      name: "sanitize-api-keys",
      description: "Stop Claude from reading API keys (OpenAI, Anthropic, GitHub, AWS, Stripe, Google) in tool responses",
      displayTitle: "Redacted API keys from tool output",
      impact: "Catches OpenAI / Anthropic / GitHub / AWS / Stripe / Google keys before the model sees them.",
      fn: sanitizeApiKeys,
      match: { events: ["PostToolUse"] },
      defaultEnabled: true,
      category: "Sanitize",
      params: {
        additionalPatterns: {
          type: "pattern[]",
          description: "Additional API key patterns to scrub, each with { regex, label }",
          default: []
        }
      }
    },
    {
      name: "sanitize-connection-strings",
      description: "Stop Claude from reading database connection strings with embedded credentials in tool responses",
      displayTitle: "Redacted database connection strings from tool output",
      impact: "Strips embedded DB credentials before they reach the model context.",
      fn: sanitizeConnectionStrings,
      match: { events: ["PostToolUse"] },
      defaultEnabled: true,
      category: "Sanitize"
    },
    {
      name: "sanitize-private-key-content",
      description: "Stop Claude from reading PEM private key content in tool responses",
      displayTitle: "Redacted PEM private keys from tool output",
      impact: "Prevents private key bodies from being echoed into chat context.",
      fn: sanitizePrivateKeyContent,
      match: { events: ["PostToolUse"] },
      defaultEnabled: true,
      category: "Sanitize"
    },
    {
      name: "sanitize-bearer-tokens",
      displayTitle: "Redacted bearer tokens from tool output",
      impact: "Strips Authorization: Bearer values before they hit the model.",
      description: "Stop Claude from reading Authorization Bearer tokens in tool responses",
      fn: sanitizeBearerTokens,
      match: { events: ["PostToolUse"] },
      defaultEnabled: true,
      category: "Sanitize"
    },
    {
      name: "protect-env-vars",
      displayTitle: "Tried to dump environment variables to chat",
      impact: "Env vars often contain secrets; blocking `env` / `printenv` keeps them out of the model context.",
      description: "Prevent commands that read environment variables",
      fn: protectEnvVars,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: true,
      category: "Environment"
    },
    {
      name: "block-env-files",
      displayTitle: "Tried to read or write a .env file",
      impact: "`.env` files routinely contain API keys and DB credentials.",
      description: "Block reading/writing .env files",
      fn: blockEnvFiles,
      match: { events: ["PreToolUse"] },
      defaultEnabled: true,
      category: "Environment"
    },
    {
      name: "block-read-outside-cwd",
      displayTitle: "Tried to read files outside your project directory",
      impact: "Stops the agent from peeking at neighboring repos or your home directory.",
      description: "Block file reads outside the session working directory",
      fn: blockReadOutsideCwd,
      match: { events: ["PreToolUse"], toolNames: ["Read", "Glob", "Grep", "Bash"] },
      defaultEnabled: false,
      category: "Environment",
      params: {
        allowPaths: {
          type: "string[]",
          description: "Absolute paths outside cwd that are allowed to be read",
          default: []
        }
      }
    },
    {
      name: "block-sudo",
      displayTitle: "Tried to run a command with sudo",
      impact: "Sudo gives the agent root — blocked unless explicitly allow-listed.",
      description: "Block sudo commands",
      fn: blockSudo,
      match: { events: ["PreToolUse", "PermissionRequest"], toolNames: ["Bash"] },
      defaultEnabled: true,
      category: "Dangerous Commands",
      params: {
        allowPatterns: {
          type: "string[]",
          description: "Sudo command patterns to allow, matched token-by-token (e.g. 'sudo systemctl status')",
          default: []
        }
      }
    },
    {
      name: "block-curl-pipe-sh",
      displayTitle: "Tried to pipe a downloaded script straight to a shell",
      impact: "`curl ... | sh` runs unverified remote code on your machine.",
      description: "Block piping downloads to shell",
      fn: blockCurlPipeSh,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: true,
      category: "Dangerous Commands"
    },
    {
      name: "block-rm-rf",
      displayTitle: "Tried to recursively delete a system path",
      impact: "Catches catastrophic `rm -rf /` and Windows equivalents.",
      description: "Prevent catastrophic deletions",
      fn: blockRmRf,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: false,
      category: "Dangerous Commands",
      params: {
        allowPaths: {
          type: "string[]",
          description: "Paths that are allowed to be recursively deleted",
          default: []
        }
      }
    },
    {
      name: "block-failproofai-commands",
      displayTitle: "Tried to disable or modify failproofai itself",
      impact: "Prevents the agent from turning off the policies that protect you.",
      description: "Block failproofai CLI commands and uninstallation",
      fn: blockFailproofaiCommands,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: true,
      category: "Dangerous Commands"
    },
    {
      name: "block-kubectl",
      displayTitle: "Tried to run a Kubernetes command",
      impact: "kubectl can change live cluster state — gated unless allow-listed.",
      description: "Block kubectl commands (Kubernetes cluster mutations)",
      fn: blockKubectl,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: false,
      category: "Infra Commands",
      params: {
        allowPatterns: {
          type: "string[]",
          description: "kubectl command patterns to allow, matched token-by-token (e.g. 'kubectl get *', 'kubectl describe *')",
          default: []
        }
      }
    },
    {
      name: "block-terraform",
      displayTitle: "Tried to run a Terraform/OpenTofu command",
      impact: "Terraform mutates real infrastructure — gated unless allow-listed.",
      description: "Block terraform and tofu (OpenTofu) commands",
      fn: blockTerraform,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: false,
      category: "Infra Commands",
      params: {
        allowPatterns: {
          type: "string[]",
          description: "terraform/tofu command patterns to allow (e.g. 'terraform plan', 'terraform validate')",
          default: []
        }
      }
    },
    {
      name: "block-aws-cli",
      displayTitle: "Tried to run an AWS CLI command",
      impact: "AWS CLI can spend money or break prod — gated.",
      description: "Block aws CLI commands",
      fn: blockAwsCli,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: false,
      category: "Infra Commands",
      params: {
        allowPatterns: {
          type: "string[]",
          description: "aws CLI command patterns to allow (e.g. 'aws s3 ls *', 'aws sts get-caller-identity')",
          default: []
        }
      }
    },
    {
      name: "block-gcloud",
      displayTitle: "Tried to run a Google Cloud command",
      impact: "gcloud can spend money or break prod — gated.",
      description: "Block gcloud (Google Cloud) CLI commands",
      fn: blockGcloud,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: false,
      category: "Infra Commands",
      params: {
        allowPatterns: {
          type: "string[]",
          description: "gcloud command patterns to allow (e.g. 'gcloud auth list', 'gcloud config list')",
          default: []
        }
      }
    },
    {
      name: "block-az-cli",
      displayTitle: "Tried to run an Azure CLI command",
      impact: "az can spend money or break prod — gated.",
      description: "Block az (Azure) CLI commands",
      fn: blockAzCli,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: false,
      category: "Infra Commands",
      params: {
        allowPatterns: {
          type: "string[]",
          description: "az CLI command patterns to allow (e.g. 'az account show', 'az group list')",
          default: []
        }
      }
    },
    {
      name: "block-helm",
      displayTitle: "Tried to run a Helm command",
      impact: "Helm releases mutate cluster state — gated.",
      description: "Block helm commands",
      fn: blockHelm,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: false,
      category: "Infra Commands",
      params: {
        allowPatterns: {
          type: "string[]",
          description: "helm command patterns to allow (e.g. 'helm list', 'helm status *')",
          default: []
        }
      }
    },
    {
      name: "block-gh-pipeline",
      displayTitle: "Tried to run a privileged GitHub CLI pipeline command",
      impact: "Catches `gh workflow run`, `gh pr merge`, `gh secret set`, etc.",
      description: "Block gh CLI pipeline-trigger subcommands (workflow run, run rerun/cancel, pr merge, release create/delete, cache delete, secret set/delete)",
      fn: blockGhPipeline,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: false,
      category: "Infra Commands",
      params: {
        allowPatterns: {
          type: "string[]",
          description: "gh pipeline command patterns to allow (e.g. specific scripted invocations); read-only gh subcommands like 'gh pr view' and 'gh run list' are not matched by this policy",
          default: []
        }
      }
    },
    {
      name: "block-secrets-write",
      displayTitle: "Tried to write a secret-key file",
      impact: "Stops the agent from creating `.pem`, `id_rsa`, `credentials.json`, etc.",
      description: "Block writing secret key files",
      fn: blockSecretsWrite,
      match: { events: ["PreToolUse"], toolNames: ["Write"] },
      defaultEnabled: false,
      category: "Dangerous Commands",
      params: {
        additionalPatterns: {
          type: "string[]",
          description: "Additional filename patterns (substrings) to block",
          default: []
        }
      }
    },
    {
      name: "block-push-master",
      displayTitle: "Tried to push directly to main/master",
      impact: "Direct pushes to a protected branch bypass review.",
      description: "Block pushing to main/master",
      fn: blockPushMaster,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: true,
      category: "Git",
      params: {
        protectedBranches: {
          type: "string[]",
          description: "Branch names to protect from direct pushes",
          default: ["main", "master"]
        }
      }
    },
    {
      name: "block-force-push",
      displayTitle: "Tried to force-push",
      impact: "Force-pushes rewrite history and can clobber teammates' work.",
      description: "Prevent force-pushing to any branch",
      fn: blockForcePush,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: false,
      category: "Git"
    },
    {
      name: "block-work-on-main",
      displayTitle: "Tried to commit or merge on main/master",
      impact: "Work should land via PR — direct commits skip review.",
      description: "Block git commits and merges on main/master branch",
      fn: blockWorkOnMain,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: false,
      category: "Git",
      params: {
        protectedBranches: {
          type: "string[]",
          description: "Branch names where commits/merges are blocked",
          default: ["main", "master"]
        }
      }
    },
    {
      name: "warn-git-amend",
      displayTitle: "Used git commit --amend",
      impact: "Amending after a push rewrites history that others may have pulled.",
      description: "Warns before amending git commits, which rewrites history",
      fn: warnGitAmend,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: false,
      category: "Git"
    },
    {
      name: "warn-git-stash-drop",
      displayTitle: "Tried to drop or clear git stash",
      impact: "Stash deletions are permanent and silent.",
      description: "Warns before permanently deleting stashed changes",
      fn: warnGitStashDrop,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: false,
      category: "Git"
    },
    {
      name: "warn-all-files-staged",
      displayTitle: "Staged all files with git add -A / .",
      impact: "Wide stages routinely catch generated files or secrets you didn't intend to commit.",
      description: "Warns before staging all working tree files with git add -A / . / --all",
      fn: warnAllFilesStaged,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: false,
      category: "Git"
    },
    {
      name: "warn-destructive-sql",
      displayTitle: "Ran destructive SQL (DROP / TRUNCATE / DELETE without WHERE)",
      impact: "Easy way to wipe a table by accident.",
      description: "Warn before executing destructive SQL (DROP/TRUNCATE/DELETE without WHERE) via database clients",
      fn: warnDestructiveSql,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: false,
      category: "Database"
    },
    {
      name: "warn-schema-alteration",
      displayTitle: "Altered a database schema column",
      impact: "ALTER TABLE operations can lock tables and break readers.",
      description: "Warns before SQL schema changes (ALTER TABLE with column or rename operations)",
      fn: warnSchemaAlteration,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: false,
      category: "Database"
    },
    {
      name: "warn-package-publish",
      displayTitle: "Tried to publish a package",
      impact: "Publishes are irreversible — `npm publish` / `cargo publish` shouldn't happen without intent.",
      description: "Warn before publishing packages to public registries (npm, PyPI, crates.io, RubyGems, etc.)",
      fn: warnPackagePublish,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: false,
      category: "Packages & System"
    },
    {
      name: "warn-global-package-install",
      displayTitle: "Installed a package globally",
      impact: "`npm i -g`, `cargo install`, `pip --user` pollute your machine outside the project.",
      description: "Warns before installing packages globally (npm -g, cargo install, etc.)",
      fn: warnGlobalPackageInstall,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: false,
      category: "Packages & System"
    },
    {
      name: "prefer-package-manager",
      displayTitle: "Used a non-preferred package manager",
      impact: "Mixing package managers creates lockfile churn for your team.",
      description: "Blocks non-preferred package managers and tells Claude to use an allowed one (e.g., uv instead of pip)",
      fn: preferPackageManager,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: false,
      category: "Packages & System",
      params: {
        allowed: {
          type: "string[]",
          description: "Allowed package manager names (e.g. ['uv', 'bun']). Any detected manager not in this list is blocked.",
          default: []
        },
        blocked: {
          type: "string[]",
          description: "Additional manager names to block beyond the built-in list (e.g. ['pdm', 'pipx']).",
          default: []
        }
      }
    },
    {
      name: "warn-large-file-write",
      displayTitle: "Wrote a file larger than the configured threshold",
      impact: "Catches accidentally large file writes (logs, binaries, model dumps).",
      description: "Warn before writing files larger than 1MB (configurable via thresholdKb param)",
      fn: warnLargeFileWrite,
      match: { events: ["PreToolUse"], toolNames: ["Write"] },
      defaultEnabled: false,
      category: "Packages & System",
      params: {
        thresholdKb: {
          type: "number",
          description: "File size threshold in KB above which a warning is issued",
          default: 1024
        }
      }
    },
    {
      name: "warn-background-process",
      displayTitle: "Started a long-lived background process",
      impact: "Catches `nohup` / `&` / `screen` / `tmux` / `disown` patterns that the agent often forgets to clean up.",
      description: "Warns before starting detached or background processes",
      fn: warnBackgroundProcess,
      match: { events: ["PreToolUse"], toolNames: ["Bash"] },
      defaultEnabled: false,
      category: "Packages & System"
    },
    {
      name: "warn-repeated-tool-calls",
      displayTitle: "Called the same tool 3+ times with identical arguments",
      impact: "Usually a sign of a stuck loop burning tokens.",
      description: "Warn when the same tool is called 3+ times with identical parameters",
      fn: warnRepeatedToolCalls,
      match: { events: ["PreToolUse"] },
      defaultEnabled: false,
      category: "AI Behavior"
    },
    {
      name: "require-commit-before-stop",
      displayTitle: "Stopped with uncommitted changes",
      impact: "Work not in a commit is invisible to teammates and easy to lose.",
      description: "Require all changes to be committed before Claude stops",
      fn: requireCommitBeforeStop,
      match: { events: ["Stop"] },
      defaultEnabled: false,
      category: "Workflow"
    },
    {
      name: "require-push-before-stop",
      displayTitle: "Stopped with unpushed commits",
      impact: "Local-only commits won't trigger CI or be reviewable.",
      description: "Require all commits to be pushed to remote before Claude stops",
      fn: requirePushBeforeStop,
      match: { events: ["Stop"] },
      defaultEnabled: false,
      category: "Workflow",
      params: {
        remote: {
          type: "string",
          description: "Remote name to push to (default: origin)",
          default: "origin"
        },
        baseBranch: {
          type: "string",
          description: "Base branch to compare against (default: main)",
          default: "main"
        }
      }
    },
    {
      name: "require-pr-before-stop",
      displayTitle: "Stopped without a PR for the branch",
      impact: "Branches without PRs don't get reviewed.",
      description: "Require a pull request to exist for the current branch before Claude stops",
      fn: requirePrBeforeStop,
      match: { events: ["Stop"] },
      defaultEnabled: false,
      category: "Workflow",
      params: {
        baseBranch: {
          type: "string",
          description: "Base branch to compare against (default: main)",
          default: "main"
        }
      }
    },
    {
      name: "require-no-conflicts-before-stop",
      displayTitle: "Stopped with a branch that conflicts with main",
      impact: "Conflicting branches can't merge — surface them early.",
      description: "Require the current branch to merge cleanly with the base branch before Claude stops",
      fn: requireNoConflictsBeforeStop,
      match: { events: ["Stop"] },
      defaultEnabled: false,
      category: "Workflow",
      params: {
        baseBranch: {
          type: "string",
          description: "Base branch to check for conflicts against (default: main)",
          default: "main"
        }
      }
    },
    {
      name: "require-ci-green-before-stop",
      displayTitle: "Stopped with failing CI",
      impact: "Failing CI blocks deploy.",
      description: "Require CI checks to pass on the current HEAD commit before Claude stops (ignores stale runs on prior commits)",
      fn: requireCiGreenBeforeStop,
      match: { events: ["Stop"] },
      defaultEnabled: false,
      category: "Workflow"
    }
  ];
  function registerBuiltinPolicies(enabledNames) {
    const enabledSet = new Set(enabledNames.map(normalizePolicyName));
    for (const policy of BUILTIN_POLICIES) {
      if (enabledSet.has(normalizePolicyName(policy.name))) {
        registerPolicy(policy.name, policy.description, policy.fn, policy.match);
      }
    }
  }

  // src/hooks/policy-evaluator.ts
  function appendHint(baseReason, hint) {
    const base = baseReason.trim();
    const normalizedHint = typeof hint === "string" ? hint.trim() : "";
    if (!normalizedHint)
      return base;
    if (!base)
      return normalizedHint;
    return `${base}. ${normalizedHint}`;
  }
  var POLICY_PARAMS_MAP = new Map(BUILTIN_POLICIES.filter((p) => p.params).map((p) => [normalizePolicyName(p.name), p.params]));
  function getConfigParamsFor(config, canonicalName) {
    if (!config?.policyParams)
      return;
    const canonicalParams = config.policyParams[canonicalName];
    if (canonicalParams)
      return canonicalParams;
    const defaultPrefix = `${DEFAULT_POLICY_NAMESPACE}/`;
    if (!canonicalName.startsWith(defaultPrefix))
      return;
    return config.policyParams[canonicalName.slice(defaultPrefix.length)];
  }
  async function evaluateVerdicts(eventType, payload, session, config) {
    const toolName = payload.tool_name;
    const toolInput = payload.tool_input;
    const policies = getPoliciesForEvent(eventType, toolName);
    hookLogInfo(`evaluating ${policies.length} policies for ${eventType}`);
    if (policies.length === 0) {
      return { deny: null, instructEntries: [], allowEntries: [], matchedCount: 0, toolName };
    }
    const baseCtx = {
      eventType,
      payload,
      toolName,
      toolInput,
      session,
      cli: session?.cli
    };
    const instructEntries = [];
    const allowEntries = [];
    for (const policy of policies) {
      const schema = POLICY_PARAMS_MAP.get(policy.name);
      let ctx;
      if (schema) {
        const userParams = getConfigParamsFor(config, policy.name) ?? {};
        const resolvedParams = {};
        for (const [key, spec] of Object.entries(schema)) {
          resolvedParams[key] = key in userParams ? userParams[key] : spec.default;
        }
        ctx = { ...baseCtx, params: resolvedParams };
      } else {
        ctx = { ...baseCtx, params: {} };
      }
      let result;
      try {
        result = await policy.fn(ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        hookLogWarn(`policy "${policy.name}" threw: ${msg}`);
        const isCustom = policy.name.startsWith("custom/") || policy.name.startsWith(".failproofai-");
        if (!isCustom) {
          trackHookEvent(getInstanceId(), "policy_evaluation_error", {
            policy_name: policy.name,
            event_type: eventType,
            cli: session?.cli ?? null,
            error_type: err instanceof Error ? err.name : "unknown"
          });
        }
        continue;
      }
      if (result.decision === "deny") {
        const reason = appendHint(result.reason ?? `Blocked by policy: ${policy.name}`, getConfigParamsFor(config, policy.name)?.hint);
        hookLogInfo(`deny by "${policy.name}": ${reason}`);
        return {
          deny: { policyName: policy.name, reason },
          instructEntries,
          allowEntries,
          matchedCount: policies.length,
          toolName
        };
      }
      if (result.decision === "instruct") {
        const reason = appendHint(result.reason ?? `Instruction from policy: ${policy.name}`, getConfigParamsFor(config, policy.name)?.hint);
        instructEntries.push({ policyName: policy.name, reason });
        hookLogInfo(`instruct by "${policy.name}": ${reason}`);
      }
      if (result.decision === "allow" && result.reason) {
        allowEntries.push({ policyName: policy.name, reason: result.reason });
      }
    }
    return { deny: null, instructEntries, allowEntries, matchedCount: policies.length, toolName };
  }
  function encodeResponse(verdicts, eventType, session) {
    const { instructEntries, allowEntries } = verdicts;
    if (verdicts.matchedCount === 0) {
      return { exitCode: 0, stdout: "", stderr: "", policyName: null, reason: null, decision: "allow" };
    }
    if (verdicts.deny) {
      const { policyName, reason } = verdicts.deny;
      let displayTool;
      if (verdicts.toolName) {
        displayTool = verdicts.toolName;
      } else if (eventType === "UserPromptSubmit") {
        displayTool = "prompt";
      } else if (eventType === "SessionStart") {
        displayTool = "session start";
      } else if (eventType === "SessionEnd") {
        displayTool = "session end";
      } else if (eventType === "Stop") {
        displayTool = "stop";
      } else {
        displayTool = "operation";
      }
      const blockedMessage = `Blocked ${displayTool} by failproofai because: ${reason}, as per the policy configured by the user`;
      if (session?.cli === "cursor") {
        if (eventType === "Stop" || eventType === "SubagentStop") {
          const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policyName}): ${reason}

You MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ followup_message: reasonText }),
            stderr: "",
            policyName,
            reason,
            decision: "deny"
          };
        }
        if (eventType === "UserPromptSubmit") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ continue: false, user_message: blockedMessage }),
            stderr: "",
            policyName,
            reason,
            decision: "deny"
          };
        }
        const response = {
          permission: "deny",
          user_message: blockedMessage,
          agent_message: blockedMessage
        };
        return {
          exitCode: 0,
          stdout: JSON.stringify(response),
          stderr: "",
          policyName,
          reason,
          decision: "deny"
        };
      }
      if (session?.cli === "pi") {
        if (eventType === "Stop") {
          const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policyName}): ${reason}

You MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ permission: "deny", reason: reasonText }),
            stderr: "",
            policyName,
            reason,
            decision: "deny"
          };
        }
        const response = {
          permission: "deny",
          reason: blockedMessage
        };
        return {
          exitCode: 0,
          stdout: JSON.stringify(response),
          stderr: "",
          policyName,
          reason,
          decision: "deny"
        };
      }
      if (session?.cli === "hermes") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ decision: "block", reason: blockedMessage }),
          stderr: "",
          policyName,
          reason,
          decision: "deny"
        };
      }
      if (session?.cli === "openclaw") {
        if (eventType === "Stop") {
          const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policyName}): ${reason}

You MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ permission: "deny", reason: reasonText }),
            stderr: "",
            policyName,
            reason,
            decision: "deny"
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ permission: "deny", reason: blockedMessage }),
          stderr: "",
          policyName,
          reason,
          decision: "deny"
        };
      }
      if (session?.cli === "opencode") {
        if (eventType === "Stop" || eventType === "SubagentStop") {
          const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policyName}): ${reason}

You MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: reasonText } }),
            stderr: "",
            policyName,
            reason,
            decision: "deny"
          };
        }
      }
      if (session?.cli === "factory") {
        if (eventType === "Stop") {
          const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policyName}): ${reason}

You MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ decision: "block", reason: reasonText }),
            stderr: "",
            policyName,
            reason,
            decision: "deny"
          };
        }
        return {
          exitCode: 2,
          stdout: "",
          stderr: blockedMessage + `
`,
          policyName,
          reason,
          decision: "deny"
        };
      }
      if (session?.cli === "devin") {
        const reasonText = eventType === "Stop" ? `MANDATORY ACTION REQUIRED from failproofai (policy: ${policyName}): ${reason}

You MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.` : blockedMessage;
        return {
          exitCode: 0,
          stdout: JSON.stringify({ decision: "block", reason: reasonText }),
          stderr: "",
          policyName,
          reason,
          decision: "deny"
        };
      }
      if (session?.cli === "antigravity") {
        if (eventType === "Stop") {
          const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policyName}): ${reason}

You MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ decision: "continue", reason: reasonText }),
            stderr: "",
            policyName,
            reason,
            decision: "deny"
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ decision: "deny", reason: blockedMessage }),
          stderr: "",
          policyName,
          reason,
          decision: "deny"
        };
      }
      if (session?.cli === "goose") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ decision: "block", reason: blockedMessage }),
          stderr: "",
          policyName,
          reason,
          decision: "deny"
        };
      }
      if (eventType === "PreToolUse") {
        const response = {
          hookSpecificOutput: {
            hookEventName: eventType,
            permissionDecision: "deny",
            permissionDecisionReason: blockedMessage
          }
        };
        return {
          exitCode: 0,
          stdout: JSON.stringify(response),
          stderr: "",
          policyName,
          reason,
          decision: "deny"
        };
      }
      if (session?.cli === "copilot") {
        if (eventType === "UserPromptSubmit") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ decision: "block", reason: blockedMessage }),
            stderr: "",
            policyName,
            reason,
            decision: "deny"
          };
        }
        if (eventType === "PermissionRequest") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ behavior: "deny", message: blockedMessage }),
            stderr: "",
            policyName,
            reason,
            decision: "deny"
          };
        }
      }
      if (eventType === "PermissionRequest") {
        const response = {
          hookSpecificOutput: {
            hookEventName: eventType,
            decision: {
              behavior: "deny",
              message: `Blocked ${displayTool} by failproofai because: ${reason}, as per the policy configured by the user`
            }
          }
        };
        return {
          exitCode: 0,
          stdout: JSON.stringify(response),
          stderr: "",
          policyName,
          reason,
          decision: "deny"
        };
      }
      if (eventType === "PostToolUse") {
        const response = {
          hookSpecificOutput: {
            hookEventName: eventType,
            additionalContext: `Blocked ${displayTool} by failproofai because: ${reason}, as per the policy configured by the user`
          }
        };
        return {
          exitCode: 0,
          stdout: JSON.stringify(response),
          stderr: "",
          policyName,
          reason,
          decision: "deny"
        };
      }
      if (eventType === "Stop" || eventType === "SubagentStop") {
        const reasonText = `MANDATORY ACTION REQUIRED from failproofai (policy: ${policyName}): ${reason}

You MUST complete the above action NOW. Do NOT ask the user for confirmation — execute the required action, then attempt to finish your task again.`;
        if (session?.cli === "copilot") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ decision: "block", reason: reasonText }),
            stderr: "",
            policyName,
            reason,
            decision: "deny"
          };
        }
        return {
          exitCode: 2,
          stdout: "",
          stderr: reasonText,
          policyName,
          reason,
          decision: "deny"
        };
      }
      return {
        exitCode: 2,
        stdout: "",
        stderr: reason,
        policyName,
        reason,
        decision: "deny"
      };
    }
    if (instructEntries.length > 0) {
      const combined = instructEntries.map((e) => e.reason).join(`
`);
      const policyNames = instructEntries.map((e) => e.policyName);
      if (session?.cli === "cursor") {
        if (eventType === "Stop" || eventType === "SubagentStop") {
          const response3 = {
            followup_message: `Instruction from failproofai: ${combined}`
          };
          return {
            exitCode: 0,
            stdout: JSON.stringify(response3),
            stderr: "",
            policyName: policyNames[0],
            policyNames,
            reason: combined,
            decision: "instruct"
          };
        }
        const response2 = {
          permission: "allow",
          additional_context: `Instruction from failproofai: ${combined}`
        };
        return {
          exitCode: 0,
          stdout: JSON.stringify(response2),
          stderr: "",
          policyName: policyNames[0],
          policyNames,
          reason: combined,
          decision: "instruct"
        };
      }
      if (session?.cli === "pi") {
        if (eventType === "Stop") {
          const policyAttribution = policyNames.length === 1 ? `policy: ${policyNames[0]}` : `policies: ${policyNames.join(", ")}`;
          const reasonText = `MANDATORY ACTION REQUIRED from failproofai (${policyAttribution}): ${combined}

You MUST complete the above action(s) NOW. Do NOT ask the user for confirmation — execute the required action(s), then attempt to finish your task again.`;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ permission: "deny", reason: reasonText }),
            stderr: "",
            policyName: policyNames[0],
            policyNames,
            reason: combined,
            decision: "instruct"
          };
        }
        const response2 = {
          permission: "allow",
          reason: `Instruction from failproofai: ${combined}`
        };
        return {
          exitCode: 0,
          stdout: JSON.stringify(response2),
          stderr: "",
          policyName: policyNames[0],
          policyNames,
          reason: combined,
          decision: "instruct"
        };
      }
      if (session?.cli === "hermes") {
        const stderrMsg = instructEntries.map((e) => `[failproofai] ${e.policyName}: ${e.reason}`).join(`
`);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            decision: "allow",
            reason: `Instruction from failproofai: ${combined}`
          }),
          stderr: stderrMsg + `
`,
          policyName: policyNames[0],
          policyNames,
          reason: combined,
          decision: "instruct"
        };
      }
      if (session?.cli === "openclaw") {
        if (eventType === "Stop") {
          const policyAttribution = policyNames.length === 1 ? `policy: ${policyNames[0]}` : `policies: ${policyNames.join(", ")}`;
          const reasonText = `MANDATORY ACTION REQUIRED from failproofai (${policyAttribution}): ${combined}

You MUST complete the above action(s) NOW. Do NOT ask the user for confirmation — execute the required action(s), then attempt to finish your task again.`;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ permission: "deny", reason: reasonText }),
            stderr: "",
            policyName: policyNames[0],
            policyNames,
            reason: combined,
            decision: "instruct"
          };
        }
        const stderrMsg = instructEntries.map((e) => `[failproofai] ${e.policyName}: ${e.reason}`).join(`
`);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            permission: "allow",
            reason: `Instruction from failproofai: ${combined}`
          }),
          stderr: stderrMsg + `
`,
          policyName: policyNames[0],
          policyNames,
          reason: combined,
          decision: "instruct"
        };
      }
      if (session?.cli === "opencode") {
        if (eventType === "Stop" || eventType === "SubagentStop") {
          const policyAttribution = policyNames.length === 1 ? `policy: ${policyNames[0]}` : `policies: ${policyNames.join(", ")}`;
          const reasonText = `MANDATORY ACTION REQUIRED from failproofai (${policyAttribution}): ${combined}

You MUST complete the above action(s) NOW. Do NOT ask the user for confirmation — execute the required action(s), then attempt to finish your task again.`;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: reasonText } }),
            stderr: "",
            policyName: policyNames[0],
            policyNames,
            reason: combined,
            decision: "instruct"
          };
        }
      }
      if (session?.cli === "factory") {
        if (eventType === "Stop") {
          const policyAttribution = policyNames.length === 1 ? `policy: ${policyNames[0]}` : `policies: ${policyNames.join(", ")}`;
          const reasonText = `MANDATORY ACTION REQUIRED from failproofai (${policyAttribution}): ${combined}

You MUST complete the above action(s) NOW. Do NOT ask the user for confirmation — execute the required action(s), then attempt to finish your task again.`;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ decision: "block", reason: reasonText }),
            stderr: "",
            policyName: policyNames[0],
            policyNames,
            reason: combined,
            decision: "instruct"
          };
        }
        const stderrMsg = instructEntries.map((e) => `[failproofai] ${e.policyName}: ${e.reason}`).join(`
`);
        return {
          exitCode: 0,
          stdout: "",
          stderr: stderrMsg + `
`,
          policyName: policyNames[0],
          policyNames,
          reason: combined,
          decision: "instruct"
        };
      }
      if (session?.cli === "devin" && eventType === "Stop") {
        const policyAttribution = policyNames.length === 1 ? `policy: ${policyNames[0]}` : `policies: ${policyNames.join(", ")}`;
        const reasonText = `MANDATORY ACTION REQUIRED from failproofai (${policyAttribution}): ${combined}

You MUST complete the above action(s) NOW. Do NOT ask the user for confirmation — execute the required action(s), then attempt to finish your task again.`;
        return {
          exitCode: 0,
          stdout: JSON.stringify({ decision: "block", reason: reasonText }),
          stderr: "",
          policyName: policyNames[0],
          policyNames,
          reason: combined,
          decision: "instruct"
        };
      }
      if (session?.cli === "antigravity") {
        if (eventType === "UserPromptSubmit") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              injectSteps: [{ ephemeralMessage: `Instruction from failproofai: ${combined}` }]
            }),
            stderr: "",
            policyName: policyNames[0],
            policyNames,
            reason: combined,
            decision: "instruct"
          };
        }
        if (eventType === "Stop") {
          const policyAttribution = policyNames.length === 1 ? `policy: ${policyNames[0]}` : `policies: ${policyNames.join(", ")}`;
          const reasonText = `MANDATORY ACTION REQUIRED from failproofai (${policyAttribution}): ${combined}

You MUST complete the above action(s) NOW. Do NOT ask the user for confirmation — execute the required action(s), then attempt to finish your task again.`;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ decision: "continue", reason: reasonText }),
            stderr: "",
            policyName: policyNames[0],
            policyNames,
            reason: combined,
            decision: "instruct"
          };
        }
        const stderrMsg = instructEntries.map((e) => `[failproofai] ${e.policyName}: ${e.reason}`).join(`
`);
        return {
          exitCode: 0,
          stdout: "",
          stderr: stderrMsg + `
`,
          policyName: policyNames[0],
          policyNames,
          reason: combined,
          decision: "instruct"
        };
      }
      if (session?.cli === "goose") {
        const stderrMsg = instructEntries.map((e) => `[failproofai] ${e.policyName}: ${e.reason}`).join(`
`);
        return {
          exitCode: 0,
          stdout: "",
          stderr: stderrMsg + `
`,
          policyName: policyNames[0],
          policyNames,
          reason: combined,
          decision: "instruct"
        };
      }
      if (eventType === "Stop" || eventType === "SubagentStop") {
        const policyAttribution = policyNames.length === 1 ? `policy: ${policyNames[0]}` : `policies: ${policyNames.join(", ")}`;
        const reasonText = `MANDATORY ACTION REQUIRED from failproofai (${policyAttribution}): ${combined}

You MUST complete the above action(s) NOW. Do NOT ask the user for confirmation — execute the required action(s), then attempt to finish your task again.`;
        if (session?.cli === "copilot") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ decision: "block", reason: reasonText }),
            stderr: "",
            policyName: policyNames[0],
            policyNames,
            reason: combined,
            decision: "instruct"
          };
        }
        return {
          exitCode: 2,
          stdout: "",
          stderr: reasonText,
          policyName: policyNames[0],
          policyNames,
          reason: combined,
          decision: "instruct"
        };
      }
      const response = {
        hookSpecificOutput: {
          hookEventName: eventType,
          additionalContext: `Instruction from failproofai: ${combined}`
        }
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify(response),
        stderr: "",
        policyName: policyNames[0],
        policyNames,
        reason: combined,
        decision: "instruct"
      };
    }
    if (allowEntries.length > 0) {
      const combined = allowEntries.map((e) => e.reason).join(`
`);
      const policyNames = allowEntries.map((e) => e.policyName);
      if (session?.cli === "cursor") {
        const response = {
          permission: "allow",
          additional_context: `Note from failproofai: ${combined}`
        };
        const stderrMsg2 = allowEntries.map((e) => `[failproofai] ${e.policyName}: ${e.reason}`).join(`
`);
        return {
          exitCode: 0,
          stdout: JSON.stringify(response),
          stderr: stderrMsg2 + `
`,
          policyName: policyNames[0],
          policyNames,
          reason: combined,
          decision: "allow"
        };
      }
      if (session?.cli === "pi") {
        const response = {
          permission: "allow",
          reason: `Note from failproofai: ${combined}`
        };
        const stderrMsg2 = allowEntries.map((e) => `[failproofai] ${e.policyName}: ${e.reason}`).join(`
`);
        return {
          exitCode: 0,
          stdout: JSON.stringify(response),
          stderr: stderrMsg2 + `
`,
          policyName: policyNames[0],
          policyNames,
          reason: combined,
          decision: "allow"
        };
      }
      if (session?.cli === "openclaw") {
        const stderrMsg2 = allowEntries.map((e) => `[failproofai] ${e.policyName}: ${e.reason}`).join(`
`);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            permission: "allow",
            reason: `Note from failproofai: ${combined}`
          }),
          stderr: stderrMsg2 + `
`,
          policyName: policyNames[0],
          policyNames,
          reason: combined,
          decision: "allow"
        };
      }
      const supportsHookSpecificOutput = eventType === "PreToolUse" || eventType === "PostToolUse" || eventType === "UserPromptSubmit" || eventType === "PermissionRequest";
      const stderrMsg = allowEntries.map((e) => `[failproofai] ${e.policyName}: ${e.reason}`).join(`
`);
      if (supportsHookSpecificOutput) {
        const response = { hookSpecificOutput: { hookEventName: eventType, additionalContext: `Note from failproofai: ${combined}` } };
        return { exitCode: 0, stdout: JSON.stringify(response), stderr: stderrMsg + `
`, policyName: policyNames[0], policyNames, reason: combined, decision: "allow" };
      }
      return { exitCode: 0, stdout: "", stderr: stderrMsg + `
`, policyName: policyNames[0], policyNames, reason: combined, decision: "allow" };
    }
    return { exitCode: 0, stdout: "", stderr: "", policyName: null, reason: null, decision: "allow" };
  }

  // src/policy-runtime/sealed-entry.ts
  var SEALED_ELIGIBLE = new Set(PAYLOAD_ONLY_POLICIES.map((p) => p.name));
  var SEALED_ELIGIBLE_CANONICAL = new Set(PAYLOAD_ONLY_POLICIES.map((p) => `failproofai/${p.name}`));
  function partitionEnabled(enabled) {
    const sealed = [];
    const needsUserContext = [];
    for (const name of enabled) {
      if (SEALED_ELIGIBLE.has(name) || SEALED_ELIGIBLE_CANONICAL.has(name))
        sealed.push(name);
      else
        needsUserContext.push(name);
    }
    return { sealed, needsUserContext };
  }
  async function evaluate(request) {
    try {
      const { sealed, needsUserContext } = partitionEnabled(request.config.enabledPolicies ?? []);
      clearPolicies();
      registerBuiltinPolicies(sealed);
      setHostContextFallback({
        home: () => "",
        projectDir: () => {
          return;
        }
      });
      setPolicyWarnSink(() => {});
      const verdicts = await evaluateVerdicts(request.eventType, request.payload, request.session, request.config);
      const result = encodeResponse(verdicts, request.eventType, request.session);
      return {
        ok: true,
        result,
        needsUserContext,
        readClientAssertedHost: Boolean(request.session.cwd || request.session.projectDir)
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
      };
    }
  }
  function sealedPolicyNames() {
    return [...SEALED_ELIGIBLE];
  }
  function installSealedGlobals() {
    globalThis.__fpai_sealed_evaluate = async (requestJson) => {
      let request;
      try {
        request = JSON.parse(requestJson);
      } catch (err) {
        return JSON.stringify({
          ok: false,
          error: `sealed worker: request is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
        });
      }
      return JSON.stringify(await evaluate(request));
    };
    globalThis.__fpai_sealed_policies = () => JSON.stringify(sealedPolicyNames());
    globalThis.__fpai_sealed_version = "1";
  }
  installSealedGlobals();
})();
