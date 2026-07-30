#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootPkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const VERSION = rootPkg.version;
const DRY_RUN = process.argv.includes('--dry-run');
const distTagIdx = process.argv.indexOf('--dist-tag');
const DIST_TAG = distTagIdx !== -1 ? process.argv[distTagIdx + 1] : (VERSION.includes('-') ? 'beta' : 'latest');

const ALIASES = [
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

const warnings = [];

for (const name of ALIASES) {
  const tmpDir = join('/tmp', `npm-alias-${name}-${Date.now()}`);
  const binDir = join(tmpDir, 'bin');
  mkdirSync(binDir, { recursive: true });

  const pkg = {
    name,
    version: VERSION,
    description: `Alias for failproofai — installs if you typed '${name}' instead of 'failproofai'`,
    bin: { [name]: './bin/proxy.js' },
    files: ['bin/'],
    dependencies: { failproofai: VERSION },
    publishConfig: { access: 'public' },
    repository: rootPkg.repository,
    homepage: rootPkg.homepage,
    bugs: rootPkg.bugs,
    license: rootPkg.license,
  };

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
    // --ignore-scripts for the same reason the main publish step uses it: the
    // generated alias package must never gain a lifecycle script that runs on
    // the publisher's machine (or, transitively, on every installer's).
    execSync(`npm publish --ignore-scripts --tag ${DIST_TAG}`, { cwd: tmpDir, stdio: 'pipe' });
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
