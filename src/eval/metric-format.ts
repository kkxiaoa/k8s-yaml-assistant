import type { MetricObservation } from './protocol';
import type { MetricUnit } from './metrics/definitions';

function numberText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function signedNumberText(value: number): string {
  return `${value >= 0 ? '+' : ''}${numberText(value)}`;
}

export function formatMetricValue(unit: MetricUnit, value: number): string {
  switch (unit) {
    case 'ratio':
      return `${(value * 100).toFixed(1)}%`;
    case 'milliseconds':
      return `${numberText(value)} ms`;
    case 'tokens':
      return `${numberText(value)} tokens`;
    case 'usd':
      return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(6)}`;
    case 'count':
    case 'number':
      return numberText(value);
  }
}

export function formatMetricDelta(unit: MetricUnit, value: number): string {
  switch (unit) {
    case 'ratio':
      return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
    case 'milliseconds':
      return `${signedNumberText(value)} ms`;
    case 'tokens':
      return `${signedNumberText(value)} tokens`;
    case 'usd':
      return `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(6)}`;
    case 'count':
    case 'number':
      return signedNumberText(value);
  }
}

export function formatMetricObservation(
  unit: MetricUnit,
  observation: MetricObservation,
): string {
  const value =
    observation.value === null
      ? 'N/A'
      : formatMetricValue(unit, observation.value);
  if (unit !== 'ratio') return value;
  if (
    observation.numerator === undefined ||
    observation.denominator === undefined
  ) {
    throw new TypeError(
      'ratio observation requires numerator and denominator for formatting',
    );
  }
  return `${value} (${numberText(observation.numerator)}/${numberText(observation.denominator)})`;
}
