import {
  EvalCaseOriginSchema,
  EvalCaseRoleSchema,
  EvalCaseTaskSchema,
  type GovernedEvalCase,
} from './cases/governance';
import { formatMetricObservation } from './metric-format';
import {
  MetricUnitSchema,
  type MetricUnit,
} from './metrics/definitions';
import {
  MetricObservationSchema,
  type MetricObservation,
} from './protocol';

export const GOVERNANCE_REPORT_DIMENSIONS = [
  'task',
  'origin',
  'role',
] as const;

export type GovernanceReportDimension =
  (typeof GOVERNANCE_REPORT_DIMENSIONS)[number];

export interface GovernanceDisplayMetric {
  label: string;
  unit: MetricUnit;
  observation: MetricObservation;
}

export interface GovernanceBucketReport {
  value: string;
  selectedCaseIds: string[];
  completedCaseIds: string[];
  harnessErrorCaseIds: string[];
  selected: number;
  completed: number;
  harnessError: number;
  metrics: GovernanceDisplayMetric[];
}

export interface GovernanceDimensionReport {
  dimension: GovernanceReportDimension;
  buckets: GovernanceBucketReport[];
}

export interface GovernanceReport {
  dimensions: GovernanceDimensionReport[];
}

interface HarnessErrorReference {
  evalCaseId: string;
}

export function requireGovernanceMetric(
  metrics: Readonly<Record<string, MetricObservation>>,
  key: string,
): MetricObservation {
  const observation = metrics[key];
  if (observation === undefined) {
    throw new Error(`missing governance report metric: ${key}`);
  }
  return observation;
}

function dimensionValues(
  dimension: GovernanceReportDimension,
): readonly string[] {
  switch (dimension) {
    case 'task':
      return EvalCaseTaskSchema.options;
    case 'origin':
      return EvalCaseOriginSchema.options;
    case 'role':
      return EvalCaseRoleSchema.options;
  }
}

function uniqueCaseMap<T extends { id: string }>(
  values: readonly T[],
  label: string,
): Map<string, T> {
  const byId = new Map<string, T>();
  for (const value of values) {
    if (!value.id) throw new Error(`${label} case id must not be empty`);
    if (byId.has(value.id)) {
      throw new Error(`duplicate ${label} case id: ${value.id}`);
    }
    byId.set(value.id, value);
  }
  return byId;
}

function displayMetrics(
  values: readonly GovernanceDisplayMetric[],
): GovernanceDisplayMetric[] {
  return values.map((metric) => {
    if (!metric.label.trim()) {
      throw new Error('governance display metric label must not be empty');
    }
    return {
      label: metric.label,
      unit: MetricUnitSchema.parse(metric.unit),
      observation: MetricObservationSchema.parse(metric.observation),
    };
  });
}

export function buildGovernanceReport<
  TCase extends GovernedEvalCase,
  TResult,
>(params: {
  cases: readonly TCase[];
  results: readonly TResult[];
  harnessErrors: readonly HarnessErrorReference[];
  resultCaseId: (result: TResult) => string;
  aggregate: (results: readonly TResult[]) => readonly GovernanceDisplayMetric[];
}): GovernanceReport {
  const selectedById = uniqueCaseMap(params.cases, 'selected');
  const resultsWithIds = params.results.map((result) => ({
    id: params.resultCaseId(result),
    result,
  }));
  const completedById = uniqueCaseMap(resultsWithIds, 'completed');
  const harnessById = uniqueCaseMap(
    params.harnessErrors.map((error) => ({ id: error.evalCaseId, error })),
    'harness error',
  );

  for (const caseId of completedById.keys()) {
    if (!selectedById.has(caseId)) {
      throw new Error(`completed case is not selected: ${caseId}`);
    }
    if (harnessById.has(caseId)) {
      throw new Error(`case is both completed and harness error: ${caseId}`);
    }
  }
  for (const caseId of harnessById.keys()) {
    if (!selectedById.has(caseId)) {
      throw new Error(`harness error case is not selected: ${caseId}`);
    }
  }

  const unresolved = [...selectedById.keys()].filter(
    (caseId) => !completedById.has(caseId) && !harnessById.has(caseId),
  );
  if (unresolved.length > 0) {
    throw new Error(
      `selected cases do not reconcile with completed and harness errors: ${unresolved.join(', ')}`,
    );
  }

  return {
    dimensions: GOVERNANCE_REPORT_DIMENSIONS.map((dimension) => ({
      dimension,
      buckets: dimensionValues(dimension).flatMap((value) => {
        const selectedCases = params.cases.filter(
          (evalCase) => evalCase.governance[dimension] === value,
        );
        if (selectedCases.length === 0) return [];
        const completed = selectedCases.flatMap((evalCase) => {
          const entry = completedById.get(evalCase.id);
          return entry === undefined ? [] : [entry.result];
        });
        const completedCaseIds = selectedCases.flatMap((evalCase) =>
          completedById.has(evalCase.id) ? [evalCase.id] : [],
        );
        const harnessErrorCaseIds = selectedCases.flatMap((evalCase) =>
          harnessById.has(evalCase.id) ? [evalCase.id] : [],
        );
        return [
          {
            value,
            selectedCaseIds: selectedCases.map((evalCase) => evalCase.id),
            completedCaseIds,
            harnessErrorCaseIds,
            selected: selectedCases.length,
            completed: completedCaseIds.length,
            harnessError: harnessErrorCaseIds.length,
            metrics: displayMetrics(params.aggregate(completed)),
          },
        ];
      }),
    })),
  };
}

export function formatGovernanceReport(report: GovernanceReport): string {
  const lines = ['━━━━━━ 治理分桶 ━━━━━━'];
  for (const dimension of report.dimensions) {
    lines.push(`${dimension.dimension}:`);
    if (dimension.buckets.length === 0) {
      lines.push('- 无已选择用例');
      continue;
    }
    for (const bucket of dimension.buckets) {
      const metrics = bucket.metrics
        .map(
          (metric) =>
            `${metric.label}=${formatMetricObservation(metric.unit, metric.observation)}`,
        )
        .join(' ');
      lines.push(
        `- ${bucket.value}: selected=${bucket.selected} completed=${bucket.completed} harness error=${bucket.harnessError}${metrics ? ` | ${metrics}` : ''}`,
      );
    }
  }
  return lines.join('\n');
}

export function formatGovernanceCoverage(
  label: string,
  cases: readonly GovernedEvalCase[],
): string {
  const lines = [`${label}:`];
  for (const dimension of GOVERNANCE_REPORT_DIMENSIONS) {
    const counts = new Map<string, number>();
    for (const evalCase of cases) {
      const value = evalCase.governance[dimension];
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const values = dimensionValues(dimension);
    const present = values
      .flatMap((value) => {
        const count = counts.get(value);
        return count === undefined ? [] : [`${value}=${count}`];
      })
      .join(', ');
    const missing = values.filter((value) => !counts.has(value)).join(', ');
    lines.push(
      `  ${dimension}: ${present || '<none>'}; missing=${missing || '<none>'}`,
    );
  }
  return lines.join('\n');
}
