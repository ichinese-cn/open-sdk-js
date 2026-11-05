#!/usr/bin/env node
// Builds the web JS SDK: dist/index.js (ESM, for bundlers), dist/ichinese-open.js (one file, global
// `ichinese`, for a <script> tag served from each region's own static origin) and the type declarations.
//
//   node build.mjs                 everything into dist/
//   node build.mjs --script <dir>  only the single-file script, into <dir>/ichinese-open.js
//                                  (apps/web's predev/prebuild: public/open-js-sdk/<major>/)
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const scriptDir = process.argv.includes('--script') ? process.argv[process.argv.indexOf('--script') + 1] : null;
const common = {
  entryPoints: [join(here, 'src/index.ts')],
  bundle: true,
  platform: 'browser',
  target: 'es2019',
  logLevel: 'warning',
};

/** The single-file script for a <script> tag. */
export async function buildScript(outfile) {
  mkdirSync(dirname(outfile), { recursive: true });
  await build({ ...common, format: 'iife', globalName: 'ichinese', minify: true, outfile, legalComments: 'none' });
}

if (scriptDir) {
  await buildScript(resolve(scriptDir, 'ichinese-open.js'));
  console.log(`@ichinese/open-js-sdk → ${scriptDir}/ichinese-open.js`);
} else {
  rmSync(join(here, 'dist'), { recursive: true, force: true });
  await build({ ...common, format: 'esm', outfile: join(here, 'dist/index.js') });
  await buildScript(join(here, 'dist/ichinese-open.js'));
  // By its path, not through a package manager: this also builds outside the workspace, with plain npm.
  execFileSync(
    process.execPath,
    [createRequire(import.meta.url).resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'],
    { cwd: here, stdio: 'inherit' },
  );
  console.log('@ichinese/open-js-sdk → dist/');
}
