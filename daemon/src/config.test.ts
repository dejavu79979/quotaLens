// Config persistence (PLAN T1.5 / M2 / M8 / M9): ~/.quotalens/config.json holds the tailnet host, mode 600.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_OAUTH_CANONICAL_URL,
  CODEX_BACKEND_CANONICAL_URL,
  readExtraHost,
  relayBase,
  sendsCredentials,
  USAGE_PATH,
  writeExtraHost,
} from './config.ts';

function scratch(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'quotalens-config-'));
  return { dir, path: join(dir, 'nested', 'config.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// codex review 2026-09-08: an unvalidated URL override would ship the OAuth token to any host in clear
// text. Only the provider's canonical endpoint may carry credentials.
test('sendsCredentials is true only for the provider canonical URL', () => {
  assert.equal(sendsCredentials(CLAUDE_OAUTH_CANONICAL_URL, CLAUDE_OAUTH_CANONICAL_URL), true);
  assert.equal(sendsCredentials(CODEX_BACKEND_CANONICAL_URL, CODEX_BACKEND_CANONICAL_URL), true);
  for (const bad of [
    'http://example.invalid/usage',
    'http://127.0.0.1:1/x',
    'https://api.anthropic.com.evil.test/api/oauth/usage',
    'http://api.anthropic.com/api/oauth/usage', // same host, clear text
  ]) {
    assert.equal(sendsCredentials(bad, CLAUDE_OAUTH_CANONICAL_URL), false, bad);
    assert.equal(sendsCredentials(bad, CODEX_BACKEND_CANONICAL_URL), false, bad);
  }
});

// PLAN M9: one route, no secret; the phone pastes the origin and the plugin adds the path.
test('the §3 route is /usage.json and the relay base is the origin only', () => {
  assert.equal(USAGE_PATH, '/usage.json');
  assert.equal(relayBase('100.64.0.9'), 'http://100.64.0.9:8787');
});

// PLAN M2 (2026-09-09 owner ruling): the daemon may additionally listen on the machine's tailnet
// IPv4 and on nothing else — never 0.0.0.0, never a LAN address. A bad value is ignored, not obeyed.
test('readExtraHost accepts only a 100.64.0.0/10 address from config.json', () => {
  const s = scratch();
  try {
    assert.equal(readExtraHost(s.path), null, 'no file → no extra listener');
    mkdirSync(join(s.dir, 'nested'), { recursive: true, mode: 0o700 });
    for (const [host, expected] of [
      ['100.64.0.9', '100.64.0.9'],
      ['100.64.0.1', '100.64.0.1'],
      ['100.127.255.254', '100.127.255.254'],
      ['100.63.255.255', null], // just below the range
      ['100.128.0.1', null], // just above the range
      ['0.0.0.0', null],
      ['192.168.1.5', null],
      ['127.0.0.1', null], // already bound unconditionally; not an "extra" host
      ['desk.tail1234.ts.net', null], // literal IPv4 only, no resolution
      ['', null],
      [42, null],
    ] as const) {
      writeFileSync(s.path, JSON.stringify({ host }));
      assert.equal(readExtraHost(s.path), expected, String(host));
    }
    writeFileSync(s.path, JSON.stringify({}));
    assert.equal(readExtraHost(s.path), null, 'absent key → no extra listener');
  } finally {
    s.cleanup();
  }
});

// codex review 2026-09-09: the rejection line used to echo the value.
test('readExtraHost never echoes a rejected host value', () => {
  const s = scratch();
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  try {
    mkdirSync(join(s.dir, 'nested'), { recursive: true, mode: 0o700 });
    writeFileSync(s.path, JSON.stringify({ host: 'http://100.64.0.9:8787/usage.json' }));
    assert.equal(readExtraHost(s.path), null);
    assert.equal(lines.length, 1, 'one warning');
    assert.equal(lines[0]!.includes('100.64.0.9'), false, 'the value is not echoed at all');
    assert.match(lines[0]!, /100\.64\.0\.0\/10/);
  } finally {
    console.error = original;
    s.cleanup();
  }
});

// PLAN M8 T8.2: the installer's host write goes through the same rule as the daemon's host read.
test('writeExtraHost creates the file 0600 in a 0700 dir, keeps other keys, and refuses what readExtraHost would refuse', () => {
  const s = scratch();
  try {
    assert.equal(writeExtraHost('100.64.0.9', s.path), true);
    assert.deepEqual(JSON.parse(readFileSync(s.path, 'utf8')), { host: '100.64.0.9' });
    assert.equal(readExtraHost(s.path), '100.64.0.9');
    assert.equal(statSync(s.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(s.dir, 'nested')).mode & 0o777, 0o700);
    assert.equal(existsSync(`${s.path}.tmp`), false, 'atomic write leaves no temp file behind');
    for (const bad of ['0.0.0.0', '192.168.1.5', '100.128.0.1', 'host.ts.net', '']) {
      assert.equal(writeExtraHost(bad, s.path), false, bad);
    }
    assert.deepEqual(JSON.parse(readFileSync(s.path, 'utf8')), { host: '100.64.0.9' }, 'refusals leave the file alone');
    // A pre-M9 config still carries `secret`; the write keeps it (unread) rather than rewriting the file wholesale.
    writeFileSync(s.path, JSON.stringify({ secret: 'A'.repeat(32), host: '100.64.0.1' }), { mode: 0o600 });
    assert.equal(writeExtraHost('100.64.0.9', s.path), true);
    assert.deepEqual(JSON.parse(readFileSync(s.path, 'utf8')), { secret: 'A'.repeat(32), host: '100.64.0.9' });
  } finally {
    s.cleanup();
  }
});
