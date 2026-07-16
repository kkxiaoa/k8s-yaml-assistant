import { loadAll } from 'js-yaml';
import { canonicalJson, type JsonValue } from '../shared/json';
import {
  validateYamlDocuments,
  type ValidationError,
} from '../validation/validate';

export type { JsonValue } from '../shared/json';

export type JsonObject = { [key: string]: JsonValue };
export type KubernetesDocument = Record<string, unknown>;

export interface ResourceIdentity {
  apiVersion: string;
  kind: string;
  name?: string;
}

export type NamedAssertionRule =
  | { name: 'missing_or_empty' }
  | { name: 'array_length_equals'; value: number }
  | { name: 'array_contains_object'; value: JsonObject };

export type FieldAssertion =
  | { type: 'exists'; path: string }
  | { type: 'equals'; path: string; value: JsonValue }
  | { type: 'contains'; path: string; value: JsonValue }
  | { type: 'matches'; path: string; rule: NamedAssertionRule };

export interface ExpectedResource {
  ref: string;
  identity: ResourceIdentity;
  assertions: FieldAssertion[];
}

export type ResourceRelation =
  | {
      type: 'workload_selector_matches_template_labels';
      workloadRef: string;
    }
  | {
      type: 'service_selector_matches_workload_labels';
      serviceRef: string;
      workloadRef: string;
    }
  | {
      type: 'service_target_port_matches_workload_container_port';
      serviceRef: string;
      workloadRef: string;
    }
  | {
      type: 'ingress_backend_matches_service';
      ingressRef: string;
      serviceRef: string;
    }
  | {
      type: 'statefulset_service_name_matches_headless_service';
      statefulSetRef: string;
      serviceRef: string;
    }
  | {
      type: 'hpa_target_matches_workload';
      hpaRef: string;
      workloadRef: string;
    }
  | {
      type: 'deployment_config_map_ref_matches';
      deploymentRef: string;
      configMapRef: string;
    };

export interface GenerationAssertionContract {
  expectedResources: ExpectedResource[];
  relations?: ResourceRelation[];
}

export interface GenerationCaseContract extends GenerationAssertionContract {
  id: string;
  requirement: string;
  rationale?: string[];
}

export const DEFECT_TYPES = [
  'type_error',
  'missing_required',
  'unknown_field',
  'enum_error',
  'parse_error',
] as const;

export type DefectType = (typeof DEFECT_TYPES)[number];

export interface FixCase {
  id: string;
  brokenYaml: string;
  defectType: DefectType;
  target: ResourceIdentity;
  preserve: FieldAssertion[];
  expectedCorrections: FieldAssertion[];
}

export interface FixFixturePreflight {
  caseId: string;
  validationErrors: ValidationError[];
  expectedResourceIdentities: ResourceIdentity[];
}

export interface FixResourceSetResult {
  expected: ResourceIdentity[];
  actual: ResourceIdentity[];
  added: ResourceIdentity[];
  removed: ResourceIdentity[];
  unidentifiedDocumentIndexes: number[];
  pass: boolean;
  reason: string;
}

export interface ResourceMatchResult {
  status: 'matched' | 'missing' | 'ambiguous';
  documentIndexes: number[];
  reason: string;
}

export interface FieldAssertionResult {
  assertion: FieldAssertion;
  pass: boolean;
  reason: string;
}

export interface ExpectedResourceResult {
  ref: string;
  identity: ResourceIdentity;
  match: ResourceMatchResult;
  assertions: FieldAssertionResult[];
  pass: boolean;
}

export interface ResourceRelationResult {
  relation: ResourceRelation;
  pass: boolean;
  reason: string;
}

export interface GenerationAssertionResult {
  resources: ExpectedResourceResult[];
  relations: ResourceRelationResult[];
  resourceMatchPass: boolean;
  resourceAssertionPass: boolean;
  relationPass: boolean | null;
  pass: boolean;
}

type NamedRuleEvaluator = (
  value: unknown,
  rule: NamedAssertionRule,
) => boolean;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: JsonValue): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function arrayContainsSubset(
  actual: unknown[],
  expected: JsonValue[],
  expectedIndex = 0,
  used = new Set<number>(),
): boolean {
  if (expectedIndex === expected.length) return true;
  const expectedValue = expected[expectedIndex]!;
  for (let actualIndex = 0; actualIndex < actual.length; actualIndex++) {
    if (used.has(actualIndex)) continue;
    if (!jsonSubset(actual[actualIndex], expectedValue)) continue;
    used.add(actualIndex);
    if (arrayContainsSubset(actual, expected, expectedIndex + 1, used)) {
      return true;
    }
    used.delete(actualIndex);
  }
  return false;
}

function jsonSubset(actual: unknown, expected: JsonValue): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && arrayContainsSubset(actual, expected);
  }
  if (expected !== null && typeof expected === 'object') {
    if (!isObject(actual)) return false;
    return Object.entries(expected).every(([key, value]) =>
      jsonSubset(actual[key], value),
    );
  }
  return jsonEqual(actual, expected);
}

export const NAMED_ASSERTION_RULE_REGISTRY: Readonly<
  Record<NamedAssertionRule['name'], NamedRuleEvaluator>
> = Object.freeze({
  missing_or_empty: (value) =>
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.length === 0) ||
    (Array.isArray(value) && value.length === 0) ||
    (isObject(value) && Object.keys(value).length === 0),
  array_length_equals: (value, rule) =>
    rule.name === 'array_length_equals' &&
    Array.isArray(value) &&
    value.length === rule.value,
  array_contains_object: (value, rule) =>
    rule.name === 'array_contains_object' &&
    Array.isArray(value) &&
    value.some((item) => jsonSubset(item, rule.value)),
});

function nonEmptyString(value: string, path: string): void {
  if (value.trim().length === 0) throw new Error(`${path} must be non-empty`);
}

function relationReferences(relation: ResourceRelation): string[] {
  switch (relation.type) {
    case 'workload_selector_matches_template_labels':
      return [relation.workloadRef];
    case 'service_selector_matches_workload_labels':
    case 'service_target_port_matches_workload_container_port':
      return [relation.serviceRef, relation.workloadRef];
    case 'ingress_backend_matches_service':
      return [relation.ingressRef, relation.serviceRef];
    case 'statefulset_service_name_matches_headless_service':
      return [relation.statefulSetRef, relation.serviceRef];
    case 'hpa_target_matches_workload':
      return [relation.hpaRef, relation.workloadRef];
    case 'deployment_config_map_ref_matches':
      return [relation.deploymentRef, relation.configMapRef];
  }
}

const POD_TEMPLATE_WORKLOAD_KINDS = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
]);

function requireResourceKind(
  resources: Map<string, ExpectedResource>,
  ref: string,
  expected: string | Set<string>,
  relationPath: string,
): void {
  const resource = resources.get(ref);
  if (!resource) throw new Error(`${relationPath} references missing ref ${ref}`);
  const accepted = typeof expected === 'string' ? new Set([expected]) : expected;
  if (!accepted.has(resource.identity.kind)) {
    throw new Error(
      `${relationPath} ref ${ref} must identify ${[...accepted].join('/')}, got ${resource.identity.kind}`,
    );
  }
}

function assertRelationContract(
  relation: ResourceRelation,
  resources: Map<string, ExpectedResource>,
  path: string,
): void {
  for (const ref of relationReferences(relation)) {
    nonEmptyString(ref, `${path}.ref`);
    if (!resources.has(ref)) throw new Error(`${path} references missing ref ${ref}`);
  }

  switch (relation.type) {
    case 'workload_selector_matches_template_labels':
      requireResourceKind(
        resources,
        relation.workloadRef,
        POD_TEMPLATE_WORKLOAD_KINDS,
        path,
      );
      return;
    case 'service_selector_matches_workload_labels':
    case 'service_target_port_matches_workload_container_port':
      requireResourceKind(resources, relation.serviceRef, 'Service', path);
      requireResourceKind(
        resources,
        relation.workloadRef,
        POD_TEMPLATE_WORKLOAD_KINDS,
        path,
      );
      return;
    case 'ingress_backend_matches_service':
      requireResourceKind(resources, relation.ingressRef, 'Ingress', path);
      requireResourceKind(resources, relation.serviceRef, 'Service', path);
      return;
    case 'statefulset_service_name_matches_headless_service':
      requireResourceKind(
        resources,
        relation.statefulSetRef,
        'StatefulSet',
        path,
      );
      requireResourceKind(resources, relation.serviceRef, 'Service', path);
      return;
    case 'hpa_target_matches_workload':
      requireResourceKind(
        resources,
        relation.hpaRef,
        'HorizontalPodAutoscaler',
        path,
      );
      requireResourceKind(
        resources,
        relation.workloadRef,
        POD_TEMPLATE_WORKLOAD_KINDS,
        path,
      );
      return;
    case 'deployment_config_map_ref_matches':
      requireResourceKind(
        resources,
        relation.deploymentRef,
        'Deployment',
        path,
      );
      requireResourceKind(resources, relation.configMapRef, 'ConfigMap', path);
      return;
  }
}

function assertAssertionContract(assertion: FieldAssertion, path: string): void {
  nonEmptyString(assertion.path, `${path}.path`);
  if (assertion.type === 'equals' || assertion.type === 'contains') {
    canonicalJson(assertion.value, `${path}.value`);
  }
  if (assertion.type === 'matches') {
    if (!(assertion.rule.name in NAMED_ASSERTION_RULE_REGISTRY)) {
      throw new Error(`${path}.rule is not registered`);
    }
    if (assertion.rule.name === 'array_contains_object') {
      canonicalJson(assertion.rule.value, `${path}.rule.value`);
      if (Object.keys(assertion.rule.value).length === 0) {
        throw new Error(`${path}.rule.value must be non-empty`);
      }
    }
    if (
      assertion.rule.name === 'array_length_equals' &&
      (!Number.isInteger(assertion.rule.value) || assertion.rule.value < 0)
    ) {
      throw new Error(`${path}.rule.value must be a non-negative integer`);
    }
  }
}

function assertResourceIdentity(identity: ResourceIdentity, path: string): void {
  nonEmptyString(identity.apiVersion, `${path}.apiVersion`);
  nonEmptyString(identity.kind, `${path}.kind`);
  if (identity.name !== undefined) {
    nonEmptyString(identity.name, `${path}.name`);
  }
}

function assertAssertionList(
  assertions: readonly FieldAssertion[],
  path: string,
): void {
  if (assertions.length === 0) throw new Error(`${path} must be non-empty`);
  assertions.forEach((assertion, index) =>
    assertAssertionContract(assertion, `${path}[${index}]`),
  );
}

function assertContract(
  contract: GenerationAssertionContract,
  path: string,
): void {
  if (contract.expectedResources.length === 0) {
    throw new Error(`${path}.expectedResources must be non-empty`);
  }
  const resources = new Map<string, ExpectedResource>();
  contract.expectedResources.forEach((resource, resourceIndex) => {
    const resourcePath = `${path}.expectedResources[${resourceIndex}]`;
    nonEmptyString(resource.ref, `${resourcePath}.ref`);
    if (resources.has(resource.ref)) {
      throw new Error(`${resourcePath}.ref duplicates ${resource.ref}`);
    }
    assertResourceIdentity(resource.identity, `${resourcePath}.identity`);
    assertAssertionList(resource.assertions, `${resourcePath}.assertions`);
    resources.set(resource.ref, resource);
  });

  const seenRelations = new Set<string>();
  (contract.relations ?? []).forEach((relation, relationIndex) => {
    const relationPath = `${path}.relations[${relationIndex}]`;
    assertRelationContract(relation, resources, relationPath);
    const identity = canonicalJson(relation);
    if (seenRelations.has(identity)) {
      throw new Error(`${relationPath} duplicates a relation`);
    }
    seenRelations.add(identity);
  });
}

export function assertGenerationCaseContract(
  evalCase: GenerationCaseContract,
): void {
  nonEmptyString(evalCase.id, 'generationCase.id');
  nonEmptyString(evalCase.requirement, `generationCase(${evalCase.id}).requirement`);
  evalCase.rationale?.forEach((reason, index) =>
    nonEmptyString(reason, `generationCase(${evalCase.id}).rationale[${index}]`),
  );
  assertContract(evalCase, `generationCase(${evalCase.id})`);
}

export function assertGenerationCasesContract(
  cases: readonly GenerationCaseContract[],
): void {
  if (cases.length === 0) throw new Error('generation cases must be non-empty');
  const ids = new Set<string>();
  for (const evalCase of cases) {
    assertGenerationCaseContract(evalCase);
    if (ids.has(evalCase.id)) throw new Error(`duplicate generation case id ${evalCase.id}`);
    ids.add(evalCase.id);
  }
}

export function assertFixCaseContract(evalCase: FixCase): void {
  nonEmptyString(evalCase.id, 'fixCase.id');
  nonEmptyString(evalCase.brokenYaml, `fixCase(${evalCase.id}).brokenYaml`);
  assertResourceIdentity(evalCase.target, `fixCase(${evalCase.id}).target`);
  assertAssertionList(evalCase.preserve, `fixCase(${evalCase.id}).preserve`);
  assertAssertionList(
    evalCase.expectedCorrections,
    `fixCase(${evalCase.id}).expectedCorrections`,
  );
}

function pathValues(node: unknown, segments: readonly string[]): unknown[] {
  if (segments.length === 0) return node === undefined ? [] : [node];
  if (node === null || node === undefined) return [];
  if (Array.isArray(node)) {
    return node.flatMap((value) => pathValues(value, segments));
  }
  if (!isObject(node)) return [];
  const [head, ...tail] = segments;
  if (head === undefined || !Object.hasOwn(node, head)) return [];
  return pathValues(node[head], tail);
}

function displayJson(value: JsonValue): string {
  return canonicalJson(value);
}

function containsValue(actual: unknown, expected: JsonValue): boolean {
  if (Array.isArray(actual)) {
    return actual.some((item) => jsonEqual(item, expected));
  }
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.includes(expected);
  }
  if (isObject(actual) && expected !== null && typeof expected === 'object') {
    return jsonSubset(actual, expected);
  }
  return false;
}

function evaluateFieldAssertion(
  document: KubernetesDocument,
  assertion: FieldAssertion,
): FieldAssertionResult {
  const values = pathValues(document, assertion.path.split('.'));
  if (values.length === 0) {
    if (
      assertion.type === 'matches' &&
      assertion.rule.name === 'missing_or_empty'
    ) {
      return {
        assertion,
        pass: true,
        reason: `path ${assertion.path} is missing, satisfying named rule missing_or_empty`,
      };
    }
    return {
      assertion,
      pass: false,
      reason: `path ${assertion.path} is missing from the matched resource`,
    };
  }

  let pass = false;
  let expectation = '';
  switch (assertion.type) {
    case 'exists':
      pass = values.some((value) => value !== null && value !== undefined);
      expectation = 'to exist';
      break;
    case 'equals':
      pass = values.some((value) => jsonEqual(value, assertion.value));
      expectation = `to equal ${displayJson(assertion.value)}`;
      break;
    case 'contains':
      pass = values.some((value) => containsValue(value, assertion.value));
      expectation = `to contain ${displayJson(assertion.value)}`;
      break;
    case 'matches': {
      const evaluator = NAMED_ASSERTION_RULE_REGISTRY[assertion.rule.name];
      pass = values.some((value) => evaluator(value, assertion.rule));
      expectation = `to match named rule ${assertion.rule.name}`;
      break;
    }
  }

  return {
    assertion,
    pass,
    reason: pass
      ? `path ${assertion.path} satisfies the assertion`
      : `expected path ${assertion.path} ${expectation}`,
  };
}

function metadataName(document: KubernetesDocument): string | undefined {
  const metadata = isObject(document.metadata) ? document.metadata : undefined;
  return typeof metadata?.name === 'string' ? metadata.name : undefined;
}

function matchesIdentity(
  document: KubernetesDocument,
  identity: ResourceIdentity,
): boolean {
  return (
    document.apiVersion === identity.apiVersion &&
    document.kind === identity.kind &&
    (identity.name === undefined || metadataName(document) === identity.name)
  );
}

export function evaluateExpectedResource(
  expected: ExpectedResource,
  documents: readonly KubernetesDocument[],
): ExpectedResourceResult {
  const documentIndexes: number[] = [];
  documents.forEach((document, index) => {
    if (matchesIdentity(document, expected.identity)) documentIndexes.push(index);
  });
  const status: ResourceMatchResult['status'] =
    documentIndexes.length === 0
      ? 'missing'
      : documentIndexes.length === 1
        ? 'matched'
        : 'ambiguous';
  const identityText = `${expected.identity.apiVersion} ${expected.identity.kind}${
    expected.identity.name === undefined ? '' : `/${expected.identity.name}`
  }`;
  const match: ResourceMatchResult = {
    status,
    documentIndexes,
    reason:
      status === 'matched'
        ? `matched ${identityText} at document ${documentIndexes[0]}`
        : status === 'missing'
          ? `missing expected resource ${identityText}`
          : `expected one ${identityText}, matched documents ${documentIndexes.join(', ')}`,
  };

  if (status !== 'matched') {
    const assertions = expected.assertions.map<FieldAssertionResult>(
      (assertion) => ({
        assertion,
        pass: false,
        reason: `cannot evaluate assertion because resource ${expected.ref} is ${status}`,
      }),
    );
    return { ref: expected.ref, identity: expected.identity, match, assertions, pass: false };
  }

  const document = documents[documentIndexes[0]!]!;
  const assertions = expected.assertions.map((assertion) =>
    evaluateFieldAssertion(document, assertion),
  );
  return {
    ref: expected.ref,
    identity: expected.identity,
    match,
    assertions,
    pass: assertions.every((assertion) => assertion.pass),
  };
}

const DEFECT_ERROR_PATTERNS: Readonly<
  Record<Exclude<DefectType, 'parse_error'>, RegExp>
> = Object.freeze({
  type_error: /类型应为/,
  missing_required: /必填/,
  unknown_field: /未知字段/,
  enum_error: /只能是/,
});

export function parseKubernetesDocuments(yaml: string): KubernetesDocument[] {
  try {
    return (loadAll(yaml) as unknown[]).filter(isObject);
  } catch {
    return [];
  }
}

function resourceIdentity(
  document: KubernetesDocument,
): ResourceIdentity | undefined {
  if (
    typeof document.apiVersion !== 'string' ||
    typeof document.kind !== 'string'
  ) {
    return undefined;
  }
  const name = metadataName(document);
  return {
    apiVersion: document.apiVersion,
    kind: document.kind,
    ...(name === undefined ? {} : { name }),
  };
}

function preflightFixCase(evalCase: FixCase): {
  fixture?: FixFixturePreflight;
  issues: string[];
} {
  const issues: string[] = [];
  try {
    assertFixCaseContract(evalCase);
  } catch (error) {
    return {
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }

  const validation = validateYamlDocuments(evalCase.brokenYaml);
  if (evalCase.defectType === 'parse_error') {
    if (!validation.parseFailed) {
      issues.push('declared parse_error fixture must fail YAML parsing');
    }
    return {
      ...(issues.length === 0
        ? {
            fixture: {
              caseId: evalCase.id,
              validationErrors: validation.errors,
              expectedResourceIdentities: [evalCase.target],
            },
          }
        : {}),
      issues,
    };
  }

  if (validation.parseFailed) {
    issues.push(
      `declared ${evalCase.defectType} fixture must parse as YAML`,
    );
    return { issues };
  }

  const defectPattern = DEFECT_ERROR_PATTERNS[evalCase.defectType];
  if (!validation.errors.some((error) => defectPattern.test(error.message))) {
    issues.push(
      `fixture does not contain declared defect ${evalCase.defectType}`,
    );
  }

  const documents = parseKubernetesDocuments(evalCase.brokenYaml);
  const expectedResourceIdentities: ResourceIdentity[] = [];
  documents.forEach((document, index) => {
    const identity = resourceIdentity(document);
    if (identity) expectedResourceIdentities.push(identity);
    else issues.push(`document ${index} has no apiVersion/kind identity`);
  });

  const targetResult = evaluateExpectedResource(
    {
      ref: 'fix-target',
      identity: evalCase.target,
      assertions: evalCase.expectedCorrections,
    },
    documents,
  );
  if (targetResult.match.status !== 'matched') {
    issues.push(
      targetResult.match.status === 'ambiguous'
        ? `target matched ${targetResult.match.documentIndexes.length} documents`
        : targetResult.match.reason,
    );
  } else if (targetResult.assertions.every((assertion) => assertion.pass)) {
    issues.push('broken fixture already satisfies every expected correction');
  }

  return {
    ...(issues.length === 0
      ? {
          fixture: {
            caseId: evalCase.id,
            validationErrors: validation.errors,
            expectedResourceIdentities,
          },
        }
      : {}),
    issues,
  };
}

export function preflightFixCases(
  cases: readonly FixCase[],
): FixFixturePreflight[] {
  if (cases.length === 0) throw new Error('fix cases must be non-empty');

  const ids = new Set<string>();
  const failures: Array<{ caseId: string; issues: string[] }> = [];
  const fixtures: FixFixturePreflight[] = [];
  for (const evalCase of cases) {
    const duplicate = ids.has(evalCase.id);
    ids.add(evalCase.id);
    const result = preflightFixCase(evalCase);
    const issues = [
      ...(duplicate ? [`duplicate fix case id ${evalCase.id}`] : []),
      ...result.issues,
    ];
    if (issues.length > 0 || !result.fixture) {
      failures.push({ caseId: evalCase.id || '(empty id)', issues });
    } else {
      fixtures.push(result.fixture);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `fix fixture preflight failed:\n${failures
        .map(
          ({ caseId, issues }) =>
            `- ${caseId}: ${issues.join('; ') || 'invalid fixture'}`,
        )
        .join('\n')}`,
    );
  }
  return fixtures;
}

function identityKey(identity: ResourceIdentity): string {
  return canonicalJson({
    apiVersion: identity.apiVersion,
    kind: identity.kind,
    name: identity.name ?? null,
  });
}

function multisetDifference(
  left: readonly ResourceIdentity[],
  right: readonly ResourceIdentity[],
): ResourceIdentity[] {
  const available = new Map<string, number>();
  for (const identity of right) {
    const key = identityKey(identity);
    available.set(key, (available.get(key) ?? 0) + 1);
  }
  const difference: ResourceIdentity[] = [];
  for (const identity of left) {
    const key = identityKey(identity);
    const remaining = available.get(key) ?? 0;
    if (remaining === 0) difference.push(identity);
    else available.set(key, remaining - 1);
  }
  return difference;
}

function identityLabel(identity: ResourceIdentity): string {
  return `${identity.apiVersion} ${identity.kind}${
    identity.name === undefined ? '' : `/${identity.name}`
  }`;
}

export function evaluateFixResourceSet(
  fixture: FixFixturePreflight,
  documents: readonly KubernetesDocument[],
): FixResourceSetResult {
  const actual: ResourceIdentity[] = [];
  const unidentifiedDocumentIndexes: number[] = [];
  documents.forEach((document, index) => {
    const identity = resourceIdentity(document);
    if (identity) actual.push(identity);
    else unidentifiedDocumentIndexes.push(index);
  });

  const expected = fixture.expectedResourceIdentities;
  const added = multisetDifference(actual, expected);
  const removed = multisetDifference(expected, actual);
  const pass =
    unidentifiedDocumentIndexes.length === 0 &&
    added.length === 0 &&
    removed.length === 0;
  const details = [
    ...(unidentifiedDocumentIndexes.length > 0
      ? [`documents without identity: ${unidentifiedDocumentIndexes.join(', ')}`]
      : []),
    ...(added.length > 0
      ? [`added: ${added.map(identityLabel).join(', ')}`]
      : []),
    ...(removed.length > 0
      ? [`removed: ${removed.map(identityLabel).join(', ')}`]
      : []),
  ];
  return {
    expected: [...expected],
    actual,
    added,
    removed,
    unidentifiedDocumentIndexes,
    pass,
    reason: pass
      ? 'resource identities are unchanged'
      : details.join('; '),
  };
}

interface RelationEvaluation {
  pass: boolean;
  reason: string;
}

function relationDocument(
  ref: string,
  resources: Map<string, ExpectedResourceResult>,
  documents: readonly KubernetesDocument[],
): { document?: KubernetesDocument; error?: string } {
  const resource = resources.get(ref);
  if (!resource) return { error: `relation references unknown resource ${ref}` };
  if (resource.match.status !== 'matched') {
    return { error: `resource ${ref} is ${resource.match.status}` };
  }
  return { document: documents[resource.match.documentIndexes[0]!] };
}

function objectAt(root: unknown, ...keys: string[]): Record<string, unknown> | undefined {
  let current = root;
  for (const key of keys) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return isObject(current) ? current : undefined;
}

function podTemplateLabels(
  workload: KubernetesDocument,
): Record<string, unknown> | undefined {
  return objectAt(workload, 'spec', 'template', 'metadata', 'labels');
}

function workloadSelector(
  workload: KubernetesDocument,
): Record<string, unknown> | undefined {
  return objectAt(workload, 'spec', 'selector', 'matchLabels');
}

function nonEmptyObject(value: unknown): value is Record<string, unknown> {
  return isObject(value) && Object.keys(value).length > 0;
}

function subsetObject(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): boolean {
  return Object.entries(expected).every(([key, value]) =>
    jsonEqual(actual[key], value as JsonValue),
  );
}

function workloadSelectorRelation(
  workload: KubernetesDocument,
): RelationEvaluation {
  const selector = workloadSelector(workload);
  const labels = podTemplateLabels(workload);
  if (!nonEmptyObject(selector)) {
    return { pass: false, reason: 'workload selector.matchLabels is missing or empty' };
  }
  if (!nonEmptyObject(labels)) {
    return { pass: false, reason: 'workload pod template labels are missing or empty' };
  }
  const pass = subsetObject(selector, labels);
  return {
    pass,
    reason: pass
      ? 'workload selector matches pod template labels'
      : 'workload selector does not match pod template labels',
  };
}

function serviceSelectorRelation(
  service: KubernetesDocument,
  workload: KubernetesDocument,
): RelationEvaluation {
  const selector = objectAt(service, 'spec', 'selector');
  const labels = podTemplateLabels(workload);
  if (!nonEmptyObject(selector)) {
    return { pass: false, reason: 'Service selector is missing or empty' };
  }
  if (!nonEmptyObject(labels)) {
    return { pass: false, reason: 'workload pod template labels are missing or empty' };
  }
  const pass = subsetObject(selector, labels);
  return {
    pass,
    reason: pass
      ? 'Service selector matches workload pod labels'
      : 'Service selector does not match workload pod labels',
  };
}

interface ContainerPort {
  name?: string;
  number?: number;
}

function workloadContainerPorts(workload: KubernetesDocument): ContainerPort[] {
  const containers = pathValues(workload, ['spec', 'template', 'spec', 'containers']);
  const ports: ContainerPort[] = [];
  for (const value of containers) {
    if (!Array.isArray(value)) continue;
    for (const container of value) {
      if (!isObject(container) || !Array.isArray(container.ports)) continue;
      for (const port of container.ports) {
        if (!isObject(port)) continue;
        ports.push({
          ...(typeof port.name === 'string' ? { name: port.name } : {}),
          ...(typeof port.containerPort === 'number'
            ? { number: port.containerPort }
            : {}),
        });
      }
    }
  }
  return ports;
}

function serviceTargetPortRelation(
  service: KubernetesDocument,
  workload: KubernetesDocument,
): RelationEvaluation {
  const servicePorts = objectAt(service, 'spec')?.ports;
  const containerPorts = workloadContainerPorts(workload);
  if (!Array.isArray(servicePorts) || servicePorts.length === 0) {
    return { pass: false, reason: 'Service ports are missing or empty' };
  }
  if (containerPorts.length === 0) {
    return { pass: false, reason: 'workload container ports are missing or empty' };
  }
  const pass = servicePorts.every((value) => {
    if (!isObject(value)) return false;
    const target = value.targetPort ?? value.port;
    return containerPorts.some((port) =>
      typeof target === 'string' ? port.name === target : port.number === target,
    );
  });
  return {
    pass,
    reason: pass
      ? 'every Service targetPort matches a workload container port'
      : 'a Service targetPort does not match the referenced workload container ports',
  };
}

interface IngressBackend {
  name?: string;
  portName?: string;
  portNumber?: number;
}

function ingressBackends(ingress: KubernetesDocument): IngressBackend[] {
  const backends: IngressBackend[] = [];
  const add = (value: unknown): void => {
    const service = objectAt(value, 'service');
    const port = isObject(service?.port) ? service.port : undefined;
    if (!service) return;
    backends.push({
      ...(typeof service.name === 'string' ? { name: service.name } : {}),
      ...(typeof port?.name === 'string' ? { portName: port.name } : {}),
      ...(typeof port?.number === 'number' ? { portNumber: port.number } : {}),
    });
  };
  const spec = isObject(ingress.spec) ? ingress.spec : undefined;
  add(spec?.defaultBackend);
  if (Array.isArray(spec?.rules)) {
    for (const rule of spec.rules) {
      const paths = objectAt(rule, 'http')?.paths;
      if (!Array.isArray(paths)) continue;
      for (const path of paths) add(isObject(path) ? path.backend : undefined);
    }
  }
  return backends;
}

function ingressServiceRelation(
  ingress: KubernetesDocument,
  service: KubernetesDocument,
): RelationEvaluation {
  const serviceName = metadataName(service);
  const servicePorts = objectAt(service, 'spec')?.ports;
  const backends = ingressBackends(ingress);
  if (!serviceName) return { pass: false, reason: 'Service metadata.name is missing' };
  if (!Array.isArray(servicePorts) || servicePorts.length === 0) {
    return { pass: false, reason: 'Service ports are missing or empty' };
  }
  if (backends.length === 0) {
    return { pass: false, reason: 'Ingress has no Service backend' };
  }
  const pass = backends.every((backend) => {
    if (backend.name !== serviceName) return false;
    return servicePorts.some(
      (value) =>
        isObject(value) &&
        ((backend.portName !== undefined && value.name === backend.portName) ||
          (backend.portNumber !== undefined && value.port === backend.portNumber)),
    );
  });
  return {
    pass,
    reason: pass
      ? 'Ingress backends reference the Service name and exposed port'
      : 'an Ingress backend does not reference the expected Service name and port',
  };
}

function statefulSetServiceRelation(
  statefulSet: KubernetesDocument,
  service: KubernetesDocument,
): RelationEvaluation {
  const serviceName = metadataName(service);
  const statefulSetServiceName = objectAt(statefulSet, 'spec')?.serviceName;
  const clusterIP = objectAt(service, 'spec')?.clusterIP;
  const pass =
    typeof serviceName === 'string' &&
    statefulSetServiceName === serviceName &&
    clusterIP === 'None';
  return {
    pass,
    reason: pass
      ? 'StatefulSet serviceName references the headless Service'
      : 'StatefulSet serviceName or headless Service clusterIP does not match',
  };
}

function hpaTargetRelation(
  hpa: KubernetesDocument,
  workload: KubernetesDocument,
): RelationEvaluation {
  const target = objectAt(hpa, 'spec', 'scaleTargetRef');
  const pass =
    target?.apiVersion === workload.apiVersion &&
    target?.kind === workload.kind &&
    target?.name === metadataName(workload);
  return {
    pass,
    reason: pass
      ? 'HPA scaleTargetRef matches the workload identity'
      : 'HPA scaleTargetRef does not match the workload identity',
  };
}

function deploymentConfigMapNames(deployment: KubernetesDocument): Set<string> {
  const names = new Set<string>();
  const templateSpec = objectAt(deployment, 'spec', 'template', 'spec');
  const containers = [
    ...(Array.isArray(templateSpec?.containers) ? templateSpec.containers : []),
    ...(Array.isArray(templateSpec?.initContainers)
      ? templateSpec.initContainers
      : []),
  ];
  for (const container of containers) {
    if (!isObject(container)) continue;
    if (Array.isArray(container.envFrom)) {
      for (const source of container.envFrom) {
        const name = objectAt(source, 'configMapRef')?.name;
        if (typeof name === 'string') names.add(name);
      }
    }
    if (Array.isArray(container.env)) {
      for (const env of container.env) {
        const name = objectAt(env, 'valueFrom', 'configMapKeyRef')?.name;
        if (typeof name === 'string') names.add(name);
      }
    }
  }
  if (Array.isArray(templateSpec?.volumes)) {
    for (const volume of templateSpec.volumes) {
      const name = objectAt(volume, 'configMap')?.name;
      if (typeof name === 'string') names.add(name);
    }
  }
  return names;
}

function deploymentConfigMapRelation(
  deployment: KubernetesDocument,
  configMap: KubernetesDocument,
): RelationEvaluation {
  const name = metadataName(configMap);
  const pass = typeof name === 'string' && deploymentConfigMapNames(deployment).has(name);
  return {
    pass,
    reason: pass
      ? 'Deployment references the ConfigMap identity'
      : 'Deployment does not reference the expected ConfigMap identity',
  };
}

function evaluateRelation(
  relation: ResourceRelation,
  resources: Map<string, ExpectedResourceResult>,
  documents: readonly KubernetesDocument[],
): ResourceRelationResult {
  for (const ref of relationReferences(relation)) {
    const endpoint = relationDocument(ref, resources, documents);
    if (!endpoint.document) {
      return {
        relation,
        pass: false,
        reason: endpoint.error ?? `resource ${ref} is unavailable`,
      };
    }
  }
  const doc = (ref: string): KubernetesDocument =>
    relationDocument(ref, resources, documents).document!;

  let result: RelationEvaluation;
  switch (relation.type) {
    case 'workload_selector_matches_template_labels':
      result = workloadSelectorRelation(doc(relation.workloadRef));
      break;
    case 'service_selector_matches_workload_labels':
      result = serviceSelectorRelation(
        doc(relation.serviceRef),
        doc(relation.workloadRef),
      );
      break;
    case 'service_target_port_matches_workload_container_port':
      result = serviceTargetPortRelation(
        doc(relation.serviceRef),
        doc(relation.workloadRef),
      );
      break;
    case 'ingress_backend_matches_service':
      result = ingressServiceRelation(
        doc(relation.ingressRef),
        doc(relation.serviceRef),
      );
      break;
    case 'statefulset_service_name_matches_headless_service':
      result = statefulSetServiceRelation(
        doc(relation.statefulSetRef),
        doc(relation.serviceRef),
      );
      break;
    case 'hpa_target_matches_workload':
      result = hpaTargetRelation(
        doc(relation.hpaRef),
        doc(relation.workloadRef),
      );
      break;
    case 'deployment_config_map_ref_matches':
      result = deploymentConfigMapRelation(
        doc(relation.deploymentRef),
        doc(relation.configMapRef),
      );
      break;
  }
  return { relation, ...result };
}

export function evaluateGenerationAssertions(
  contract: GenerationAssertionContract,
  documents: readonly KubernetesDocument[],
): GenerationAssertionResult {
  assertContract(contract, 'generationAssertions');
  const resources = contract.expectedResources.map((resource) =>
    evaluateExpectedResource(resource, documents),
  );
  const resourcesByRef = new Map(
    resources.map((resource) => [resource.ref, resource] as const),
  );
  const relations = (contract.relations ?? []).map((relation) =>
    evaluateRelation(relation, resourcesByRef, documents),
  );
  const resourceMatchPass = resources.every(
    (resource) => resource.match.status === 'matched',
  );
  const resourceAssertionPass = resources.every((resource) => resource.pass);
  const relationPass =
    relations.length === 0 ? null : relations.every((relation) => relation.pass);
  return {
    resources,
    relations,
    resourceMatchPass,
    resourceAssertionPass,
    relationPass,
    pass:
      resourceMatchPass &&
      resourceAssertionPass &&
      relationPass !== false,
  };
}
