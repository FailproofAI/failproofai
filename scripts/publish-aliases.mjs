#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { daemonOptionalDependencies } from './daemon-platforms.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootPkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const VERSION = rootPkg.version;
const DRY_RUN = process.argv.includes('--dry-run');
const distTagIdx = process.argv.indexOf('--dist-tag');
const DIST_TAG = distTagIdx !== -1 ? process.argv[distTagIdx + 1] : (VERSION.includes('-') ? 'beta' : 'latest');

export const ALIASES = [
  // Formatting variants — no "ai", or hyphen/underscore separators
  'failproof',
  'failproof-ai',
  'fail-proof-ai',
  'failproof_ai',
  'fail_proof_ai',
  'fail-proofai',
  // Missing one 'o' from "proof" — common single-char slip
  'failprof',
  'failprof-ai',
  'failprofai',
  'fail-prof-ai',
  'failprof_ai',
  // 'a'/'i' transposition — common keyboard slip
  'faliproof',
  'faliproof-ai',
  'faliproofai',
];

/**
 * The manifest one alias stub publishes.
 *
 * The four `@failproofai/failproofaid-<platform>` pins are the same ones the
 * root package carries. They arrive transitively through the `failproofai`
 * dependency anyway, but naming them here means someone who installs a typo'd
 * name gets the daemon binary for exactly the reason the root package does,
 * rather than by accident of resolution — and a test can assert it.
 */
export function aliasManifest(name, version = VERSION, pkg = rootPkg) {
  return {
    name,
    version,
    description: `Alias for failproofai — installs if you typed '${name}' instead of 'failproofai'`,
    bin: { [name]: './bin/proxy.js' },
    files: ['bin/'],
    dependencies: { failproofai: version },
    optionalDependencies: daemonOptionalDependencies(version),
    publishConfig: { access: 'public' },
    repository: pkg.repository,
    homepage: pkg.homepage,
    bugs: pkg.bugs,
    license: pkg.license,
  };
}

export function main() {
  const warnings = [];

  for (const name of ALIASES) {
    const tmpDir = join('/tmp', `npm-alias-${name}-${Date.now()}`);
    const binDir = join(tmpDir, 'bin');
    mkdirSync(binDir, { recursive: true });

    const pkg = aliasManifest(name);

    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    cpSync(join(__dirname, 'alias-proxy.js'), join(binDir, 'proxy.js'));

    if (DRY_RUN) {
      console.log(`[dry-run] Would publish ${name}@${VERSION} (tag: ${DIST_TAG})`);
      console.log(JSON.stringify(pkg, null, 2));
      console.log('---');
      rmSync(tmpDir, { recursive: true, force: true });
      continue;
    }

    console.log(`Publishing ${name}@${VERSION}...`);
    try {
      execSync(`npm publish --tag ${DIST_TAG}`, { cwd: tmpDir, stdio: 'pipe' });
      console.log(`Done: ${name}`);
    } catch (err) {
      const output = (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '');
      if (output.includes('too similar')) {
        warnings.push(`${name}: blocked by npm similarity check — request via npm support`);
      } else if (output.includes('cannot publish over')) {
        console.log(`[skip] ${name}: already published at ${VERSION}`);
      } else {
        warnings.push(`${name}: ${output.trim().split('\n').find(l => l.includes('npm error')) ?? 'unknown error'}`);
      }
    }

    rmSync(tmpDir, { recursive: true, force: true });
  }

  if (warnings.length > 0) {
    console.log('\n::warning::Some alias packages were not published:');
    for (const w of warnings) console.log(`  - ${w}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
