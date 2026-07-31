import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const scriptPath = resolve('scripts/k3s-image-preheat.sh');
const script = readFileSync(scriptPath, 'utf8');

function pattern(name: 'STABLE_TAG_PATTERN' | 'ROLLBACK_TAG_PATTERN'): string {
  const match = new RegExp(`readonly ${name}='([^']+)'`, 'u').exec(script);
  assert.ok(match?.[1], `${name} must be declared`);
  return match[1];
}

function matchTag(value: string, regex: string, group = '0'): string | null {
  const result = spawnSync(
    'bash',
    [
      '-c',
      'regex=$1; value=$2; group=$3; [[ "$value" =~ $regex ]] || exit 2; printf "%s" "${BASH_REMATCH[$group]}"',
      'bash',
      regex,
      value,
      group,
    ],
    { encoding: 'utf8' },
  );
  if (result.status === 2) {
    return null;
  }
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('image preheat script is executable shell with bounded tag help', () => {
  assert.notEqual(statSync(scriptPath).mode & 0o111, 0);
  execFileSync('bash', ['-n', scriptPath]);
  const help = execFileSync('bash', [scriptPath, '--help'], {
    encoding: 'utf8',
  });
  assert.match(help, /k3s-image-preheat\.sh vX\.Y\.Z/u);
  assert.match(
    help,
    /rollback-vX\.Y\.Z-sha256-<64位摘要>-r<运行号>/u,
  );
});

test('image preheat archives a direct OCI layout instead of an archive wrapper', () => {
  assert.doesNotMatch(script, /oci-archive:/u);
  assert.match(script, /"oci:\$layout_path"/u);
  assert.match(script, /"oci:\/work\/image\.oci"/u);
  assert.match(
    script,
    /COPYFILE_DISABLE=1 tar -C "\$layout_path" -cf "\$archive_path" \./u,
  );
});

test('image preheat tag patterns accept stable and canonical rollback drafts', () => {
  const stable = pattern('STABLE_TAG_PATTERN');
  const rollback = pattern('ROLLBACK_TAG_PATTERN');
  const digest = 'b'.repeat(64);

  assert.equal(matchTag('v0.2.0', stable), 'v0.2.0');
  assert.equal(matchTag('v01.2.0', stable), null);
  assert.equal(
    matchTag(`rollback-v0.1.0-sha256-${digest}-r30324645187`, rollback, '4'),
    digest,
  );
  assert.equal(
    matchTag(`rollback-v0.1.0-sha256-${digest.toUpperCase()}-r1`, rollback),
    null,
  );
  assert.equal(
    matchTag(`rollback-v0.1.0-sha256-${digest}-r0`, rollback),
    null,
  );
  assert.equal(
    matchTag(
      `rollback-v0.1.0-sha256-${digest}-r123456789012345678901234567890123`,
      rollback,
    ),
    null,
  );
  assert.match(script, /image_digest="\$rollback_digest"/u);
});
