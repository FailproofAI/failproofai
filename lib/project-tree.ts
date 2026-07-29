/**
 * Folder tree for the projects panel.
 *
 * Gateway CLIs (Hermes, OpenClaw) are USER-scoped: their sessions have no
 * working directory, so they can't sit in the cwd-based project model the other
 * CLIs use. What they have instead is a hierarchy — which profile/agent, then
 * which channel — and that hierarchy is already encoded in the synthetic
 * `path` those producers emit (`hermes:work:slack`,
 * `openclaw:weather-bot:telegram`).
 *
 * So this is a pure PRESENTATION transform over the flat `ProjectFolder[]` the
 * server already returns: split those paths into nodes, leave every real
 * filesystem project as a top-level leaf. Nothing about project `name`s
 * changes, which is what keeps existing `/project/<name>` links, bookmarks and
 * stored audit history resolving.
 *
 * Pure and dependency-free on purpose — `import type` only, so the client
 * bundle never pulls in `lib/projects.ts`'s node:fs imports.
 */
import type { ProjectCli, ProjectFolder } from "./projects";
import { syntheticPathSegments } from "./paths";

export interface ProjectTreeNode {
  /** Colon-joined segment path (`hermes:work`) — stable across renders, used as
   *  the React key and as the collapsed-state key. */
  key: string;
  /** The single segment this row shows (`work`), not the whole path. */
  label: string;
  /** 0 for top-level rows; each level below adds 1 (drives indentation). */
  depth: number;
  children: ProjectTreeNode[];
  /** The real project, on rows that map to one. Leaves always have it; a folder
   *  row has it only if a project exists at exactly that path. Rows without one
   *  are pure grouping and must not link anywhere. */
  project?: ProjectFolder;
  /** Sessions beneath this row, summed. `undefined` when nothing underneath
   *  reported a count — rendered as nothing rather than as `0`, since the two
   *  mean very different things. */
  sessionCount?: number;
  /** How many real projects this row covers (1 for a leaf). Lets the caller
   *  paginate over top-level rows while still reporting a project range. */
  projectCount: number;
  /** Newest activity anywhere beneath this row. */
  lastModified: Date;
  lastModifiedFormatted?: string;
  /** Union of the CLIs beneath this row, in first-seen order. */
  cli: ProjectCli[];
}

interface Builder {
  key: string;
  label: string;
  depth: number;
  children: Map<string, Builder>;
  project?: ProjectFolder;
  sessionCount?: number;
  projectCount: number;
  lastModified: Date;
  lastModifiedFormatted?: string;
  cli: string[];
}

function makeBuilder(key: string, label: string, depth: number): Builder {
  return {
    key,
    label,
    depth,
    children: new Map(),
    projectCount: 0,
    lastModified: new Date(0),
    cli: [],
  };
}

/** Fold a project's stats into a node — newest date wins, counts add, CLIs union. */
function absorb(node: Builder, folder: ProjectFolder): void {
  if (folder.lastModified.getTime() > node.lastModified.getTime()) {
    node.lastModified = folder.lastModified;
    node.lastModifiedFormatted = folder.lastModifiedFormatted;
  }
  if (typeof folder.sessionCount === "number") {
    node.sessionCount = (node.sessionCount ?? 0) + folder.sessionCount;
  }
  node.projectCount += 1;
  for (const c of folder.cli) if (!node.cli.includes(c)) node.cli.push(c);
}

function finalize(node: Builder): ProjectTreeNode {
  const children = [...node.children.values()]
    .map(finalize)
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return {
    key: node.key,
    label: node.label,
    depth: node.depth,
    children,
    project: node.project,
    sessionCount: node.sessionCount,
    projectCount: node.projectCount,
    lastModified: node.lastModified,
    lastModifiedFormatted: node.lastModifiedFormatted,
    cli: node.cli as ProjectCli[],
  };
}

/**
 * Build the render tree for a list of projects (already filtered, sorted and
 * paginated by the caller — this adds no policy of its own).
 *
 * Real filesystem projects become depth-0 leaves in input order-by-recency,
 * exactly as the flat table showed them. Gateway projects nest under one node
 * per path segment.
 */
export function buildProjectTree(folders: ProjectFolder[]): ProjectTreeNode[] {
  const roots = new Map<string, Builder>();

  for (const folder of folders) {
    const segments = syntheticPathSegments(folder.path);

    if (segments.length === 0) {
      // Real filesystem project — a top-level leaf, keyed by name so two
      // projects with an identical path (or none) can't collide.
      const node = makeBuilder(`project:${folder.name}`, folder.name, 0);
      node.project = folder;
      absorb(node, folder);
      roots.set(node.key, node);
      continue;
    }

    let level = roots;
    let key = "";
    let node: Builder | undefined;
    for (let depth = 0; depth < segments.length; depth++) {
      const label = segments[depth];
      key = depth === 0 ? label : `${key}:${label}`;
      let next = level.get(key);
      if (!next) {
        next = makeBuilder(key, label, depth);
        level.set(key, next);
      }
      // Every ancestor rolls up the project's stats, so a collapsed folder still
      // reports the freshest activity and total sessions underneath it.
      absorb(next, folder);
      node = next;
      level = next.children;
    }
    // The deepest segment IS this project. Guard against two projects claiming
    // the same path (shouldn't happen post-merge, but silently losing one would
    // be worse than keeping the first).
    if (node && !node.project) node.project = folder;
  }

  return [...roots.values()]
    .map(finalize)
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
}

/**
 * Flatten the tree to the rows actually rendered, honouring collapsed state.
 *
 * We track COLLAPSED rather than expanded keys deliberately: a profile or agent
 * that appears for the first time should be visible, not hidden behind a click
 * the user doesn't know to make.
 */
export function visibleTreeRows(
  nodes: ProjectTreeNode[],
  isCollapsed: (key: string) => boolean,
): ProjectTreeNode[] {
  const out: ProjectTreeNode[] = [];
  const walk = (list: ProjectTreeNode[]) => {
    for (const node of list) {
      out.push(node);
      if (node.children.length > 0 && !isCollapsed(node.key)) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** Keys of every node that has children — i.e. every collapsible row. */
export function collapsibleKeys(nodes: ProjectTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: ProjectTreeNode[]) => {
    for (const node of list) {
      if (node.children.length > 0) {
        out.push(node.key);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}
