/**
 * Workspace-aware MOA linking: on sub-repo sync, resolve cross-repo MOA edges
 * by syncing sibling repos that host matching @MoaProvider implementations.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from '../resolution/types';
import { logDebug } from '../errors';
import { isInitialized } from '../directory';
import {
  MOA_PROVIDER_URI_RE,
  buildProviderRegistry,
  synthesizeMoaEdges,
  type ProviderEntry,
} from '../resolution/moa-synthesizer';
import {
  findWorkspaceLayout,
  repoNameInWorkspace,
  siblingRepoPaths,
  type WorkspaceLayout,
} from './config';
import { ensureSiblingIndexes } from './sibling-index';

const MOA_MANAGER_URI =
  /@MoaManager\s*\([^)]*?\bserviceUri\s*=\s*"([^"]+)"/;
const CALLBACK_URI_RE = /setCallBackUri\s*\(\s*"([^"]+)"/;
const GOBACK_SUBMIT_URI_RE =
  /gobackHelper\.(?:submitDelayMsg|submit)\s*\([^;]*?,\s*"([^"]+)"/g;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'build',
  'dist',
  '.codegraph',
  '.idea',
]);

const loadCodeGraph = (): typeof import('../index').default =>
  (require('../index') as typeof import('../index')).default;

function walkJavaFiles(
  root: string,
  onFile: (relativePath: string, content: string) => void,
): void {
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = rel ? path.join(root, rel) : root;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(childRel);
        continue;
      }
      if (!entry.name.endsWith('.java')) continue;
      try {
        const content = fs.readFileSync(path.join(root, childRel), 'utf-8');
        onFile(childRel.replace(/\\/g, '/'), content);
      } catch {
        // unreadable file — skip
      }
    }
  }
}

/** serviceUri → relative java file path */
export function scanProviderUrisInRepo(repoRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  walkJavaFiles(repoRoot, (relPath, content) => {
    if (!content.includes('@MoaProvider')) return;
    const m = content.match(MOA_PROVIDER_URI_RE);
    if (m?.[1]) out.set(m[1], relPath);
  });
  return out;
}

/** URIs referenced by @MoaManager / Goback in the indexed project */
export function collectReferencedServiceUris(ctx: ResolutionContext): Set<string> {
  const uris = new Set<string>();
  for (const filePath of ctx.getAllFiles()) {
    if (!filePath.endsWith('.java')) continue;
    const content = ctx.readFile(filePath);
    if (!content) continue;
    const manager = content.match(MOA_MANAGER_URI);
    if (manager?.[1]) uris.add(manager[1]);
    if (
      content.includes('setCallBackUri') ||
      content.includes('gobackHelper') ||
      content.includes('CallBackType.MOA')
    ) {
      const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      const cb = stripped.match(CALLBACK_URI_RE);
      if (cb?.[1]) uris.add(cb[1]);
      let gm: RegExpExecArray | null;
      GOBACK_SUBMIT_URI_RE.lastIndex = 0;
      while ((gm = GOBACK_SUBMIT_URI_RE.exec(stripped)) !== null) {
        if (gm[1]) uris.add(gm[1]);
      }
    }
  }
  return uris;
}

async function loadProvidersFromRepo(
  repoName: string,
  repoRoot: string,
): Promise<Map<string, ProviderEntry>> {
  const registry = new Map<string, ProviderEntry>();
  const uriFiles = scanProviderUrisInRepo(repoRoot);
  if (uriFiles.size === 0) return registry;
  if (!isInitialized(repoRoot)) return registry;

  const CodeGraph = loadCodeGraph();
  const cg = await CodeGraph.open(repoRoot);
  try {
    for (const [serviceUri, relPath] of uriFiles) {
      let content = '';
      try {
        content = fs.readFileSync(path.join(repoRoot, relPath), 'utf-8');
      } catch {
        continue;
      }
      const classMatch = content.match(/\bclass\s+(\w+)/);
      const className = classMatch?.[1] ?? relPath.split('/').pop()?.replace(/\.java$/, '') ?? '';
      const methods = new Map<string, Node>();
      for (const node of cg.getNodesInFile(relPath)) {
        if (node.kind === 'method') methods.set(node.name, node);
      }
      registry.set(serviceUri, {
        repoName,
        filePath: relPath,
        className,
        serviceUri,
        methods,
      });
    }
  } finally {
    cg.close();
  }
  return registry;
}

function siblingsForUris(
  layout: WorkspaceLayout,
  currentRepo: string | null,
  referenced: Set<string>,
  localProviders: Map<string, ProviderEntry>,
): Set<string> {
  const needed = new Set<string>();
  const paths = siblingRepoPaths(layout);
  for (const uri of referenced) {
    if (localProviders.has(uri)) continue;
    for (const [name, root] of paths) {
      if (name === currentRepo) continue;
      if (!fs.existsSync(root)) continue;
      if (scanProviderUrisInRepo(root).has(uri)) needed.add(name);
    }
  }
  return needed;
}

export interface MoaLinkParams {
  projectRoot: string;
  queries: QueryBuilder;
  context: ResolutionContext;
}

/**
 * Link MOA edges for the current repo. When a workspace layout exists, syncs
 * sibling repos that host providers for referenced service URIs.
 */
export async function linkMoaAcrossWorkspace(params: MoaLinkParams): Promise<number> {
  const { projectRoot, queries, context } = params;
  const referenced = collectReferencedServiceUris(context);
  if (referenced.size === 0) return 0;

  const layout = findWorkspaceLayout(projectRoot);
  const currentRepo = layout ? repoNameInWorkspace(projectRoot, layout) : null;
  const localProviders = buildProviderRegistry(context, currentRepo ?? '');

  const externalProviders = new Map<string, ProviderEntry>();

  if (layout) {
    const needed = siblingsForUris(layout, currentRepo, referenced, localProviders);
    if (needed.size > 0) {
      logDebug('MOA workspace: syncing sibling providers', {
        currentRepo,
        siblings: [...needed],
      });
      await ensureSiblingIndexes(layout, needed, currentRepo);
      const paths = siblingRepoPaths(layout);
      for (const name of needed) {
        const root = paths.get(name);
        if (!root) continue;
        const loaded = await loadProvidersFromRepo(name, root);
        for (const [uri, entry] of loaded) externalProviders.set(uri, entry);
      }
    }
  }

  const count = synthesizeMoaEdges(queries, context, {
    currentRepoName: currentRepo ?? undefined,
    externalProviders,
    replaceExisting: true,
  });
  logDebug('MOA workspace: linked edges', { count, currentRepo });
  return count;
}
