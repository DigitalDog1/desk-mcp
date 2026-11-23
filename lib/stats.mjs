export function summarize(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a-b);
  const quantile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { n: sorted.length, min: sorted[0], median, p50: quantile(0.5), p95: quantile(0.95), max: sorted.at(-1) };
}
