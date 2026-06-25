/**
 * MOA (Momo Service Architecture) edge synthesis for Java MiraiMind codebases.
 *
 * Closes two RPC gaps static parsing cannot see:
 *
 *  (1) Consumer outbound — @MoaManager method calls moa().foo() which dispatches
 *      to @MoaProvider(uri=...) implementation in another module/repo.
 *
 *  (2) Goback / delay MOA callback — setCallBackUri + setCallBackMethod (or
 *      GobackHelper.submit*) registers an async callback to a Provider method.
 *
 * Edges are persisted as provenance:'heuristic' calls edges so codegraph_explore
 * follows them automatically without extra query parameters.
 */
import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
import { stripCommentsForRegex } from './strip-comments';

export const MOA_PROVIDER_URI_RE =
  /@MoaProvider\s*\([^)]*?\buri\s*=\s*"([^"]+)"/;
const MOA_MANAGER_URI =
  /@MoaManager\s*\([^)]*?\bserviceUri\s*=\s*"([^"]+)"/;
const MOA_CALL_RE = /\bmoa\(\)\.(\w+)\s*\(/g;
const CALLBACK_URI_RE = /setCallBackUri\s*\(\s*"([^"]+)"/;
const CALLBACK_METHOD_RE = /setCallBackMethod\s*\(\s*"([^"]+)"/;
const GOBACK_SUBMIT_RE =
  /gobackHelper\.(?:submitDelayMsg|submit)\s*\([^;]*?,\s*"([^"]+)"\s*,\s*"([^"]+)"/g;

const SHADOW_PREFIX = 'moa-xrepo:';

export interface ProviderEntry {
  /** Workspace repo folder name, e.g. miraimind-moa; empty for implicit local */
  repoName: string;
  filePath: string;
  className: string;
  serviceUri: string;
  methods: Map<string, Node>;
}

export interface MoaSynthesisOptions {
  /** Repo folder name for cross-repo metadata; defaults to first path segment */
  currentRepoName?: string;
  /** Providers loaded from sibling repos (methods are original nodes) */
  externalProviders?: Map<string, ProviderEntry>;
  /** Replace prior MOA heuristic edges before inserting (sync-safe) */
  replaceExisting?: boolean;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Top-level directory under the workspace root, e.g. miraimind-server */
function workspaceModule(filePath: string): string {
  const parts = normalizePath(filePath).split('/');
  return parts[0] ?? '';
}

function isCrossRepo(
  sourceRepo: string,
  targetRepo: string,
  sourcePath: string,
  targetPath: string,
): boolean {
  if (sourceRepo && targetRepo) return sourceRepo !== targetRepo;
  const a = workspaceModule(sourcePath);
  const b = workspaceModule(targetPath);
  return a.length > 0 && b.length > 0 && a !== b;
}

function extractMethodBody(content: string, method: Node): string {
  const lines = content.split('\n');
  const start = Math.max(0, method.startLine - 1);
  const end = Math.min(lines.length, method.endLine);
  return lines.slice(start, end).join('\n');
}

function classNameFromContent(content: string): string | null {
  const m = content.match(/\bclass\s+(\w+)/);
  return m?.[1] ?? null;
}

function pathBaseName(filePath: string): string {
  const base = normalizePath(filePath).split('/').pop() ?? '';
  return base.replace(/\.java$/, '');
}

export function shadowNodeId(repoName: string, originalId: string): string {
  return `${SHADOW_PREFIX}${repoName}:${originalId}`;
}

function toShadowNode(repoName: string, node: Node): Node {
  const rel = normalizePath(node.filePath);
  const prefixedPath = rel.startsWith(`${repoName}/`) ? rel : `${repoName}/${rel}`;
  return {
    ...node,
    id: shadowNodeId(repoName, node.id),
    filePath: prefixedPath,
    qualifiedName: `${repoName}::${node.qualifiedName}`,
    updatedAt: Date.now(),
  };
}

function ensureShadowTarget(
  queries: QueryBuilder,
  targetRepo: string,
  currentRepo: string,
  target: Node,
): Node {
  if (!targetRepo || targetRepo === currentRepo) return target;
  const shadow = toShadowNode(targetRepo, target);
  queries.insertNode(shadow);
  return shadow;
}

export function buildProviderRegistry(
  ctx: ResolutionContext,
  repoName = '',
): Map<string, ProviderEntry> {
  const registry = new Map<string, ProviderEntry>();
  for (const filePath of ctx.getAllFiles()) {
    if (!filePath.endsWith('.java')) continue;
    const content = ctx.readFile(filePath);
    if (!content?.includes('@MoaProvider')) continue;
    const uriMatch = content.match(MOA_PROVIDER_URI_RE);
    if (!uriMatch?.[1]) continue;
    const serviceUri = uriMatch[1];
    const className = classNameFromContent(content) ?? pathBaseName(filePath);
    const methods = new Map<string, Node>();
    for (const node of ctx.getNodesInFile(filePath)) {
      if (node.kind === 'method') methods.set(node.name, node);
    }
    registry.set(serviceUri, { repoName, filePath, className, serviceUri, methods });
  }
  return registry;
}

function makeEdge(
  source: Node,
  target: Node,
  synthesizedBy: 'moa-consumer' | 'moa-goback',
  serviceUri: string,
  sourceRepo: string,
  targetRepo: string,
  methodName?: string,
): Edge {
  const crossRepo = isCrossRepo(sourceRepo, targetRepo, source.filePath, target.filePath);
  return {
    source: source.id,
    target: target.id,
    kind: 'calls',
    line: source.startLine,
    provenance: 'heuristic',
    metadata: {
      synthesizedBy,
      serviceUri,
      method: methodName ?? target.name,
      crossRepo,
      sourceModule: sourceRepo || workspaceModule(source.filePath),
      targetModule: targetRepo || workspaceModule(target.filePath),
      registeredAt: `${target.filePath}:${target.startLine}`,
    },
  };
}

function synthesizeConsumerEdges(
  ctx: ResolutionContext,
  providers: Map<string, ProviderEntry>,
  queries: QueryBuilder,
  currentRepo: string,
): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const filePath of ctx.getAllFiles()) {
    if (!filePath.endsWith('MoaManager.java') && !filePath.includes('/moa/')) continue;
    const content = ctx.readFile(filePath);
    if (!content?.includes('@MoaManager')) continue;
    const uriMatch = content.match(MOA_MANAGER_URI);
    if (!uriMatch?.[1]) continue;
    const serviceUri = uriMatch[1];
    const provider = providers.get(serviceUri);
    if (!provider) continue;
    const stripped = stripCommentsForRegex(content, 'java');
    for (const method of ctx.getNodesInFile(filePath)) {
      if (method.kind !== 'method') continue;
      const body = extractMethodBody(stripped, method);
      let m: RegExpExecArray | null;
      MOA_CALL_RE.lastIndex = 0;
      while ((m = MOA_CALL_RE.exec(body)) !== null) {
        const methodName = m[1];
        if (!methodName) continue;
        const rawTarget = provider.methods.get(methodName);
        if (!rawTarget) continue;
        const target = ensureShadowTarget(queries, provider.repoName, currentRepo, rawTarget);
        const key = `${method.id}>${target.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(
          makeEdge(
            method,
            target,
            'moa-consumer',
            serviceUri,
            currentRepo,
            provider.repoName,
            methodName,
          ),
        );
      }
    }
  }
  return edges;
}

function synthesizeGobackEdges(
  ctx: ResolutionContext,
  providers: Map<string, ProviderEntry>,
  queries: QueryBuilder,
  currentRepo: string,
): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const filePath of ctx.getAllFiles()) {
    if (!filePath.endsWith('.java')) continue;
    const content = ctx.readFile(filePath);
    if (!content) continue;
    const hasCallback =
      content.includes('setCallBackUri') ||
      content.includes('CallBackType.MOA') ||
      content.includes('gobackHelper');
    if (!hasCallback) continue;
    const stripped = stripCommentsForRegex(content, 'java');
    for (const method of ctx.getNodesInFile(filePath)) {
      if (method.kind !== 'method') continue;
      const body = extractMethodBody(stripped, method);
      const uri = body.match(CALLBACK_URI_RE)?.[1];
      const methodName = body.match(CALLBACK_METHOD_RE)?.[1];
      if (uri && methodName) {
        const provider = providers.get(uri);
        const rawTarget = provider?.methods.get(methodName);
        if (rawTarget && provider) {
          const target = ensureShadowTarget(queries, provider.repoName, currentRepo, rawTarget);
          const key = `${method.id}>${target.id}:goback`;
          if (!seen.has(key)) {
            seen.add(key);
            edges.push(
              makeEdge(method, target, 'moa-goback', uri, currentRepo, provider.repoName, methodName),
            );
          }
        }
      }
      let gm: RegExpExecArray | null;
      GOBACK_SUBMIT_RE.lastIndex = 0;
      while ((gm = GOBACK_SUBMIT_RE.exec(body)) !== null) {
        const gUri = gm[1];
        const gMethod = gm[2];
        if (!gUri || !gMethod) continue;
        const provider = providers.get(gUri);
        const rawTarget = provider?.methods.get(gMethod);
        if (!rawTarget || !provider) continue;
        const target = ensureShadowTarget(queries, provider.repoName, currentRepo, rawTarget);
        const key = `${method.id}>${target.id}:goback-submit`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(
          makeEdge(method, target, 'moa-goback', gUri, currentRepo, provider.repoName, gMethod),
        );
      }
    }
  }
  return edges;
}

/**
 * Synthesize MOA consumer + goback callback edges. Best-effort — never throws.
 */
export function synthesizeMoaEdges(
  queries: QueryBuilder,
  ctx: ResolutionContext,
  options: MoaSynthesisOptions = {},
): number {
  const currentRepo =
    options.currentRepoName ??
    workspaceModule(ctx.getAllFiles()[0] ?? '') ??
    '';

  const local = buildProviderRegistry(ctx, currentRepo);
  const merged = new Map(local);
  for (const [uri, entry] of options.externalProviders ?? []) {
    merged.set(uri, entry);
  }
  if (merged.size === 0) return 0;

  if (options.replaceExisting) {
    queries.deleteMoaSynthesizedEdges();
  }

  const mergedEdges: Edge[] = [];
  const seen = new Set<string>();
  for (const e of [
    ...synthesizeConsumerEdges(ctx, merged, queries, currentRepo),
    ...synthesizeGobackEdges(ctx, merged, queries, currentRepo),
  ]) {
    const key = `${e.source}>${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mergedEdges.push(e);
  }
  if (mergedEdges.length > 0) queries.insertEdges(mergedEdges);
  return mergedEdges.length;
}
