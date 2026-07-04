/**
 * Benchmark aggregation methodology for on-device proving.
 *
 * Raw single-run timings are misleading on phones: the first run of a flow pays
 * cold-start costs (code/JIT warmup, SRS/page caches, class loading) that a
 * steady-state user does not, and a thermally-throttled device runs several x
 * slower than a cool one. So a fair benchmark reports DISTRIBUTIONS over many
 * runs, per phase, after two corrections:
 *
 *   1. DROP-COLD: the first sample of each flow is excluded from the percentile
 *      stats (reported separately as `coldMs`), because cold-start is a
 *      different regime from the steady state we want to characterize.
 *   2. THERMAL STRATIFICATION: samples taken while the OS reports a `serious`
 *      or `critical` thermal state are excluded from the headline percentiles
 *      (counted as `thermalExcluded`). Throttled runs are real but belong in a
 *      separate "under thermal pressure" line, not mixed into the nominal p50.
 *
 * We then report p50 and p90 per phase (not the mean — proving time is
 * right-skewed, so the median and tail are the honest summary). p90 is the
 * number a user actually feels on a bad-but-not-throttled run.
 *
 * This module is pure (no React Native / DOM deps) so it runs under Node in
 * unit tests and can aggregate either live samples or a recorded JSON log.
 *
 * NOTE (real-device wiring): the aggregator is ready today. Full population
 * needs (a) per-phase timings threaded out of the WebView flow (sync /
 * simulate / witgen / prove / verify) and (b) the OS thermal state read from a
 * native module (Android `PowerManager.getCurrentThermalStatus`, iOS
 * `ProcessInfo.thermalState`). Until then, `proveMetricsToSamples` populates the
 * `prove` and `wall` phases from the metrics we already collect, and
 * `thermalState` defaults to `unknown` (never excluded). All emulator numbers
 * remain labelled emulator numbers.
 */

export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';

/** Thermal states whose samples are excluded from the headline percentiles. */
const THROTTLED: ReadonlySet<ThermalState> = new Set<ThermalState>(['serious', 'critical']);

/** One measured run of a flow. `phases` maps a phase name to its duration (ms). */
export interface BenchSample {
  flow: string;
  phases: Record<string, number>;
  thermalState?: ThermalState;
}

export interface PhaseStat {
  phase: string;
  p50: number;
  p90: number;
  /** Number of (used) samples this stat was computed from. */
  n: number;
}

export interface FlowSummary {
  flow: string;
  /** Samples seen, before any exclusion. */
  total: number;
  /** First-run samples excluded as cold-start. */
  coldDropped: number;
  /** Samples excluded for serious/critical thermal state. */
  thermalExcluded: number;
  /** Samples actually used for the percentiles. */
  used: number;
  /** The dropped cold run's phase durations (first sample), if any. */
  coldMs?: Record<string, number>;
  /** p50/p90 per phase, over the used samples, in first-seen phase order. */
  phases: PhaseStat[];
}

export interface BenchReport {
  flows: FlowSummary[];
}

/**
 * Linear-interpolated percentile (type-7, matching NumPy default / Excel
 * PERCENTILE.INC). `p` in [0,1]. `sortedAsc` must be sorted ascending.
 */
export function percentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) {
    return NaN;
  }
  if (n === 1) {
    return sortedAsc[0];
  }
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) {
    return sortedAsc[lo];
  }
  const frac = rank - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

/**
 * Summarize one flow's samples. Applies drop-cold (first sample) then thermal
 * exclusion, then computes p50/p90 per phase over what remains. Samples must
 * all share the same `flow`; order is treated as chronological (first = cold).
 */
export function summarizeFlow(flow: string, samples: readonly BenchSample[]): FlowSummary {
  const total = samples.length;
  let coldDropped = 0;
  let coldMs: Record<string, number> | undefined;
  let afterCold = samples;
  if (samples.length > 0) {
    coldDropped = 1;
    coldMs = {...samples[0].phases};
    afterCold = samples.slice(1);
  }
  const used: BenchSample[] = [];
  let thermalExcluded = 0;
  for (const s of afterCold) {
    if (s.thermalState && THROTTLED.has(s.thermalState)) {
      thermalExcluded++;
    } else {
      used.push(s);
    }
  }

  // Phase order: first appearance across used samples (fall back to cold run).
  const order: string[] = [];
  const seen = new Set<string>();
  const sources = used.length > 0 ? used : coldMs ? [{phases: coldMs}] : [];
  for (const s of sources) {
    for (const phase of Object.keys(s.phases)) {
      if (!seen.has(phase)) {
        seen.add(phase);
        order.push(phase);
      }
    }
  }

  const phases: PhaseStat[] = order.map(phase => {
    const values = used
      .map(s => s.phases[phase])
      .filter((v): v is number => typeof v === 'number' && !Number.isNaN(v))
      .sort((a, b) => a - b);
    return {
      phase,
      p50: percentile(values, 0.5),
      p90: percentile(values, 0.9),
      n: values.length,
    };
  });

  return {flow, total, coldDropped, thermalExcluded, used: used.length, coldMs, phases};
}

/** Group samples by flow (preserving first-seen flow order) and summarize each. */
export function computeBenchReport(samples: readonly BenchSample[]): BenchReport {
  const byFlow = new Map<string, BenchSample[]>();
  for (const s of samples) {
    const list = byFlow.get(s.flow);
    if (list) {
      list.push(s);
    } else {
      byFlow.set(s.flow, [s]);
    }
  }
  return {flows: [...byFlow.entries()].map(([flow, list]) => summarizeFlow(flow, list))};
}

/**
 * Adapt the prove metrics we already collect into bench samples. `flowOf` maps
 * a metric to its flow name (e.g. by tx kind); metrics with no flow are
 * dropped. Populates the `prove` (final Chonk prove) and `wall` (whole native
 * JNI call) phases. Per-phase witgen/sync/simulate timings and thermal state
 * are added by callers as that instrumentation lands (see module note).
 */
export function proveMetricsToSamples(
  metrics: readonly {proveMs: number; wallMs: number}[],
  flowOf: (i: number) => string | undefined,
  thermalOf?: (i: number) => ThermalState | undefined,
): BenchSample[] {
  const out: BenchSample[] = [];
  metrics.forEach((m, i) => {
    const flow = flowOf(i);
    if (!flow) {
      return;
    }
    out.push({
      flow,
      phases: {prove: m.proveMs, wall: m.wallMs},
      thermalState: thermalOf?.(i),
    });
  });
  return out;
}

/** Render a compact markdown table for a report (used in the debug drawer / logs). */
export function benchReportToMarkdown(report: BenchReport): string {
  const lines: string[] = [];
  for (const f of report.flows) {
    lines.push(
      `### ${f.flow}  (used ${f.used}/${f.total}; cold-dropped ${f.coldDropped}; thermal-excluded ${f.thermalExcluded})`,
    );
    lines.push('| phase | p50 ms | p90 ms | n |');
    lines.push('|---|---|---|---|');
    for (const p of f.phases) {
      lines.push(`| ${p.phase} | ${Math.round(p.p50)} | ${Math.round(p.p90)} | ${p.n} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
