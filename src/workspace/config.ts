/**
 * Multi-repo workspace config (`codegraph.workspace.yaml`).
 * Placed at a parent directory (e.g. cc/) listing sibling project roots.
 */
import * as fs from 'fs';
import * as path from 'path';

export const WORKSPACE_CONFIG_NAME = 'codegraph.workspace.yaml';

export interface WorkspaceConfig {
  /** Directory names relative to the workspace file, e.g. miraimind-server */
  roots: string[];
}

export interface WorkspaceLayout {
  /** Absolute path to the directory containing codegraph.workspace.yaml */
  workspaceDir: string;
  config: WorkspaceConfig;
}

function parseWorkspaceYaml(content: string): WorkspaceConfig | null {
  const roots: string[] = [];
  let inRoots = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed === 'roots:') {
      inRoots = true;
      continue;
    }
    if (inRoots) {
      const m = trimmed.match(/^-\s+(.+)$/);
      if (m?.[1]) {
        roots.push(m[1].trim().replace(/^["']|["']$/g, ''));
        continue;
      }
      if (!trimmed.startsWith('-')) inRoots = false;
    }
  }
  return roots.length > 0 ? { roots } : null;
}

/**
 * Walk up from `startPath` looking for codegraph.workspace.yaml.
 */
export function findWorkspaceLayout(startPath: string): WorkspaceLayout | null {
  let current = path.resolve(startPath);
  const fsRoot = path.parse(current).root;
  while (true) {
    const configPath = path.join(current, WORKSPACE_CONFIG_NAME);
    if (fs.existsSync(configPath)) {
      try {
        const config = parseWorkspaceYaml(fs.readFileSync(configPath, 'utf-8'));
        if (config) return { workspaceDir: current, config };
      } catch {
        return null;
      }
    }
    if (current === fsRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** Absolute paths of sibling repo roots (initialized or not). */
export function siblingRepoPaths(layout: WorkspaceLayout): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of layout.config.roots) {
    out.set(name, path.join(layout.workspaceDir, name));
  }
  return out;
}

/** Repo folder name for an absolute project root inside a workspace. */
export function repoNameInWorkspace(projectRoot: string, layout: WorkspaceLayout): string | null {
  const resolved = path.resolve(projectRoot);
  for (const name of layout.config.roots) {
    const candidate = path.join(layout.workspaceDir, name);
    if (path.resolve(candidate) === resolved) return name;
  }
  return null;
}
