export function isPercentMetric(key: string): boolean {
  return (
    key.endsWith('_rate') ||
    key.endsWith('_coverage') ||
    key.includes('.recall@') ||
    key.includes('.mrr@')
  );
}

export function formatMetricValue(key: string, value: number): string {
  if (isPercentMetric(key)) {
    return `${(value * 100).toFixed(1)}%`;
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

export function formatMetricDelta(key: string, value: number): string {
  const sign = value >= 0 ? '+' : '';
  if (isPercentMetric(key)) {
    return `${sign}${(value * 100).toFixed(1)}%`;
  }
  return `${sign}${Number.isInteger(value) ? value : value.toFixed(3)}`;
}
