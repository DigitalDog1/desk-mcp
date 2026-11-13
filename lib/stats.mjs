export function summarize(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a-b);
  const quantile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { n: sorted.length, min: sorted[0], p50: quantile(0.5), p95: quantile(0.95), max: sorted.at(-1) };
}
