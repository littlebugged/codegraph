#!/usr/bin/env node
/**
 * One-shot script: open an existing sub-repo index and run workspace MOA linking.
 * Usage: node scripts/run-moa-link.js <project-root>
 */
const path = require('path');
const CodeGraph = require('../dist/index').default;
const { linkMoaAcrossWorkspace } = require('../dist/workspace/moa-linker');

async function main() {
  const projectRoot = path.resolve(process.argv[2] || '.');
  console.log(`Opening index at ${projectRoot} ...`);

  const cg = await CodeGraph.open(projectRoot);
  try {
    // Access internal queries + resolution context
    const queries = cg.queries ?? cg._queries ?? Object.values(cg).find(v => v?.insertEdges);
    const resolver = cg.resolver ?? cg._resolver ?? Object.values(cg).find(v => v?.getResolutionContext);

    if (!queries || !resolver) {
      // Try direct field access via prototype trick
      console.log('Available keys:', Object.keys(cg));
      console.error('Cannot access queries/resolver. Checking internal fields...');
      // Fallback: expose via the class
      const fields = Object.getOwnPropertyNames(cg);
      console.log('Own properties:', fields);
      process.exit(1);
    }

    resolver.warmCaches();
    const ctx = resolver.getResolutionContext();

    console.log('Running MOA workspace linking...');
    const count = await linkMoaAcrossWorkspace({
      projectRoot,
      queries,
      context: ctx,
    });
    console.log(`Done. MOA edges linked: ${count}`);
  } finally {
    cg.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
