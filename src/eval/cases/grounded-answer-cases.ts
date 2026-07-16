import { z } from 'zod';
import {
  SourceTypeSchema,
  type SourceType,
} from '../../knowledge/chunk';
import { SOURCE_TYPES } from '../../retrieval/source-policy';
import {
  RETRIEVAL_CASES,
  type SemanticRetrievalCase,
} from './retrieval-cases';

const NonBlankStringSchema = z.string().trim().min(1);
const RetrievalCaseInputSchema = z.strictObject({
  kind: z.literal('retrieval_case'),
  retrievalCaseId: NonBlankStringSchema,
});
const StandaloneQuestionInputSchema = z.strictObject({
  kind: z.literal('standalone_question'),
  question: NonBlankStringSchema,
});

export const GroundedAnswerInputSchema = z.union([
  RetrievalCaseInputSchema,
  StandaloneQuestionInputSchema,
]);

export const GroundedAnswerExpectedBehaviorSchema = z.enum([
  'answer_with_sources',
  'explain_schema_policy_conflict',
  'refuse_insufficient_context',
]);

const SourceTypesSchema = z
  .array(SourceTypeSchema)
  .min(1)
  .superRefine((types, context) => {
    const seen = new Set<SourceType>();
    for (const [index, sourceType] of types.entries()) {
      if (seen.has(sourceType)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate source type: ${sourceType}`,
          path: [index],
        });
      }
      seen.add(sourceType);
    }
  });

export const SourceExpectationSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('required'),
    types: SourceTypesSchema,
  }),
  z.strictObject({
    mode: z.literal('allow_missing_with_disclosure'),
    types: SourceTypesSchema,
  }),
]);

export const SourceCoverageSchema = z.strictObject({
  mode: z.enum(['required', 'allow_missing_with_disclosure']),
  expectedTypes: SourceTypesSchema,
  presentTypes: z.array(SourceTypeSchema),
  missingTypes: z.array(SourceTypeSchema),
  status: z.enum([
    'complete',
    'missing_required',
    'disclosure_required',
  ]),
});

export type SourceExpectation = z.infer<typeof SourceExpectationSchema>;
export type SourceCoverage = z.infer<typeof SourceCoverageSchema>;

export function evaluateSourceExpectation(
  expectation: SourceExpectation | undefined,
  presentTypes: readonly SourceType[],
): SourceCoverage | undefined {
  if (expectation === undefined) return undefined;

  const present = new Set(presentTypes);
  const canonicalPresent = SOURCE_TYPES.filter((sourceType) =>
    present.has(sourceType),
  );
  const missingTypes = expectation.types.filter(
    (sourceType) => !present.has(sourceType),
  );
  return SourceCoverageSchema.parse({
    mode: expectation.mode,
    expectedTypes: expectation.types,
    presentTypes: canonicalPresent,
    missingTypes,
    status:
      missingTypes.length === 0
        ? 'complete'
        : expectation.mode === 'required'
          ? 'missing_required'
          : 'disclosure_required',
  });
}

const ReferencedGroundedAnswerCaseSchema = z
  .strictObject({
    id: NonBlankStringSchema,
    input: RetrievalCaseInputSchema,
    expectedBehavior: z.enum([
      'answer_with_sources',
      'explain_schema_policy_conflict',
    ]),
    sourceExpectation: SourceExpectationSchema.optional(),
  })
  .superRefine((evalCase, context) => {
    if (evalCase.expectedBehavior !== 'explain_schema_policy_conflict') {
      return;
    }
    if (evalCase.sourceExpectation === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'conflict case requires a source expectation',
        path: ['sourceExpectation'],
      });
      return;
    }
    const types = new Set(evalCase.sourceExpectation.types);
    if (!types.has('schema') || !types.has('policy')) {
      context.addIssue({
        code: 'custom',
        message: 'conflict source expectation requires schema and policy',
        path: ['sourceExpectation', 'types'],
      });
    }
  });

const StandaloneGroundedAnswerCaseSchema = z.strictObject({
  id: NonBlankStringSchema,
  input: StandaloneQuestionInputSchema,
  expectedBehavior: z.literal('refuse_insufficient_context'),
});

export const GroundedAnswerCaseSchema = z.union([
  ReferencedGroundedAnswerCaseSchema,
  StandaloneGroundedAnswerCaseSchema,
]);

export type GroundedAnswerCase = z.infer<typeof GroundedAnswerCaseSchema>;

export function decodeGroundedAnswerCases(
  value: unknown,
  retrievalCases: readonly SemanticRetrievalCase[] = RETRIEVAL_CASES,
): GroundedAnswerCase[] {
  const retrievalIds = new Set(retrievalCases.map((evalCase) => evalCase.id));
  return z
    .array(GroundedAnswerCaseSchema)
    .superRefine((cases, context) => {
      const seen = new Set<string>();
      for (const [index, evalCase] of cases.entries()) {
        if (seen.has(evalCase.id)) {
          context.addIssue({
            code: 'custom',
            message: `duplicate grounded answer case id: ${evalCase.id}`,
            path: [index, 'id'],
          });
        }
        seen.add(evalCase.id);

        if (
          evalCase.input.kind === 'retrieval_case' &&
          !retrievalIds.has(evalCase.input.retrievalCaseId)
        ) {
          context.addIssue({
            code: 'custom',
            message: `unknown retrieval case id: ${evalCase.input.retrievalCaseId}`,
            path: [index, 'input', 'retrievalCaseId'],
          });
        }
      }
    })
    .parse(value);
}

export interface ResolvedGroundedAnswerCase {
  id: string;
  input: GroundedAnswerCase['input'];
  expectedBehavior: GroundedAnswerCase['expectedBehavior'];
  sourceExpectation?: SourceExpectation;
  question: string;
  expectedChunkIds: string[];
  target?: SemanticRetrievalCase['target'];
}

export function resolveGroundedAnswerCase(
  evalCase: GroundedAnswerCase,
  retrievalCases: readonly SemanticRetrievalCase[] = RETRIEVAL_CASES,
): ResolvedGroundedAnswerCase {
  if (evalCase.input.kind === 'standalone_question') {
    return {
      ...evalCase,
      question: evalCase.input.question,
      expectedChunkIds: [],
    };
  }

  const retrievalCaseId = evalCase.input.retrievalCaseId;
  const retrievalCase = retrievalCases.find(
    (candidate) => candidate.id === retrievalCaseId,
  );
  if (!retrievalCase) {
    throw new Error(
      `grounded answer case ${evalCase.id} references unknown retrieval case ${retrievalCaseId}`,
    );
  }
  return {
    ...evalCase,
    question: retrievalCase.question,
    expectedChunkIds: retrievalCase.expectedChunkIds,
    target: retrievalCase.target,
  };
}

const ANSWER_WITH_SOURCES = 'answer_with_sources' as const;
const EXPLAIN_SCHEMA_POLICY_CONFLICT =
  'explain_schema_policy_conflict' as const;

export const GROUNDED_ANSWER_CASES = decodeGroundedAnswerCases([
  {
    id: 'pod-image',
    input: { kind: 'retrieval_case', retrievalCaseId: 'pod-image' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'pod-resources-limits',
    input: { kind: 'retrieval_case', retrievalCaseId: 'pod-resources-limits' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'pod-liveness-httpget',
    input: { kind: 'retrieval_case', retrievalCaseId: 'pod-liveness-httpget' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'pod-restartpolicy',
    input: { kind: 'retrieval_case', retrievalCaseId: 'pod-restartpolicy' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'pod-imagepullpolicy',
    input: { kind: 'retrieval_case', retrievalCaseId: 'pod-imagepullpolicy' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'pod-nodeselector',
    input: { kind: 'retrieval_case', retrievalCaseId: 'pod-nodeselector' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'pod-tolerations',
    input: { kind: 'retrieval_case', retrievalCaseId: 'pod-tolerations' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'pod-runasnonroot',
    input: { kind: 'retrieval_case', retrievalCaseId: 'pod-runasnonroot' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'pod-volumes',
    input: { kind: 'retrieval_case', retrievalCaseId: 'pod-volumes' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'pod-serviceaccountname',
    input: { kind: 'retrieval_case', retrievalCaseId: 'pod-serviceaccountname' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'pod-containerport',
    input: { kind: 'retrieval_case', retrievalCaseId: 'pod-containerport' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'pod-env',
    input: { kind: 'retrieval_case', retrievalCaseId: 'pod-env' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'deploy-replicas',
    input: { kind: 'retrieval_case', retrievalCaseId: 'deploy-replicas' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'deploy-strategy-type',
    input: { kind: 'retrieval_case', retrievalCaseId: 'deploy-strategy-type' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'deploy-maxunavailable',
    input: { kind: 'retrieval_case', retrievalCaseId: 'deploy-maxunavailable' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'deploy-selector',
    input: { kind: 'retrieval_case', retrievalCaseId: 'deploy-selector' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'deploy-container-image',
    input: { kind: 'retrieval_case', retrievalCaseId: 'deploy-container-image' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'deploy-revisionhistory',
    input: { kind: 'retrieval_case', retrievalCaseId: 'deploy-revisionhistory' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'sts-servicename',
    input: { kind: 'retrieval_case', retrievalCaseId: 'sts-servicename' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'sts-volumeclaimtemplates',
    input: { kind: 'retrieval_case', retrievalCaseId: 'sts-volumeclaimtemplates' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'sts-podmanagementpolicy',
    input: { kind: 'retrieval_case', retrievalCaseId: 'sts-podmanagementpolicy' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'sts-updatestrategy',
    input: { kind: 'retrieval_case', retrievalCaseId: 'sts-updatestrategy' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'ds-updatestrategy',
    input: { kind: 'retrieval_case', retrievalCaseId: 'ds-updatestrategy' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'job-completions',
    input: { kind: 'retrieval_case', retrievalCaseId: 'job-completions' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'job-parallelism',
    input: { kind: 'retrieval_case', retrievalCaseId: 'job-parallelism' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'job-backofflimit',
    input: { kind: 'retrieval_case', retrievalCaseId: 'job-backofflimit' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'job-ttl',
    input: { kind: 'retrieval_case', retrievalCaseId: 'job-ttl' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'cronjob-schedule',
    input: { kind: 'retrieval_case', retrievalCaseId: 'cronjob-schedule' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'cronjob-concurrencypolicy',
    input: { kind: 'retrieval_case', retrievalCaseId: 'cronjob-concurrencypolicy' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'cronjob-suspend',
    input: { kind: 'retrieval_case', retrievalCaseId: 'cronjob-suspend' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'cronjob-successfulhistory',
    input: { kind: 'retrieval_case', retrievalCaseId: 'cronjob-successfulhistory' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'svc-type',
    input: { kind: 'retrieval_case', retrievalCaseId: 'svc-type' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'svc-targetport',
    input: { kind: 'retrieval_case', retrievalCaseId: 'svc-targetport' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'svc-nodeport',
    input: { kind: 'retrieval_case', retrievalCaseId: 'svc-nodeport' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'svc-selector',
    input: { kind: 'retrieval_case', retrievalCaseId: 'svc-selector' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'svc-sessionaffinity',
    input: { kind: 'retrieval_case', retrievalCaseId: 'svc-sessionaffinity' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'ing-pathtype',
    input: { kind: 'retrieval_case', retrievalCaseId: 'ing-pathtype' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'ing-classname',
    input: { kind: 'retrieval_case', retrievalCaseId: 'ing-classname' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'ing-tls',
    input: { kind: 'retrieval_case', retrievalCaseId: 'ing-tls' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'netpol-policytypes',
    input: { kind: 'retrieval_case', retrievalCaseId: 'netpol-policytypes' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'netpol-podselector',
    input: { kind: 'retrieval_case', retrievalCaseId: 'netpol-podselector' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'cm-data',
    input: { kind: 'retrieval_case', retrievalCaseId: 'cm-data' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'cm-immutable',
    input: { kind: 'retrieval_case', retrievalCaseId: 'cm-immutable' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'secret-stringdata',
    input: { kind: 'retrieval_case', retrievalCaseId: 'secret-stringdata' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'secret-type',
    input: { kind: 'retrieval_case', retrievalCaseId: 'secret-type' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'sa-automount',
    input: { kind: 'retrieval_case', retrievalCaseId: 'sa-automount' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'sa-imagepullsecrets',
    input: { kind: 'retrieval_case', retrievalCaseId: 'sa-imagepullsecrets' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'quota-hard',
    input: { kind: 'retrieval_case', retrievalCaseId: 'quota-hard' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'limitrange-limits',
    input: { kind: 'retrieval_case', retrievalCaseId: 'limitrange-limits' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'hpa-maxreplicas',
    input: { kind: 'retrieval_case', retrievalCaseId: 'hpa-maxreplicas' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'hpa-scaletargetref',
    input: { kind: 'retrieval_case', retrievalCaseId: 'hpa-scaletargetref' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'hpa-metrics',
    input: { kind: 'retrieval_case', retrievalCaseId: 'hpa-metrics' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'pdb-minavailable',
    input: { kind: 'retrieval_case', retrievalCaseId: 'pdb-minavailable' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'pdb-selector',
    input: { kind: 'retrieval_case', retrievalCaseId: 'pdb-selector' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'role-rules',
    input: { kind: 'retrieval_case', retrievalCaseId: 'role-rules' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'rolebinding-roleref',
    input: { kind: 'retrieval_case', retrievalCaseId: 'rolebinding-roleref' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'rolebinding-subjects',
    input: { kind: 'retrieval_case', retrievalCaseId: 'rolebinding-subjects' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'clusterrole-rules',
    input: { kind: 'retrieval_case', retrievalCaseId: 'clusterrole-rules' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'crb-roleref',
    input: { kind: 'retrieval_case', retrievalCaseId: 'crb-roleref' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'endpoints-subsets',
    input: { kind: 'retrieval_case', retrievalCaseId: 'endpoints-subsets' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'sc-reclaimpolicy',
    input: { kind: 'retrieval_case', retrievalCaseId: 'sc-reclaimpolicy' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'pv-reclaimpolicy',
    input: { kind: 'retrieval_case', retrievalCaseId: 'pv-reclaimpolicy' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'pvc-accessmodes',
    input: { kind: 'retrieval_case', retrievalCaseId: 'pvc-accessmodes' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'pv-accessmodes',
    input: { kind: 'retrieval_case', retrievalCaseId: 'pv-accessmodes' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'vsc-driver',
    input: { kind: 'retrieval_case', retrievalCaseId: 'vsc-driver' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'vac-drivername',
    input: { kind: 'retrieval_case', retrievalCaseId: 'vac-drivername' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'pvc-volumemode',
    input: { kind: 'retrieval_case', retrievalCaseId: 'pvc-volumemode' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'sc-volumebindingmode',
    input: { kind: 'retrieval_case', retrievalCaseId: 'sc-volumebindingmode' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'vac-parameters',
    input: { kind: 'retrieval_case', retrievalCaseId: 'vac-parameters' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'sc-allowexpansion',
    input: { kind: 'retrieval_case', retrievalCaseId: 'sc-allowexpansion' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'pvc-resources',
    input: { kind: 'retrieval_case', retrievalCaseId: 'pvc-resources' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'sc-provisioner',
    input: { kind: 'retrieval_case', retrievalCaseId: 'sc-provisioner' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'policy-deploy-limits',
    input: { kind: 'retrieval_case', retrievalCaseId: 'policy-deploy-limits' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'policy-pod-privileged',
    input: { kind: 'retrieval_case', retrievalCaseId: 'policy-pod-privileged' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'policy-sc-reclaim',
    input: { kind: 'retrieval_case', retrievalCaseId: 'policy-sc-reclaim' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'policy-secret-plaintext',
    input: { kind: 'retrieval_case', retrievalCaseId: 'policy-secret-plaintext' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'policy-crb-admin',
    input: { kind: 'retrieval_case', retrievalCaseId: 'policy-crb-admin' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'policy-ingress-tls',
    input: { kind: 'retrieval_case', retrievalCaseId: 'policy-ingress-tls' },
    expectedBehavior: ANSWER_WITH_SOURCES,
  },
  {
    id: 'policy-conflict-latest',
    input: { kind: 'retrieval_case', retrievalCaseId: 'policy-conflict-latest' },
    expectedBehavior: EXPLAIN_SCHEMA_POLICY_CONFLICT,
    sourceExpectation: { mode: 'required', types: ['schema', 'policy'] },
  },
  {
    id: 'policy-conflict-nodeport',
    input: { kind: 'retrieval_case', retrievalCaseId: 'policy-conflict-nodeport' },
    expectedBehavior: EXPLAIN_SCHEMA_POLICY_CONFLICT,
    sourceExpectation: { mode: 'required', types: ['schema', 'policy'] },
  },
  {
    id: 'policy-conflict-privileged',
    input: { kind: 'retrieval_case', retrievalCaseId: 'policy-conflict-privileged' },
    expectedBehavior: EXPLAIN_SCHEMA_POLICY_CONFLICT,
    sourceExpectation: {
      mode: 'allow_missing_with_disclosure',
      types: ['schema', 'policy'],
    },
  },
  {
    id: 'refusal-prometheus-retention',
    input: { kind: 'standalone_question', question: 'Prometheus 怎么配置数据保留时间 retention?' },
    expectedBehavior: 'refuse_insufficient_context',
  },
  {
    id: 'refusal-gateway-httproute',
    input: { kind: 'standalone_question', question: 'Gateway API 的 HTTPRoute 怎么按权重分流?' },
    expectedBehavior: 'refuse_insufficient_context',
  },
  {
    id: 'refusal-cert-manager',
    input: { kind: 'standalone_question', question: 'cert-manager 的 Certificate 怎么指定签发者 issuer?' },
    expectedBehavior: 'refuse_insufficient_context',
  },
  {
    id: 'refusal-nonexistent-field',
    input: { kind: 'standalone_question', question: 'Pod 怎么开启 spec.autoHeal 自愈字段?' },
    expectedBehavior: 'refuse_insufficient_context',
  },
  {
    id: 'refusal-cluster-runtime',
    input: { kind: 'standalone_question', question: '我的集群现在有几个节点?' },
    expectedBehavior: 'refuse_insufficient_context',
  },
]);
