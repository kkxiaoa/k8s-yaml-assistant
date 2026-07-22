import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SERVING_REDACTION_HARD_MAX_INPUT_BYTES,
  SERVING_REDACTION_HARD_MAX_TEXT_BYTES,
  ServingRedactionError,
  redactServingQuestion,
} from './redaction';

const OPTIONS = {
  maxInputBytes: 64 * 1024,
  maxTextBytes: 8 * 1024,
};

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

test('redacts Kubernetes Secret fields and credential-shaped structured values', () => {
  const dataSecret = 'VGVzdERhdGFTZWNyZXQ=';
  const stringSecret = 'TestStringSecretValue';
  const nestedPassword = 'TestNestedPasswordValue';
  const result = redactServingQuestion(
    `apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: Secret
    metadata:
      name: demo
    data:
      password: ${dataSecret}
    stringData:
      token: ${stringSecret}
  - kind: ConfigMap
    data:
      password: ${nestedPassword}
`,
    OPTIONS,
  );

  assert.equal(result.disposition, 'redacted');
  assert.ok(result.redactionLabels.includes('k8s_secret'));
  assert.ok(result.redactionLabels.includes('credential_assignment'));
  const output = serialized(result);
  for (const secret of [dataSecret, stringSecret, nestedPassword]) {
    assert.equal(output.includes(secret), false);
  }
  assert.match(output, /\[REDACTED\]/);
});

test('redacts bearer, JWT, private key, assignment, and URL credentials', () => {
  const bearer = 'TestBearerCredential0123456789';
  const jwt =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.TestJwtSignature123';
  const password = 'TestPasswordCredential123';
  const urlPassword = 'TestUrlPassword123';
  const queryToken = 'TestQueryToken123';
  const privateKey = `-----BEGIN PRIVATE KEY-----
TestPrivateKeyMaterial123
-----END PRIVATE KEY-----`;
  const input = `Authorization: Bearer ${bearer}
token ${jwt}
password=${password}
${privateKey}
https://alice:${urlPassword}@example.test/path?token=${queryToken}&safe=1`;

  const result = redactServingQuestion(input, OPTIONS);

  assert.equal(result.disposition, 'redacted');
  assert.deepEqual(
    new Set(result.redactionLabels),
    new Set([
      'bearer_token',
      'jwt',
      'private_key',
      'credential_assignment',
      'url_credential',
    ]),
  );
  const output = serialized(result);
  for (const secret of [
    bearer,
    jwt,
    password,
    urlPassword,
    queryToken,
    'TestPrivateKeyMaterial123',
  ]) {
    assert.equal(output.includes(secret), false);
  }
});

test('redacts prefixed environment credentials and generic secret keys', () => {
  const deepseekKey = 'TestDeepseekCredential123';
  const voyageKey = 'TestVoyageCredential123';
  const genericSecret = 'TestGenericSecret123';
  const structuredAuth = 'TestStructuredAuth123';
  const textResult = redactServingQuestion(
    `set DEEPSEEK_API_KEY=${deepseekKey}, VOYAGE_API_KEY=${voyageKey}, and secret=${genericSecret}`,
    OPTIONS,
  );
  const structuredResult = redactServingQuestion(
    JSON.stringify({ config: { auth: structuredAuth } }),
    OPTIONS,
  );

  assert.equal(textResult.disposition, 'redacted');
  assert.equal(structuredResult.disposition, 'redacted');
  assert.ok(textResult.redactionLabels.includes('credential_assignment'));
  assert.ok(structuredResult.redactionLabels.includes('credential_assignment'));
  const output = serialized([textResult, structuredResult]);
  for (const secret of [
    deepseekKey,
    voyageKey,
    genericSecret,
    structuredAuth,
  ]) {
    assert.equal(output.includes(secret), false);
  }
});

test('does not classify dotted Kubernetes field paths as JWTs', () => {
  const input =
    'explain specification.templatepath.containerpath.securitycontext';
  const result = redactServingQuestion(input, OPTIONS);

  assert.deepEqual(result, {
    disposition: 'redacted',
    text: input,
    redactionVersion: 'serving-redaction/v1',
    redactionLabels: [],
  });
});

test('drops oversized input before parsing or truncating a sensitive tail', () => {
  const tailSecret = 'TestOversizedTailCredential123';
  const result = redactServingQuestion(
    `${'a'.repeat(64)} password=${tailSecret}`,
    { maxInputBytes: 32, maxTextBytes: 16 },
  );

  assert.deepEqual(result, {
    disposition: 'dropped_invalid',
    redactionVersion: 'serving-redaction/v1',
    redactionLabels: [],
  });
  assert.equal(serialized(result).includes(tailSecret), false);
});

test('enforces the system input hard cap even at the maximum allowed option', () => {
  const result = redactServingQuestion(
    'a'.repeat(SERVING_REDACTION_HARD_MAX_INPUT_BYTES + 1),
    {
      maxInputBytes: SERVING_REDACTION_HARD_MAX_INPUT_BYTES,
      maxTextBytes: SERVING_REDACTION_HARD_MAX_TEXT_BYTES,
    },
  );

  assert.equal(result.disposition, 'dropped_invalid');
  assert.equal('text' in result, false);
});

test('truncates only after redaction and preserves UTF-8 boundaries', () => {
  const tailSecret = 'TestTruncatedTailCredential123';
  const result = redactServingQuestion(
    `${'配置'.repeat(20)} password=${tailSecret}`,
    { maxInputBytes: 512, maxTextBytes: 25 },
  );

  assert.equal(result.disposition, 'redacted');
  assert.ok(result.redactionLabels.includes('credential_assignment'));
  assert.ok(result.redactionLabels.includes('truncated'));
  assert.ok(Buffer.byteLength(result.text, 'utf8') <= 25);
  assert.equal(result.text.isWellFormed(), true);
  assert.equal(result.text.includes(tailSecret), false);
});

test('drops suspicious structured input that cannot be parsed safely', () => {
  const secret = 'TestMalformedYamlSecret123';
  const result = redactServingQuestion(
    `apiVersion: v1
kind: Secret
data: [unterminated
password: ${secret}`,
    OPTIONS,
  );

  assert.equal(result.disposition, 'dropped_sensitive');
  assert.equal('text' in result, false);
  assert.ok(result.redactionLabels.includes('k8s_secret'));
  assert.equal(serialized(result).includes(secret), false);
});

test('drops structured alias expansion beyond the reviewed boundary', () => {
  const aliases = Array.from({ length: 40 }, () => '*shared').join(', ');
  const result = redactServingQuestion(
    `shared: &shared { value: safe }
items: [${aliases}]`,
    OPTIONS,
  );

  assert.equal(result.disposition, 'dropped_sensitive');
  assert.equal('text' in result, false);
});

test('does not bypass the alias boundary with YAML punctuation in names', () => {
  const aliases = Array.from({ length: 40 }, () => '*shared.value').join(', ');
  const result = redactServingQuestion(
    `shared: &shared.value { value: safe }\nitems: [${aliases}]`,
    OPTIONS,
  );

  assert.equal(result.disposition, 'dropped_sensitive');
  assert.equal('text' in result, false);
});

test('drops custom tags and structured inputs beyond depth or node bounds', () => {
  let tooDeep: unknown = 'leaf';
  for (let depth = 0; depth < 40; depth++) {
    tooDeep = { nested: tooDeep };
  }

  for (const input of [
    'apiVersion: v1\nkind: ConfigMap\ndata:\n  value: !custom unsafe',
    JSON.stringify(tooDeep),
    JSON.stringify({ items: Array.from({ length: 5_000 }, () => 'safe') }),
  ]) {
    const result = redactServingQuestion(input, OPTIONS);
    assert.equal(result.disposition, 'dropped_sensitive');
    assert.equal('text' in result, false);
  }
});

test('second scan rejects a high-confidence credential missed by replacement', () => {
  const accessKey = 'AKIAIOSFODNN7EXAMPLE';

  assert.throws(
    () => redactServingQuestion(`use ${accessKey}`, OPTIONS),
    (error: unknown) => {
      assert.ok(error instanceof ServingRedactionError);
      assert.equal(error.code, 'verification_failed');
      assert.equal(error.message.includes(accessKey), false);
      return true;
    },
  );
});

test('internal failures expose only a stable error code', () => {
  const internalSecret = 'TestInternalFailureSecret123';
  const options = Object.defineProperty({}, 'maxInputBytes', {
    get() {
      throw new Error(internalSecret);
    },
  });

  assert.throws(
    () =>
      redactServingQuestion(
        'safe question',
        options as typeof OPTIONS,
      ),
    (error: unknown) => {
      assert.ok(error instanceof ServingRedactionError);
      assert.equal(error.code, 'redaction_internal');
      assert.equal(error.message.includes(internalSecret), false);
      return true;
    },
  );
});

test('hard caps cannot be enlarged by caller options', () => {
  for (const options of [
    {
      maxInputBytes: SERVING_REDACTION_HARD_MAX_INPUT_BYTES + 1,
      maxTextBytes: 1024,
    },
    {
      maxInputBytes: 2048,
      maxTextBytes: SERVING_REDACTION_HARD_MAX_TEXT_BYTES + 1,
    },
    { maxInputBytes: 2048, maxTextBytes: 4096 },
  ]) {
    assert.throws(
      () => redactServingQuestion('safe', options),
      (error: unknown) => {
        assert.ok(error instanceof ServingRedactionError);
        assert.equal(error.code, 'invalid_options');
        return true;
      },
    );
  }
});
