/** Tiny timing/benchmark recorder for testnet flows. */
export interface Phase {
  name: string;
  ms: number;
}

export class Bench {
  private phases: Phase[] = [];
  private t0 = Date.now();
  private last = this.t0;

  mark(name: string) {
    const now = Date.now();
    this.phases.push({ name, ms: now - this.last });
    this.last = now;
  }

  get totalMs() {
    return Date.now() - this.t0;
  }

  print(log: (s: string) => void) {
    log('--- benchmark ---');
    for (const p of this.phases) {
      log(`  ${p.name.padEnd(24)} ${p.ms} ms`);
    }
    log(`  ${'TOTAL'.padEnd(24)} ${this.totalMs} ms`);
  }

  toJSON() {
    return { phases: this.phases, totalMs: this.totalMs };
  }
}
