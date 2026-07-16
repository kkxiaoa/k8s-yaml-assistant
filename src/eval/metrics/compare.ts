import type {
  EvalBaseline,
  EvalKind,
  EvalRun,
  MetricObservation,
} from '../protocol';
import {
  METRIC_DEFINITION_VERSION,
  metricDefinitionsForKind,
  type MetricDirection,
} from './definitions';

export type MetricVerdict =
  | 'improved'
  | 'regressed'
  | 'unchanged'
  | 'neutral'
  | 'not_comparable';

export type MetricComparisonReason =
  | 'current_na'
  | 'baseline_na'
  | 'both_na'
  | 'comparison_identity_incompatible';

export interface MetricComparison {
  key: string;
  current: MetricObservation;
  baseline: MetricObservation;
  delta: number | null;
  verdict: MetricVerdict;
  reason?: MetricComparisonReason;
}

export interface MetricGap {
  key: string;
  missingFrom: 'current' | 'baseline' | 'both';
}

export interface MetricRecordComparison {
  comparisons: MetricComparison[];
  requiredGaps: MetricGap[];
  diagnosticGaps: MetricGap[];
  unregisteredCurrentKeys: string[];
  unregisteredBaselineKeys: string[];
  hasBlockingHarnessGap: boolean;
}

export type ComparisonIdentityIssueCode =
  | 'kind_mismatch'
  | 'dataset_id_mismatch'
  | 'dataset_hash_mismatch'
  | 'dataset_case_count_mismatch'
  | 'metric_definition_version_mismatch'
  | 'unsupported_metric_definition_version'
  | 'retrieval_k_mismatch';

export interface ComparisonIdentityIssue {
  code: ComparisonIdentityIssueCode;
  path: string;
  current: string | number;
  baseline: string | number;
  expected?: string | number;
}

export interface ExperimentVariableChange {
  path: string;
  current: unknown;
  baseline: unknown;
}

export interface EvalMetricComparison extends MetricRecordComparison {
  compatible: boolean;
  identityIssues: ComparisonIdentityIssue[];
  experimentChanges: ExperimentVariableChange[];
}

function comparisonVerdict(
  direction: MetricDirection,
  delta: number,
): MetricVerdict {
  if (direction === 'neutral') return 'neutral';
  if (delta === 0) return 'unchanged';
  if (direction === 'higher_is_better') {
    return delta > 0 ? 'improved' : 'regressed';
  }
  return delta < 0 ? 'improved' : 'regressed';
}

function compareObservation(
  key: string,
  direction: MetricDirection,
  current: MetricObservation,
  baseline: MetricObservation,
): MetricComparison {
  if (current.value === null || baseline.value === null) {
    const reason =
      current.value === null && baseline.value === null
        ? 'both_na'
        : current.value === null
          ? 'current_na'
          : 'baseline_na';
    return {
      key,
      current,
      baseline,
      delta: null,
      verdict: 'not_comparable',
      reason,
    };
  }

  const delta = current.value - baseline.value;
  return {
    key,
    current,
    baseline,
    delta,
    verdict: comparisonVerdict(direction, delta),
  };
}

function metricGap(
  key: string,
  hasCurrent: boolean,
  hasBaseline: boolean,
): MetricGap {
  return {
    key,
    missingFrom:
      !hasCurrent && !hasBaseline
        ? 'both'
        : !hasCurrent
          ? 'current'
          : 'baseline',
  };
}

export function compareMetricRecords(
  evalKind: EvalKind,
  current: Readonly<Record<string, MetricObservation>>,
  baseline: Readonly<Record<string, MetricObservation>>,
): MetricRecordComparison {
  const definitions = [...metricDefinitionsForKind(evalKind)].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
  const registeredKeys = new Set(definitions.map((definition) => definition.key));
  const comparisons: MetricComparison[] = [];
  const requiredGaps: MetricGap[] = [];
  const diagnosticGaps: MetricGap[] = [];

  for (const definition of definitions) {
    const hasCurrent = Object.hasOwn(current, definition.key);
    const hasBaseline = Object.hasOwn(baseline, definition.key);
    if (!hasCurrent || !hasBaseline) {
      const gap = metricGap(definition.key, hasCurrent, hasBaseline);
      if (definition.stability === 'required') requiredGaps.push(gap);
      else diagnosticGaps.push(gap);
      continue;
    }

    comparisons.push(
      compareObservation(
        definition.key,
        definition.direction,
        current[definition.key]!,
        baseline[definition.key]!,
      ),
    );
  }

  const unregisteredCurrentKeys = Object.keys(current)
    .filter((key) => !registeredKeys.has(key))
    .sort();
  const unregisteredBaselineKeys = Object.keys(baseline)
    .filter((key) => !registeredKeys.has(key))
    .sort();

  return {
    comparisons,
    requiredGaps,
    diagnosticGaps,
    unregisteredCurrentKeys,
    unregisteredBaselineKeys,
    hasBlockingHarnessGap:
      requiredGaps.length > 0 ||
      unregisteredCurrentKeys.length > 0 ||
      unregisteredBaselineKeys.length > 0,
  };
}

function identityIssue(
  code: ComparisonIdentityIssueCode,
  path: string,
  current: string | number,
  baseline: string | number,
  expected?: string | number,
): ComparisonIdentityIssue {
  return {
    code,
    path,
    current,
    baseline,
    ...(expected === undefined ? {} : { expected }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectExperimentChanges(
  current: unknown,
  baseline: unknown,
  path: string,
  ignoredPaths: ReadonlySet<string>,
  changes: ExperimentVariableChange[],
): void {
  if (ignoredPaths.has(path) || Object.is(current, baseline)) return;

  if (isRecord(current) && isRecord(baseline)) {
    const keys = new Set([...Object.keys(current), ...Object.keys(baseline)]);
    for (const key of [...keys].sort()) {
      collectExperimentChanges(
        current[key],
        baseline[key],
        `${path}.${key}`,
        ignoredPaths,
        changes,
      );
    }
    return;
  }

  changes.push({ path, current, baseline });
}

function incompatibleComparisons(
  comparisons: readonly MetricComparison[],
): MetricComparison[] {
  return comparisons.map((comparison) => ({
    ...comparison,
    delta: null,
    verdict: 'not_comparable',
    reason: 'comparison_identity_incompatible',
  }));
}

export function compareEvalArtifacts(
  current: EvalRun,
  baseline: EvalBaseline,
): EvalMetricComparison {
  const identityIssues: ComparisonIdentityIssue[] = [];
  if (current.kind !== baseline.kind) {
    identityIssues.push(
      identityIssue(
        'kind_mismatch',
        'kind',
        current.kind,
        baseline.kind,
      ),
    );
    return {
      compatible: false,
      identityIssues,
      experimentChanges: [],
      comparisons: [],
      requiredGaps: [],
      diagnosticGaps: [],
      unregisteredCurrentKeys: [],
      unregisteredBaselineKeys: [],
      hasBlockingHarnessGap: false,
    };
  }

  if (current.dataset.id !== baseline.dataset.id) {
    identityIssues.push(
      identityIssue(
        'dataset_id_mismatch',
        'dataset.id',
        current.dataset.id,
        baseline.dataset.id,
      ),
    );
  }
  if (current.dataset.hash !== baseline.dataset.hash) {
    identityIssues.push(
      identityIssue(
        'dataset_hash_mismatch',
        'dataset.hash',
        current.dataset.hash,
        baseline.dataset.hash,
      ),
    );
  }
  if (current.dataset.caseCount !== baseline.dataset.caseCount) {
    identityIssues.push(
      identityIssue(
        'dataset_case_count_mismatch',
        'dataset.caseCount',
        current.dataset.caseCount,
        baseline.dataset.caseCount,
      ),
    );
  }
  if (
    current.metricDefinitionVersion !== baseline.metricDefinitionVersion
  ) {
    identityIssues.push(
      identityIssue(
        'metric_definition_version_mismatch',
        'metricDefinitionVersion',
        current.metricDefinitionVersion,
        baseline.metricDefinitionVersion,
      ),
    );
  } else if (current.metricDefinitionVersion !== METRIC_DEFINITION_VERSION) {
    identityIssues.push(
      identityIssue(
        'unsupported_metric_definition_version',
        'metricDefinitionVersion',
        current.metricDefinitionVersion,
        baseline.metricDefinitionVersion,
        METRIC_DEFINITION_VERSION,
      ),
    );
  }
  if (
    current.kind === 'retrieval' &&
    baseline.kind === 'retrieval' &&
    current.config.k !== baseline.config.k
  ) {
    identityIssues.push(
      identityIssue(
        'retrieval_k_mismatch',
        'config.k',
        current.config.k,
        baseline.config.k,
      ),
    );
  }

  const metricComparison = compareMetricRecords(
    current.kind,
    current.metrics,
    baseline.metrics,
  );
  const ignoredPaths = new Set<string>();
  if (current.kind === 'retrieval') ignoredPaths.add('config.k');
  const experimentChanges: ExperimentVariableChange[] = [];
  collectExperimentChanges(
    current.config,
    baseline.config,
    'config',
    ignoredPaths,
    experimentChanges,
  );

  const compatible = identityIssues.length === 0;
  return {
    compatible,
    identityIssues,
    experimentChanges,
    ...metricComparison,
    comparisons: compatible
      ? metricComparison.comparisons
      : incompatibleComparisons(metricComparison.comparisons),
  };
}
