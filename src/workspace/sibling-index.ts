/**
 * Ensure sibling repos in a workspace are indexed before MOA cross-repo linking.
 */
import * as fs from 'fs';
import { isInitialized } from '../directory';
import { logDebug } from '../errors';
import type { WorkspaceLayout } from './config';
import { siblingRepoPaths } from './config';

const loadCodeGraph = (): typeof import('../index').default =>
  (require('../index') as typeof import('../index')).default;

/**
 * Sync sibling repos that host MOA providers we need. Skips `excludeRepoName`
 * (the repo that triggered the current sync). Uses `skipWorkspaceMoaLink` on
 * nested syncs to avoid recursive sibling fan-out.
 */
export async function ensureSiblingIndexes(
  layout: WorkspaceLayout,
  siblingNames: Iterable<string>,
  excludeRepoName: string | null,
): Promise<string[]> {
  const paths = siblingRepoPaths(layout);
  const updated: string[] = [];
  const CodeGraph = loadCodeGraph();

  for (const name of siblingNames) {
    if (name === excludeRepoName) continue;
    const abs = paths.get(name);
    if (!abs || !fs.existsSync(abs)) continue;

    try {
      if (!isInitialized(abs)) {
        logDebug('MOA workspace: initializing sibling repo', { name, abs });
        await CodeGraph.init(abs, { index: true });
        updated.push(name);
        continue;
      }
      const cg = await CodeGraph.open(abs);
      try {
        const before = cg.getStats().fileCount;
        const result = await cg.sync({ skipWorkspaceMoaLink: true });
        if (result.filesAdded > 0 || result.filesModified > 0 || result.filesRemoved > 0) {
          updated.push(name);
          logDebug('MOA workspace: synced sibling', { name, result });
        } else if (before === 0) {
          updated.push(name);
        }
      } finally {
        cg.close();
      }
    } catch (err) {
      logDebug('MOA workspace: sibling sync failed', {
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return updated;
}
