#!/usr/bin/env node

// Serves the /feature live view and writes its publishable snapshot.
//
//   live-view.mjs start [--port 7717]   detached local server, prints the URL
//   live-view.mjs status
//   live-view.mjs stop
//   live-view.mjs snapshot [--out <path>]
//   live-view.mjs serve --port <n>      foreground loop (used by `start`)
//
// The page is stored as an Artifact-compatible fragment: no doctype, html,
// head or body tags. `serve` wraps it in a minimal document for the browser;
// `snapshot` inlines the data and leaves the fragment untouched so it can be
// published as an Artifact unchanged.

import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSnapshot, featureDir, repoRoot } from './lib/feature-snapshot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, 'live-view-page.html');
const DEFAULT_PORT = 7717;
const PORT_ATTEMPTS = 20;

const USAGE = `usage:
  live-view.mjs start [--port <n>]
  live-view.mjs status
  live-view.mjs stop
  live-view.mjs snapshot [--out <path>]
  live-view.mjs serve --port <n>`;

function fail(message) {
  console.error(message);
  process.exit(2);
}

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) flags[name] = true;
    else {
      flags[name] = next;
      index += 1;
    }
  }
  return flags;
}

const root = repoRoot();
const liveDir = join(featureDir(root), 'live');
const registryPath = join(liveDir, 'server.json');

function readRegistry() {
  if (!existsSync(registryPath)) return null;
  try {
    return JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch {
    return null;
  }
}

// True only when the pid names one of OUR servers. A bare existence check is
// not enough: a registry left behind by a crash keeps a stale pid, the OS
// reuses pids, and the two failure modes that follow are both bad — `stop`
// SIGTERMs an unrelated process, and `start` reports "already running" while
// pointing at a URL nothing is serving. The command line settles it.
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return command.includes('live-view.mjs');
  } catch {
    // ps is unavailable or the process vanished between the two calls.
    return false;
  }
}

function fragment() {
  return readFileSync(TEMPLATE, 'utf8');
}

function pageTitle(html) {
  const match = html.match(/<title>([^<]*)<\/title>/i);
  return match ? match[1] : 'Feature Run Recorder';
}

function document_(html) {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${pageTitle(html)}</title>`,
    '</head>',
    '<body>',
    html,
    '</body>',
    '</html>',
  ].join('\n');
}

// Strip machine-local paths before the snapshot leaves this machine.
function publishable(snapshot) {
  const { root: _root, live: _live, ...rest } = snapshot;
  return rest;
}

function inlineData(html, data) {
  const payload = JSON.stringify(data).replace(/</g, '\\u003c');
  const bootstrap = `<script>window.__FEATURE_SNAPSHOT__ = ${payload};</script>\n`;
  const index = html.indexOf('<script>');
  if (index === -1) fail('live-view-page.html has no <script> block to anchor the snapshot');
  return html.slice(0, index) + bootstrap + html.slice(index);
}

// ------------------------------------------------------------------ serve

function serve(port) {
  const page = document_(fragment());

  const server = createServer((request, response) => {
    // Match the path, not the raw URL. A cache-busting `?v=2` must still reach
    // the page, and a browser that re-uses an in-memory document has no other
    // way to be forced past it.
    const path = request.url.split('?')[0];

    if (path === '/api/state') {
      const body = JSON.stringify(buildSnapshot(root));
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(body);
      return;
    }
    if (path === '/' || path === '/index.html') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(page);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });

  let attempt = 0;
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && attempt < PORT_ATTEMPTS) {
      attempt += 1;
      server.listen(port + attempt, '127.0.0.1');
      return;
    }
    console.error(`live view failed: ${error.message}`);
    process.exit(1);
  });

  server.on('listening', () => {
    const actual = server.address().port;
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(
      registryPath,
      `${JSON.stringify(
        {
          version: 1,
          pid: process.pid,
          port: actual,
          url: `http://127.0.0.1:${actual}`,
          root,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    console.log(`live view: http://127.0.0.1:${actual}`);
  });

  const shutdown = () => {
    const registry = readRegistry();
    if (registry?.pid === process.pid) rmSync(registryPath, { force: true });
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.listen(port, '127.0.0.1');
}

// ------------------------------------------------------------------- main

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
const port = flags.port ? Number(flags.port) : DEFAULT_PORT;

switch (command) {
  case 'start': {
    const registry = readRegistry();
    if (registry && alive(registry.pid)) {
      console.log(`live view already running: ${registry.url}`);
      break;
    }
    rmSync(registryPath, { force: true });

    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--port', String(port)], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    // The child writes its registration once it is listening. Wait so the
    // caller can print a real URL instead of a promise of one.
    //
    // On timeout the child MUST be killed. `stop` can only target a pid the
    // registry names, so a child that never registered is unreachable: it
    // holds its port until the machine reboots. An earlier 4s deadline with no
    // kill leaked exactly that way whenever the machine was loaded enough to
    // slow the child's boot past the deadline.
    const deadline = Date.now() + 15_000;
    const waitForRegistry = () => {
      const next = readRegistry();
      if (next?.url) {
        console.log(`live view: ${next.url}  (pid ${next.pid})`);
        return;
      }
      if (Date.now() > deadline) {
        try {
          process.kill(child.pid, 'SIGTERM');
        } catch {
          // already gone; nothing to reclaim
        }
        console.error(
          `live view did not register within 15s; stopped the unregistered server (pid ${child.pid})`,
        );
        process.exitCode = 1;
        return;
      }
      setTimeout(waitForRegistry, 100);
    };
    waitForRegistry();
    break;
  }

  case 'status': {
    const registry = readRegistry();
    if (!registry) {
      console.log('live view: not running');
      break;
    }
    console.log(
      alive(registry.pid)
        ? `live view: ${registry.url} (pid ${registry.pid}, since ${registry.startedAt})`
        : `live view: stale registration for pid ${registry.pid}; run \`live-view.mjs stop\``,
    );
    break;
  }

  case 'stop': {
    const registry = readRegistry();
    if (!registry) {
      console.log('live view: not running');
      break;
    }
    if (alive(registry.pid)) {
      try {
        process.kill(registry.pid, 'SIGTERM');
      } catch (error) {
        console.error(`could not stop pid ${registry.pid}: ${error.message}`);
      }
    }
    rmSync(registryPath, { force: true });
    console.log('live view: stopped');
    break;
  }

  case 'snapshot': {
    const out = flags.out
      ? resolve(String(flags.out))
      : join(liveDir, 'snapshot.html');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, inlineData(fragment(), publishable(buildSnapshot(root))));
    console.log(out);
    break;
  }

  case 'serve':
    serve(port);
    break;

  default:
    fail(USAGE);
}
