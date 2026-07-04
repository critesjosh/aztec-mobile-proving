import {
  benchReportToMarkdown,
  computeBenchReport,
  percentile,
  proveMetricsToSamples,
  summarizeFlow,
  type BenchSample,
} from '../src/bench/benchStats';

test('percentile: type-7 linear interpolation', () => {
  const s = [10, 20, 30, 40];
  expect(percentile(s, 0)).toBe(10);
  expect(percentile(s, 1)).toBe(40);
  expect(percentile(s, 0.5)).toBe(25); // between 20 and 30
  // p90 of 4 points: rank = 0.9*3 = 2.7 -> 30 + 0.7*(40-30) = 37
  expect(percentile(s, 0.9)).toBeCloseTo(37, 6);
  expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  expect(percentile([42], 0.9)).toBe(42);
});

test('summarizeFlow: drops the cold run and excludes throttled samples', () => {
  const samples: BenchSample[] = [
    {flow: 'transfer', phases: {prove: 9000, wall: 12000}, thermalState: 'nominal'}, // cold -> dropped
    {flow: 'transfer', phases: {prove: 2000, wall: 5000}, thermalState: 'nominal'},
    {flow: 'transfer', phases: {prove: 2200, wall: 5200}, thermalState: 'fair'},
    {flow: 'transfer', phases: {prove: 8000, wall: 15000}, thermalState: 'serious'}, // throttled -> excluded
    {flow: 'transfer', phases: {prove: 2400, wall: 5400}, thermalState: 'nominal'},
  ];
  const f = summarizeFlow('transfer', samples);
  expect(f.total).toBe(5);
  expect(f.coldDropped).toBe(1);
  expect(f.thermalExcluded).toBe(1);
  expect(f.used).toBe(3); // 2000, 2200, 2400
  expect(f.coldMs).toEqual({prove: 9000, wall: 12000});
  const prove = f.phases.find(p => p.phase === 'prove')!;
  expect(prove.n).toBe(3);
  expect(prove.p50).toBe(2200); // median of [2000,2200,2400]
  // the throttled 8000 must NOT have leaked into the tail
  expect(prove.p90).toBeLessThan(2500);
});

test('summarizeFlow: single sample is treated as cold and yields no percentiles', () => {
  const f = summarizeFlow('deploy', [{flow: 'deploy', phases: {prove: 5000, wall: 9000}}]);
  expect(f.coldDropped).toBe(1);
  expect(f.used).toBe(0);
  // Phase order is still discoverable from the cold run for a stable table.
  expect(f.phases.map(p => p.phase)).toEqual(['prove', 'wall']);
  expect(Number.isNaN(f.phases[0].p50)).toBe(true);
});

test('computeBenchReport: groups by flow preserving first-seen order', () => {
  const samples: BenchSample[] = [
    {flow: 'a', phases: {prove: 1}},
    {flow: 'b', phases: {prove: 1}},
    {flow: 'a', phases: {prove: 2}},
    {flow: 'a', phases: {prove: 3}},
  ];
  const r = computeBenchReport(samples);
  expect(r.flows.map(f => f.flow)).toEqual(['a', 'b']);
  const a = r.flows.find(f => f.flow === 'a')!;
  expect(a.total).toBe(3);
  expect(a.used).toBe(2);
});

test('proveMetricsToSamples: maps metrics through a flow classifier', () => {
  const metrics = [
    {proveMs: 2000, wallMs: 5000},
    {proveMs: 2200, wallMs: 5200},
    {proveMs: 9000, wallMs: 12000},
  ];
  const samples = proveMetricsToSamples(
    metrics,
    i => (i < 2 ? 'transfer' : undefined), // drop the unclassified one
    () => 'nominal',
  );
  expect(samples).toHaveLength(2);
  expect(samples[0]).toEqual({flow: 'transfer', phases: {prove: 2000, wall: 5000}, thermalState: 'nominal'});
});

test('benchReportToMarkdown: renders exclusion counts and a phase table', () => {
  const md = benchReportToMarkdown(
    computeBenchReport([
      {flow: 'transfer', phases: {prove: 9000}},
      {flow: 'transfer', phases: {prove: 2000}},
      {flow: 'transfer', phases: {prove: 2400}},
    ]),
  );
  expect(md).toContain('### transfer');
  expect(md).toContain('cold-dropped 1');
  expect(md).toContain('| prove |');
});
