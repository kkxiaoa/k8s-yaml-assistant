import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { JUDGE_MAX_TOKENS, judge } from './judge';
import {
  JudgeAttemptSchema,
  JudgeVoteSchema,
  computeBooleanQuorum,
  computeResponseBehaviorQuorum,
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

type FakeResponse =
  | string
  | Error
  | {
      content: Array<{ type: string; text?: string }>;
      stop_reason?: unknown;
    };

function fakeClient(
  responses: FakeResponse[],
  requests: Anthropic.MessageCreateParamsNonStreaming[] = [],
): Anthropic {
  let index = 0;
  return {
    messages: {
      create: async (request: Anthropic.MessageCreateParamsNonStreaming) => {
        requests.push(request);
        const response = responses[index++];
        if (response instanceof Error) throw response;
        if (response === undefined) throw new Error('missing fake response');
        return typeof response === 'string'
          ? { content: [{ type: 'text', text: response }] }
          : response;
      },
    },
  } as unknown as Anthropic;
}

const RESPONSE_METADATA = {
  stopReason: 'end_turn',
  textBlockCount: 1,
  nonTextBlockCount: 0,
} as const;

function expectInvalid(
  text: string,
  code: Extract<JudgeAttempt, { status: 'invalid' }>['code'],
): void {
  const attempt = parseJudgeAttempt(text, RESPONSE_METADATA);
  assert.equal(attempt.status, 'invalid');
  if (attempt.status === 'invalid') {
    assert.equal(attempt.code, code);
    assert.ok(attempt.reason.length > 0);
    assert.deepEqual(attempt.response, RESPONSE_METADATA);
  }
}

console.log('judge-votes:');

check('strict parser preserves a complete valid vote', () => {
  const vote = {
    faithful: false,
    responseBehavior: 'answer' as const,
    unsupported: ['claim A', 'claim B'],
    reason: '  preserve this reason exactly  ',
    policy: {
      distinguished: true,
      conflictExplained: false,
    },
  };

  assert.deepEqual(
    parseJudgeAttempt(`  ${JSON.stringify(vote)}\n`, RESPONSE_METADATA),
    {
      status: 'valid',
      vote,
    },
  );
});

check('string booleans and missing required vote fields are invalid', () => {
  expectInvalid(
    JSON.stringify({
      faithful: 'false',
      responseBehavior: 'answer',
      unsupported: [],
      reason: 'reason',
    }),
    'invalid_vote',
  );
  expectInvalid(
    JSON.stringify({
      responseBehavior: 'answer',
      unsupported: [],
      reason: 'reason',
    }),
    'invalid_vote',
  );
  expectInvalid(
    JSON.stringify({
      faithful: true,
      responseBehavior: 'answer',
      reason: 'reason',
    }),
    'invalid_vote',
  );
  expectInvalid(
    JSON.stringify({
      faithful: true,
      responseBehavior: 'answer',
      unsupported: [],
    }),
    'invalid_vote',
  );
});

check('live votes require response behavior while reviewed legacy votes remain readable', () => {
  const legacyVote = {
    faithful: true,
    unsupported: [],
    reason: 'supported',
  };
  assert.deepEqual(JudgeVoteSchema.parse(legacyVote), legacyVote);
  expectInvalid(JSON.stringify(legacyVote), 'invalid_vote');
});

check('unsupported and policy values are never coerced', () => {
  expectInvalid(
    JSON.stringify({
      faithful: true,
      responseBehavior: 'answer',
      unsupported: [1],
      reason: 'reason',
    }),
    'invalid_vote',
  );
  for (const value of ['false', 0, null]) {
    expectInvalid(
      JSON.stringify({
        faithful: true,
        responseBehavior: 'answer',
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
      responseBehavior: 'answer',
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
    responseBehavior: 'answer',
    unsupported: [],
    reason: 'reason',
  });
  expectInvalid(`result: ${vote}`, 'invalid_json');
  expectInvalid(`\`\`\`json\n${vote}\n\`\`\``, 'invalid_json');
  expectInvalid('', 'empty_response');
  expectInvalid(
    JSON.stringify({
      faithful: true,
      responseBehavior: 'answer',
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

check('response metadata is bounded and legacy traces remain readable', () => {
  const legacy = {
    status: 'invalid',
    code: 'empty_response',
    reason: 'judge response is empty',
  };
  assert.deepEqual(JudgeAttemptSchema.parse(legacy), legacy);

  assert.deepEqual(
    parseJudgeAttempt('', {
      stopReason: 'supplier_specific',
      textBlockCount: 0,
      nonTextBlockCount: 1,
    }),
    {
      ...legacy,
      response: {
        stopReason: 'unknown',
        textBlockCount: 0,
        nonTextBlockCount: 1,
      },
    },
  );

  assert.deepEqual(
    parseJudgeAttempt('{', {
      stopReason: 'max_tokens',
      textBlockCount: 1,
      nonTextBlockCount: 1,
    }),
    {
      status: 'invalid',
      code: 'invalid_json',
      reason: 'judge response must be one JSON value with no surrounding text',
      response: {
        stopReason: 'max_tokens',
        textBlockCount: 1,
        nonTextBlockCount: 1,
      },
    },
  );
});

await checkAsync('judge request uses its budget and records invalid diagnostics', async () => {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const result = await judge(
    fakeClient(
      [
        {
          content: [{ type: 'thinking' }],
          stop_reason: 'max_tokens',
        },
      ],
      requests,
    ),
    {
      question: 'question',
      context: 'context',
      answer: 'answer',
    },
    1,
  );

  assert.deepEqual(result.attempts, [
    {
      status: 'invalid',
      code: 'empty_response',
      reason: 'judge response is empty',
      response: {
        stopReason: 'max_tokens',
        textBlockCount: 0,
        nonTextBlockCount: 1,
      },
    },
  ]);
  assert.equal(result.verdict, null);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.max_tokens, JUDGE_MAX_TOKENS);
  assert.deepEqual(requests[0]?.messages, [
    {
      role: 'user',
      content:
        '【问题】\nquestion\n\n【生成输入】\ncontext\n\n【回答】\nanswer',
    },
  ]);
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

check('response behavior quorum is independent and ties stay indeterminate', () => {
  assert.deepEqual(
    computeResponseBehaviorQuorum([
      'answer',
      'answer',
      'refusal',
      'non_answer',
    ]),
    {
      quorum: 3,
      responseBehavior: 'answer',
      answerVotes: 2,
      refusalVotes: 1,
      nonAnswerVotes: 1,
      validVotes: 4,
      reachedQuorum: true,
      indeterminateReason: null,
      unstable: true,
    },
  );
  assert.deepEqual(
    computeResponseBehaviorQuorum([
      'answer',
      'answer',
      'refusal',
      'refusal',
    ]),
    {
      quorum: 3,
      responseBehavior: null,
      answerVotes: 2,
      refusalVotes: 2,
      nonAnswerVotes: 0,
      validVotes: 4,
      reachedQuorum: true,
      indeterminateReason: 'tie',
      unstable: true,
    },
  );
});

await checkAsync('faith judge records failures and stops at the first valid vote', async () => {
  const validVote = {
    faithful: true,
    responseBehavior: 'answer' as const,
    unsupported: [],
    reason: 'supported',
  };
  const result = await judge(
    fakeClient([
      JSON.stringify({
        faithful: 'true',
        responseBehavior: 'answer',
        unsupported: [],
        reason: 'coerced',
      }),
      JSON.stringify(validVote),
    ]),
    {
      question: 'question',
      context: 'context',
      answer: 'answer',
    },
    2,
  );

  assert.deepEqual(
    result.attempts.map((attempt) => attempt.status),
    ['invalid', 'valid'],
  );
  assert.deepEqual(result.verdict, validVote);

  const failed = await judge(
    fakeClient([new Error('request failed'), 'not json']),
    {
      question: 'question',
      context: 'context',
      answer: 'answer',
    },
    2,
  );
  assert.deepEqual(
    failed.attempts.map((attempt) => attempt.status),
    ['error', 'invalid'],
  );
  assert.equal(failed.verdict, null);
});

console.log(`\n通过 ${passed} 项`);
