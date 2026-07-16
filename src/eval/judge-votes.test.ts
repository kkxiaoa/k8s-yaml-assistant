import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { judge } from './judge';
import {
  JudgeAttemptSchema,
  computeBooleanQuorum,
  parseJudgeAttempt,
  type JudgeAttempt,
} from './judge-votes';

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(
      `  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

async function checkAsync(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(
      `  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

function fakeClient(responses: Array<string | Error>): Anthropic {
  let index = 0;
  return {
    messages: {
      create: async () => {
        const response = responses[index++];
        if (response instanceof Error) throw response;
        if (response === undefined) throw new Error('missing fake response');
        return { content: [{ type: 'text', text: response }] };
      },
    },
  } as unknown as Anthropic;
}

function expectInvalid(
  text: string,
  code: Extract<JudgeAttempt, { status: 'invalid' }>['code'],
): void {
  const attempt = parseJudgeAttempt(text);
  assert.equal(attempt.status, 'invalid');
  if (attempt.status === 'invalid') {
    assert.equal(attempt.code, code);
    assert.ok(attempt.reason.length > 0);
  }
}

console.log('judge-votes:');

check('strict parser preserves a complete valid vote', () => {
  const vote = {
    faithful: false,
    unsupported: ['claim A', 'claim B'],
    reason: '  preserve this reason exactly  ',
    policy: {
      distinguished: true,
      conflictExplained: false,
    },
  };

  assert.deepEqual(parseJudgeAttempt(`  ${JSON.stringify(vote)}\n`), {
    status: 'valid',
    vote,
  });
});

check('string booleans and missing required vote fields are invalid', () => {
  expectInvalid(
    JSON.stringify({ faithful: 'false', unsupported: [], reason: 'reason' }),
    'invalid_vote',
  );
  expectInvalid(
    JSON.stringify({ unsupported: [], reason: 'reason' }),
    'invalid_vote',
  );
  expectInvalid(
    JSON.stringify({ faithful: true, reason: 'reason' }),
    'invalid_vote',
  );
  expectInvalid(
    JSON.stringify({ faithful: true, unsupported: [] }),
    'invalid_vote',
  );
});

check('unsupported and policy values are never coerced', () => {
  expectInvalid(
    JSON.stringify({ faithful: true, unsupported: [1], reason: 'reason' }),
    'invalid_vote',
  );
  for (const value of ['false', 0, null]) {
    expectInvalid(
      JSON.stringify({
        faithful: true,
        unsupported: [],
        reason: 'reason',
        policy: { distinguished: value },
      }),
      'invalid_vote',
    );
  }
  expectInvalid(
    JSON.stringify({
      faithful: true,
      unsupported: [],
      reason: 'reason',
      policy: null,
    }),
    'invalid_vote',
  );
});

check('surrounding prose, code fences, empty output, and unknown fields fail', () => {
  const vote = JSON.stringify({
    faithful: true,
    unsupported: [],
    reason: 'reason',
  });
  expectInvalid(`result: ${vote}`, 'invalid_json');
  expectInvalid(`\`\`\`json\n${vote}\n\`\`\``, 'invalid_json');
  expectInvalid('', 'empty_response');
  expectInvalid(
    JSON.stringify({
      faithful: true,
      unsupported: [],
      reason: 'reason',
      extra: true,
    }),
    'invalid_vote',
  );
});

check('judge request errors use the shared stable stage', () => {
  assert.deepEqual(
    JudgeAttemptSchema.parse({
      status: 'error',
      stage: 'judge_request',
      message: 'request failed',
    }),
    {
      status: 'error',
      stage: 'judge_request',
      message: 'request failed',
    },
  );
  assert.throws(() =>
    JudgeAttemptSchema.parse({
      status: 'error',
      stage: 'model_request',
      message: 'request failed',
    }),
  );
});

check('one or two valid votes cannot form a negative conclusion', () => {
  assert.deepEqual(computeBooleanQuorum([false]), {
    quorum: 3,
    value: null,
    trueVotes: 0,
    falseVotes: 1,
    validVotes: 1,
    reachedQuorum: false,
    indeterminateReason: 'insufficient_valid_votes',
    unstable: false,
  });
  assert.deepEqual(computeBooleanQuorum([false, false]), {
    quorum: 3,
    value: null,
    trueVotes: 0,
    falseVotes: 2,
    validVotes: 2,
    reachedQuorum: false,
    indeterminateReason: 'insufficient_valid_votes',
    unstable: false,
  });
});

check('a tied quorum is indeterminate instead of false', () => {
  assert.deepEqual(computeBooleanQuorum([true, true, false, false]), {
    quorum: 3,
    value: null,
    trueVotes: 2,
    falseVotes: 2,
    validVotes: 4,
    reachedQuorum: true,
    indeterminateReason: 'tie',
    unstable: true,
  });
});

check('a non-tied quorum forms a majority and preserves instability', () => {
  assert.deepEqual(computeBooleanQuorum([true, true, false]), {
    quorum: 3,
    value: true,
    trueVotes: 2,
    falseVotes: 1,
    validVotes: 3,
    reachedQuorum: true,
    indeterminateReason: null,
    unstable: true,
  });
  assert.deepEqual(computeBooleanQuorum([false, false, false]), {
    quorum: 3,
    value: false,
    trueVotes: 0,
    falseVotes: 3,
    validVotes: 3,
    reachedQuorum: true,
    indeterminateReason: null,
    unstable: false,
  });
});

await checkAsync('faith judge records failures and stops at the first valid vote', async () => {
  const validVote = {
    faithful: true,
    unsupported: [],
    reason: 'supported',
  };
  const result = await judge(
    fakeClient([
      JSON.stringify({
        faithful: 'true',
        unsupported: [],
        reason: 'coerced',
      }),
      JSON.stringify(validVote),
    ]),
    'context',
    'answer',
    2,
  );

  assert.deepEqual(
    result.attempts.map((attempt) => attempt.status),
    ['invalid', 'valid'],
  );
  assert.deepEqual(result.verdict, validVote);

  const failed = await judge(
    fakeClient([new Error('request failed'), 'not json']),
    'context',
    'answer',
    2,
  );
  assert.deepEqual(
    failed.attempts.map((attempt) => attempt.status),
    ['error', 'invalid'],
  );
  assert.equal(failed.verdict, null);
});

console.log(`\n通过 ${passed} 项`);
