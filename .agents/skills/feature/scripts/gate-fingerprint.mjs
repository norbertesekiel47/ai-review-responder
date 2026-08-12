#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const command = process.argv[2];
if (!['write', 'check', 'print'].includes(command)) {
  console.error('usage: gate-fingerprint.mjs <write|check|print>');
  process.exit(2);
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    stdio: ['ignore', 'pipe', options.ignoreStderr ? 'ignore' : 'pipe'],
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const featureDir = join(root, '.feature');
const gatePath = join(featureDir, 'gate-status.json');
const intakePath = join(featureDir, 'intake.json');
const fingerprintPath = join(featureDir, 'codex-gate-fingerprint.json');

function fileHash(path) {
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}

function untrackedHash() {
  const output = git(['ls-files', '--others', '--exclude-standard', '-z']);
  const paths = output
    .split('\0')
    .filter((path) => path && path !== '.feature/codex-gate-fingerprint.json')
    .sort();
  const hash = createHash('sha256');
  for (const relativePath of paths) {
    const absolutePath = join(root, relativePath);
    const stat = lstatSync(absolutePath);
    hash.update(relativePath);
    hash.update('\0');
    hash.update(stat.isSymbolicLink() ? `symlink:${readlinkSync(absolutePath)}` : readFileSync(absolutePath));
    hash.update('\0');
  }
  return { count: paths.length, hash: hash.digest('hex') };
}

function currentEvidence() {
  if (!existsSync(gatePath)) throw new Error('missing .feature/gate-status.json');
  if (!existsSync(intakePath)) throw new Error('missing .feature/intake.json');

  const gateStatus = JSON.parse(readFileSync(gatePath, 'utf8'));
  if (gateStatus.passed !== true) throw new Error('repository verify gate is not green');

  let baseSha = null;
  try {
    baseSha = git(['merge-base', 'HEAD', 'origin/main'], { ignoreStderr: true }).trim();
  } catch {
    baseSha = null;
  }

  const untracked = untrackedHash();
  const evidence = {
    version: 1,
    branch: git(['branch', '--show-current']).trim(),
    headSha: git(['rev-parse', 'HEAD']).trim(),
    baseSha,
    intakeSha256: fileHash(intakePath),
    gateStatusSha256: fileHash(gatePath),
    stagedDiffSha256: sha256(git([
      'diff', '--cached', '--binary', '--no-ext-diff', '--', '.',
      ':(exclude).feature/codex-gate-fingerprint.json',
    ])),
    unstagedDiffSha256: sha256(git([
      'diff', '--binary', '--no-ext-diff', '--', '.',
      ':(exclude).feature/codex-gate-fingerprint.json',
    ])),
    statusSha256: sha256(git([
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.',
      ':(exclude).feature/codex-gate-fingerprint.json',
    ])),
    untrackedCount: untracked.count,
    untrackedSha256: untracked.hash,
    lockfileSha256: fileHash(join(root, 'pnpm-lock.yaml')),
  };

  return { evidence, fingerprint: sha256(JSON.stringify(evidence)) };
}

try {
  const current = currentEvidence();

  if (command === 'print') {
    console.log(JSON.stringify(current, null, 2));
    process.exit(0);
  }

  if (command === 'write') {
    writeFileSync(
      fingerprintPath,
      `${JSON.stringify({
        ...current,
        generatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
    );
    console.log(`gate fingerprint written: ${current.fingerprint}`);
    process.exit(0);
  }

  if (!existsSync(fingerprintPath)) {
    throw new Error('missing .feature/codex-gate-fingerprint.json; run verified-gate.sh');
  }
  const stored = JSON.parse(readFileSync(fingerprintPath, 'utf8'));
  if (stored.fingerprint !== current.fingerprint) {
    console.error(`gate fingerprint stale:\n  stored:  ${stored.fingerprint}\n  current: ${current.fingerprint}`);
    process.exit(1);
  }
  console.log(`gate fingerprint current: ${current.fingerprint}`);
} catch (error) {
  console.error(`gate fingerprint failed: ${error.message}`);
  process.exit(1);
}
