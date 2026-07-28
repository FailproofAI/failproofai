// @vitest-environment node
//
// The projects panel renders gateway CLIs (Hermes, OpenClaw) as a folder tree,
// derived purely from the synthetic `path` their producers emit. These tests
// pin the derivation: real filesystem projects must stay flat leaves, gateway
// paths must nest, and the rollups a collapsed folder row shows (session count,
// last activity, CLI badges) must reflect everything underneath it.
import { describe, it, expect } from "vitest";
import {
  buildProjectTree,
  visibleTreeRows,
  collapsibleKeys,
  type ProjectTreeNode,
} from "@/lib/project-tree";
import type { ProjectFolder } from "@/lib/projects";

function folder(
  name: string,
  path: string,
  ms: number,
  extra: Partial<ProjectFolder> = {},
): ProjectFolder {
  return {
    name,
    path,
    isDirectory: true,
    lastModified: new Date(ms),
    cli: ["hermes"],
    ...extra,
  };
}

/** Node lookup by key, depth-first. */
function find(nodes: ProjectTreeNode[], key: string): ProjectTreeNode | undefined {
  for (const n of nodes) {
    if (n.key === key) return n;
    const hit = find(n.children, key);
    if (hit) return hit;
  }
  return undefined;
}

describe("buildProjectTree", () => {
  it("keeps real filesystem projects as flat top-level leaves", () => {
    const tree = buildProjectTree([
      folder("-home-user-app", "/home/user/app", 2000, { cli: ["claude"] }),
      folder("-home-user-lib", "/home/user/lib", 1000, { cli: ["codex"] }),
    ]);
    expect(tree).toHaveLength(2);
    expect(tree.every((n) => n.depth === 0 && n.children.length === 0)).toBe(true);
    expect(tree[0].project?.name).toBe("-home-user-app"); // newest first
    expect(collapsibleKeys(tree)).toEqual([]); // nothing to expand
  });

  it("nests a gateway path one node per segment, leaf carrying the project", () => {
    const tree = buildProjectTree([folder("hermes-work-slack", "hermes:work:slack", 5000)]);
    expect(tree).toHaveLength(1);
    const root = tree[0];
    expect(root).toMatchObject({ key: "hermes", label: "hermes", depth: 0 });
    expect(root.project).toBeUndefined(); // pure grouping row — must not link

    const profile = root.children[0];
    expect(profile).toMatchObject({ key: "hermes:work", label: "work", depth: 1 });

    const leaf = profile.children[0];
    expect(leaf).toMatchObject({ key: "hermes:work:slack", label: "slack", depth: 2 });
    expect(leaf.project?.name).toBe("hermes-work-slack"); // the /project/<name> link
    expect(leaf.children).toEqual([]);
  });

  it("groups profiles under one CLI root and channels under one profile", () => {
    const tree = buildProjectTree([
      folder("hermes-default-slack", "hermes:default:slack", 1000),
      folder("hermes-default-cron", "hermes:default:cron", 3000),
      folder("hermes-work-telegram", "hermes:work:telegram", 2000),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((c) => c.label)).toEqual(["default", "work"]); // by recency
    expect(find(tree, "hermes:default")!.children.map((c) => c.label)).toEqual(["cron", "slack"]);
  });

  it("keeps a profile name containing a hyphen as ONE segment", () => {
    // The whole reason grouping is derived from `path` (colon-separated) rather
    // than `name`: decodeFolderName would split `my-bot` into `my/bot`.
    const tree = buildProjectTree([
      folder("hermes-my-bot-cron", "hermes:my-bot:cron", 1000),
    ]);
    expect(find(tree, "hermes:my-bot")).toBeDefined();
    expect(find(tree, "hermes:my-bot")!.label).toBe("my-bot");
  });

  it("nests OpenClaw's three levels: cli -> agent -> channel", () => {
    const tree = buildProjectTree([
      folder("openclaw-weather-bot-telegram", "openclaw:weather-bot:telegram", 4000, {
        cli: ["openclaw"],
      }),
    ]);
    const leaf = find(tree, "openclaw:weather-bot:telegram")!;
    expect(leaf.depth).toBe(2);
    expect(find(tree, "openclaw:weather-bot")!.label).toBe("weather-bot");
  });

  it("mixes gateway trees and flat projects in one recency-sorted list", () => {
    const tree = buildProjectTree([
      folder("hermes-work-slack", "hermes:work:slack", 1000),
      folder("-home-user-app", "/home/user/app", 9000, { cli: ["claude"] }),
    ]);
    expect(tree.map((n) => n.label)).toEqual(["-home-user-app", "hermes"]); // newest root first
  });

  describe("rollups on folder rows", () => {
    const tree = buildProjectTree([
      folder("hermes-default-slack", "hermes:default:slack", 1000, { sessionCount: 3 }),
      folder("hermes-default-cron", "hermes:default:cron", 8000, { sessionCount: 4 }),
      folder("hermes-work-telegram", "hermes:work:telegram", 2000, { sessionCount: 5 }),
    ]);

    it("sums session counts up every level", () => {
      expect(find(tree, "hermes:default")!.sessionCount).toBe(7);
      expect(find(tree, "hermes")!.sessionCount).toBe(12);
    });

    it("reports the newest activity anywhere beneath a folder", () => {
      expect(find(tree, "hermes:default")!.lastModified.getTime()).toBe(8000);
      expect(find(tree, "hermes")!.lastModified.getTime()).toBe(8000);
    });

    it("leaves sessionCount undefined when nothing underneath reported one", () => {
      // undefined must NOT collapse to 0 — "unknown" and "empty" read the same
      // to a user but mean opposite things.
      const noCounts = buildProjectTree([folder("hermes-a-slack", "hermes:a:slack", 1)]);
      expect(find(noCounts, "hermes")!.sessionCount).toBeUndefined();
    });

    it("counts the projects each row covers, for pagination", () => {
      expect(find(tree, "hermes")!.projectCount).toBe(3);
      expect(find(tree, "hermes:default")!.projectCount).toBe(2);
      expect(find(tree, "hermes:work:telegram")!.projectCount).toBe(1);
    });

    it("unions CLI badges up the tree", () => {
      const mixed = buildProjectTree([
        folder("hermes-a-slack", "hermes:a:slack", 1, { cli: ["hermes"] }),
        folder("hermes-b-cron", "hermes:b:cron", 2, { cli: ["hermes", "claude"] }),
      ]);
      expect(find(mixed, "hermes")!.cli).toEqual(["hermes", "claude"]);
    });
  });
});

describe("visibleTreeRows", () => {
  const tree = buildProjectTree([
    folder("hermes-default-slack", "hermes:default:slack", 1000),
    folder("hermes-work-telegram", "hermes:work:telegram", 2000),
  ]);

  it("returns every row when nothing is collapsed", () => {
    const rows = visibleTreeRows(tree, () => false);
    expect(rows.map((r) => r.key)).toEqual([
      "hermes",
      "hermes:work",
      "hermes:work:telegram",
      "hermes:default",
      "hermes:default:slack",
    ]);
  });

  it("hides an entire subtree when its root is collapsed", () => {
    const rows = visibleTreeRows(tree, (k) => k === "hermes");
    expect(rows.map((r) => r.key)).toEqual(["hermes"]);
  });

  it("hides only the collapsed branch, not its siblings", () => {
    const rows = visibleTreeRows(tree, (k) => k === "hermes:work");
    expect(rows.map((r) => r.key)).toEqual([
      "hermes",
      "hermes:work",
      "hermes:default",
      "hermes:default:slack",
    ]);
  });

  it("lists every collapsible row and no leaves", () => {
    expect(collapsibleKeys(tree)).toEqual(["hermes", "hermes:work", "hermes:default"]);
  });
});
