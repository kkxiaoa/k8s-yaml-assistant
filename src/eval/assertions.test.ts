import assert from 'node:assert/strict';
import {
  assertGenerationCaseContract,
  assertGenerationCasesContract,
  evaluateFixResourceSet,
  evaluateGenerationAssertions,
  preflightFixCases,
  type ExpectedResource,
  type FixCase,
  type GenerationAssertionContract,
  type KubernetesDocument,
  type ResourceRelation,
} from './assertions';
import { FIX_CASES } from './cases/fix-cases';
import { GENERATION_CASES } from './cases/generation-cases';

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

function resource(
  ref: string,
  kind: string,
  name: string | undefined,
  assertions: ExpectedResource['assertions'],
  apiVersion = kind === 'Deployment' || kind === 'StatefulSet'
    ? 'apps/v1'
    : 'v1',
): ExpectedResource {
  return {
    ref,
    identity: { apiVersion, kind, ...(name === undefined ? {} : { name }) },
    assertions,
  };
}

function contract(
  expectedResources: ExpectedResource[],
  relations: ResourceRelation[] = [],
): GenerationAssertionContract {
  return { expectedResources, relations };
}

const webDeployment: KubernetesDocument = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'web' },
  spec: {
    replicas: 3,
    selector: { matchLabels: { app: 'web' } },
    template: {
      metadata: { labels: { app: 'web' } },
      spec: {
        containers: [
          {
            name: 'web',
            image: 'nginx:1.27',
            ports: [{ name: 'http', containerPort: 80 }],
          },
        ],
      },
    },
  },
};

const typeErrorFixCase: FixCase = {
  id: 'fixture-type-error',
  brokenYaml: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: "3"
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: nginx
          image: nginx:1.27
`,
  defectType: 'type_error',
  target: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' },
  preserve: [
    {
      type: 'matches',
      path: 'spec.template.spec.containers',
      rule: {
        name: 'array_contains_object',
        value: { name: 'nginx', image: 'nginx:1.27' },
      },
    },
  ],
  expectedCorrections: [
    { type: 'equals', path: 'spec.replicas', value: 3 },
  ],
};

console.log('generation assertions:');

check('resource identity must match exactly once', () => {
  const expected = resource('deployment', 'Deployment', 'web', [
    { type: 'equals', path: 'spec.replicas', value: 3 },
  ]);

  const missing = evaluateGenerationAssertions(contract([expected]), [
    { ...webDeployment, apiVersion: 'extensions/v1beta1' },
  ]);
  assert.equal(missing.resources[0]?.match.status, 'missing');
  assert.equal(missing.resources[0]?.pass, false);

  const wrongName = evaluateGenerationAssertions(contract([expected]), [
    {
      ...webDeployment,
      metadata: { name: 'other' },
    },
  ]);
  assert.equal(wrongName.resources[0]?.match.status, 'missing');

  const ambiguous = evaluateGenerationAssertions(contract([expected]), [
    webDeployment,
    structuredClone(webDeployment),
  ]);
  assert.equal(ambiguous.resources[0]?.match.status, 'ambiguous');
  assert.equal(ambiguous.resources[0]?.match.documentIndexes.length, 2);
  assert.equal(ambiguous.pass, false);
});

check('an unrelated ConfigMap cannot satisfy Deployment and Service expectations', () => {
  const expected = [
    resource('deployment', 'Deployment', 'web', [
      { type: 'equals', path: 'spec.replicas', value: 3 },
    ]),
    resource('service', 'Service', 'web', [
      { type: 'equals', path: 'spec.ports', value: [{ port: 80 }] },
    ]),
  ];
  const result = evaluateGenerationAssertions(contract(expected), [
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'web' },
      spec: { replicas: 3, ports: [{ port: 80 }] },
    },
  ]);

  assert.deepEqual(
    result.resources.map((item) => item.match.status),
    ['missing', 'missing'],
  );
  assert.equal(result.pass, false);
});

check('assertions are evaluated only on the uniquely matched resource', () => {
  const expected = resource('deployment', 'Deployment', 'web', [
    { type: 'equals', path: 'spec.replicas', value: 3 },
  ]);
  const deploymentWithoutReplicas = structuredClone(webDeployment);
  delete (deploymentWithoutReplicas.spec as Record<string, unknown>).replicas;

  const result = evaluateGenerationAssertions(contract([expected]), [
    deploymentWithoutReplicas,
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'unrelated' },
      spec: { replicas: 3 },
    },
  ]);

  assert.equal(result.resources[0]?.assertions[0]?.pass, false);
  assert.match(result.resources[0]?.assertions[0]?.reason ?? '', /replicas/);
  assert.equal(result.pass, false);
});

check('specific replicas, image, and port values must all match', () => {
  const expected = resource('deployment', 'Deployment', 'web', [
    { type: 'equals', path: 'spec.replicas', value: 3 },
    {
      type: 'matches',
      path: 'spec.template.spec.containers',
      rule: {
        name: 'array_contains_object',
        value: {
          image: 'nginx:1.27',
          ports: [{ containerPort: 80 }],
        },
      },
    },
  ]);
  const wrong = structuredClone(webDeployment);
  const spec = wrong.spec as Record<string, unknown>;
  spec.replicas = 1;
  const containers = (
    ((spec.template as Record<string, unknown>).spec as Record<string, unknown>)
      .containers as Array<Record<string, unknown>>
  );
  containers[0]!.image = 'nginx:latest';
  containers[0]!.ports = [{ containerPort: 8080 }];

  const result = evaluateGenerationAssertions(contract([expected]), [wrong]);
  assert.deepEqual(
    result.resources[0]?.assertions.map((item) => item.pass),
    [false, false],
  );
  assert.equal(result.pass, false);
});

check('array correlation cannot be assembled from different elements', () => {
  const expected = resource('pod', 'Pod', 'sidecar-pod', [
    {
      type: 'matches',
      path: 'spec.containers',
      rule: {
        name: 'array_contains_object',
        value: {
          name: 'app',
          image: 'myapp:1.0',
          ports: [{ containerPort: 8080 }],
        },
      },
    },
  ]);
  const splitAcrossContainers: KubernetesDocument = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'sidecar-pod' },
    spec: {
      containers: [
        { name: 'app', image: 'wrong:1.0' },
        { name: 'other', image: 'myapp:1.0', ports: [{ containerPort: 8080 }] },
      ],
    },
  };

  const result = evaluateGenerationAssertions(contract([expected]), [
    splitAcrossContainers,
  ]);
  assert.equal(result.resources[0]?.assertions[0]?.pass, false);
});

check('named rules cover exact array cardinality and semantic empty fields', () => {
  const expected = resource('policy', 'NetworkPolicy', 'deny', [
    {
      type: 'matches',
      path: 'spec.policyTypes',
      rule: { name: 'array_length_equals', value: 1 },
    },
    {
      type: 'matches',
      path: 'spec.ingress',
      rule: { name: 'missing_or_empty' },
    },
  ], 'networking.k8s.io/v1');
  const result = evaluateGenerationAssertions(contract([expected]), [
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'deny' },
      spec: { policyTypes: ['Ingress'] },
    },
  ]);

  assert.deepEqual(
    result.resources[0]?.assertions.map((item) => item.pass),
    [true, true],
  );
});

check('missing relation endpoints never pass vacuously', () => {
  const deployment = resource('deployment', 'Deployment', 'web', [
    { type: 'exists', path: 'spec.template' },
  ]);
  const service = resource('service', 'Service', 'web', [
    { type: 'exists', path: 'spec.ports' },
  ]);
  const relations: ResourceRelation[] = [
    {
      type: 'service_selector_matches_workload_labels',
      serviceRef: 'service',
      workloadRef: 'deployment',
    },
    {
      type: 'service_target_port_matches_workload_container_port',
      serviceRef: 'service',
      workloadRef: 'deployment',
    },
  ];

  const result = evaluateGenerationAssertions(
    contract([deployment, service], relations),
    [webDeployment],
  );

  assert.equal(result.resources[1]?.match.status, 'missing');
  assert.deepEqual(
    result.relations.map((item) => item.pass),
    [false, false],
  );
  assert.match(result.relations[0]?.reason ?? '', /service/);
});

check('all supported relations are bound to their referenced resources', () => {
  const resources: ExpectedResource[] = [
    resource('deployment', 'Deployment', 'web', [
      { type: 'exists', path: 'spec.template' },
    ]),
    resource('service', 'Service', 'web', [
      { type: 'equals', path: 'spec.clusterIP', value: 'None' },
    ]),
    resource(
      'ingress',
      'Ingress',
      'web',
      [{ type: 'exists', path: 'spec.rules' }],
      'networking.k8s.io/v1',
    ),
    resource('statefulset', 'StatefulSet', 'web', [
      { type: 'equals', path: 'spec.serviceName', value: 'web' },
    ]),
    resource(
      'hpa',
      'HorizontalPodAutoscaler',
      'web',
      [{ type: 'exists', path: 'spec.scaleTargetRef' }],
      'autoscaling/v2',
    ),
    resource('config', 'ConfigMap', 'web-config', [
      { type: 'exists', path: 'data' },
    ]),
  ];
  const relations: ResourceRelation[] = [
    {
      type: 'workload_selector_matches_template_labels',
      workloadRef: 'deployment',
    },
    {
      type: 'service_selector_matches_workload_labels',
      serviceRef: 'service',
      workloadRef: 'deployment',
    },
    {
      type: 'service_target_port_matches_workload_container_port',
      serviceRef: 'service',
      workloadRef: 'deployment',
    },
    {
      type: 'ingress_backend_matches_service',
      ingressRef: 'ingress',
      serviceRef: 'service',
    },
    {
      type: 'statefulset_service_name_matches_headless_service',
      statefulSetRef: 'statefulset',
      serviceRef: 'service',
    },
    {
      type: 'hpa_target_matches_workload',
      hpaRef: 'hpa',
      workloadRef: 'deployment',
    },
    {
      type: 'deployment_config_map_ref_matches',
      deploymentRef: 'deployment',
      configMapRef: 'config',
    },
  ];
  const docs: KubernetesDocument[] = [
    {
      ...webDeployment,
      spec: {
        ...(webDeployment.spec as Record<string, unknown>),
        template: {
          ...((webDeployment.spec as Record<string, unknown>)
            .template as Record<string, unknown>),
          spec: {
            containers: [
              {
                name: 'web',
                image: 'nginx:1.27',
                ports: [{ name: 'http', containerPort: 80 }],
                envFrom: [{ configMapRef: { name: 'web-config' } }],
              },
            ],
          },
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'web' },
      spec: {
        clusterIP: 'None',
        selector: { app: 'web' },
        ports: [{ name: 'http', port: 80, targetPort: 'http' }],
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: { name: 'web' },
      spec: {
        rules: [
          {
            http: {
              paths: [
                {
                  path: '/',
                  pathType: 'Prefix',
                  backend: {
                    service: { name: 'web', port: { name: 'http' } },
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: { name: 'web' },
      spec: { serviceName: 'web', template: { spec: { containers: [] } } },
    },
    {
      apiVersion: 'autoscaling/v2',
      kind: 'HorizontalPodAutoscaler',
      metadata: { name: 'web' },
      spec: {
        scaleTargetRef: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          name: 'web',
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'web-config' },
      data: { LOG_LEVEL: 'info' },
    },
  ];

  const result = evaluateGenerationAssertions(
    contract(resources, relations),
    docs,
  );
  assert.equal(result.pass, true);
  assert.equal(result.relations.length, 7);
  assert.ok(result.relations.every((item) => item.pass));
});

check('invalid case references fail preflight instead of becoming model failures', () => {
  assert.throws(
    () =>
      assertGenerationCaseContract({
        id: 'invalid',
        requirement: 'invalid relation',
        expectedResources: [
          resource('deployment', 'Deployment', 'web', [
            { type: 'exists', path: 'spec.template' },
          ]),
        ],
        relations: [
          {
            type: 'service_selector_matches_workload_labels',
            serviceRef: 'missing',
            workloadRef: 'deployment',
          },
        ],
      }),
    /missing/,
  );
  assert.throws(
    () =>
      assertGenerationCaseContract({
        id: 'wrong-types',
        requirement: 'invalid relation endpoint types',
        expectedResources: [
          resource('deployment', 'Deployment', 'web', [
            { type: 'exists', path: 'spec.template' },
          ]),
          resource('not-service', 'ConfigMap', 'web', [
            { type: 'exists', path: 'data' },
          ]),
        ],
        relations: [
          {
            type: 'service_selector_matches_workload_labels',
            serviceRef: 'not-service',
            workloadRef: 'deployment',
          },
        ],
      }),
    /must identify Service/,
  );
});

check('fix preflight rejects a mismatched defect type and an already-correct task', () => {
  const alreadyCorrect: FixCase = {
    ...typeErrorFixCase,
    id: 'fixture-already-correct',
    defectType: 'unknown_field',
    brokenYaml: typeErrorFixCase.brokenYaml
      .replace('replicas: "3"', 'replicas: 3')
      .replace('  selector:', '  unexpected: true\n  selector:'),
  };

  assert.throws(
    () =>
      preflightFixCases([
        { ...typeErrorFixCase, id: 'fixture-wrong-defect', defectType: 'enum_error' },
        alreadyCorrect,
      ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /fixture-wrong-defect/);
      assert.match(error.message, /does not contain declared defect enum_error/);
      assert.match(error.message, /fixture-already-correct/);
      assert.match(error.message, /already satisfies every expected correction/);
      return true;
    },
  );
});

check('fix preflight distinguishes true parse errors and requires a unique target', () => {
  const duplicateTarget = `${typeErrorFixCase.brokenYaml}\n---\n${typeErrorFixCase.brokenYaml}`;

  assert.throws(
    () =>
      preflightFixCases([
        {
          ...typeErrorFixCase,
          id: 'fixture-not-a-parse-error',
          defectType: 'parse_error',
        },
        {
          ...typeErrorFixCase,
          id: 'fixture-ambiguous-target',
          brokenYaml: duplicateTarget,
        },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /fixture-not-a-parse-error/);
      assert.match(error.message, /must fail YAML parsing/);
      assert.match(error.message, /fixture-ambiguous-target/);
      assert.match(error.message, /matched 2 documents/);
      return true;
    },
  );
});

check('parse-error preflight does not claim structural checks on broken YAML', () => {
  const parseOnlyCase: FixCase = {
    id: 'fixture-parse-only',
    brokenYaml: 'data: [',
    defectType: 'parse_error',
    target: { apiVersion: 'v1', kind: 'ConfigMap', name: 'declared-target' },
    preserve: [{ type: 'equals', path: 'data.MODE', value: 'stable' }],
    expectedCorrections: [{ type: 'exists', path: 'data' }],
  };

  const [fixture] = preflightFixCases([parseOnlyCase]);
  assert.ok(fixture);
  assert.deepEqual(fixture.expectedResourceIdentities, [parseOnlyCase.target]);
  assert.match(fixture.validationErrors[0]?.message ?? '', /YAML 解析失败/);
});

check('fix resource-set comparison detects added and removed resources', () => {
  const multiDocumentCase: FixCase = {
    ...typeErrorFixCase,
    id: 'fixture-resource-set',
    brokenYaml: `${typeErrorFixCase.brokenYaml}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings\ndata:\n  MODE: stable\n`,
  };
  const [fixture] = preflightFixCases([multiDocumentCase]);
  assert.ok(fixture);

  const repaired = [
    webDeployment,
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'settings' },
      data: { MODE: 'stable' },
    },
  ];
  assert.equal(evaluateFixResourceSet(fixture, repaired).pass, true);

  const added = evaluateFixResourceSet(fixture, [
    ...repaired,
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'unrequested' },
    },
  ]);
  assert.equal(added.pass, false);
  assert.deepEqual(added.added, [
    { apiVersion: 'v1', kind: 'Secret', name: 'unrequested' },
  ]);

  const removed = evaluateFixResourceSet(fixture, [webDeployment]);
  assert.equal(removed.pass, false);
  assert.deepEqual(removed.removed, [
    { apiVersion: 'v1', kind: 'ConfigMap', name: 'settings' },
  ]);
});

check('parse-error repair accepts only the declared target resource set', () => {
  const parseErrorCase = FIX_CASES.find(
    (evalCase) => evalCase.id === 'fix-parse-error',
  );
  assert.ok(parseErrorCase);
  const [fixture] = preflightFixCases([parseErrorCase]);
  assert.ok(fixture);
  const repaired: KubernetesDocument = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'app-config' },
    data: { LOG_LEVEL: 'info', TIMEOUT: '30' },
  };

  assert.equal(evaluateFixResourceSet(fixture, [repaired]).pass, true);
  const extra = evaluateFixResourceSet(fixture, [
    repaired,
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'unrequested' },
    },
  ]);
  assert.equal(extra.pass, false);
  assert.deepEqual(extra.added, [
    { apiVersion: 'v1', kind: 'Secret', name: 'unrequested' },
  ]);
});

check('all 8 fix fixtures pass full-dataset preflight', () => {
  const fixtures = preflightFixCases(FIX_CASES);
  assert.equal(FIX_CASES.length, 8);
  assert.equal(fixtures.length, FIX_CASES.length);
  assert.ok(fixtures.every((fixture) => fixture.validationErrors.length > 0));
  assert.ok(
    FIX_CASES.every(
      (evalCase) =>
        evalCase.preserve.length > 0 && evalCase.expectedCorrections.length > 0,
    ),
  );
});

check('all 26 generation cases use the resource-bound contract', () => {
  assert.equal(GENERATION_CASES.length, 26);
  assert.doesNotThrow(() => assertGenerationCasesContract(GENERATION_CASES));
  assert.ok(
    GENERATION_CASES.every(
      (evalCase) =>
        evalCase.expectedResources.length > 0 &&
        evalCase.expectedResources.every(
          (resource) => resource.assertions.length > 0,
        ),
    ),
  );
});

console.log(`\n通过 ${passed} 项`);
