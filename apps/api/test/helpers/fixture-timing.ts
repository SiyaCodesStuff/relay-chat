const samples = new Map<string, number[]>();

export async function measureFixture<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    const values = samples.get(label) ?? [];
    values.push(performance.now() - started);
    samples.set(label, values);
  }
}

export function reportFixtureTimings() {
  for (const [label, values] of samples) {
    const totalMs = values.reduce((sum, value) => sum + value, 0);
    // Timing metadata only. Never include fixture identities, cookies or database values.
    console.info(
      `[fixture-timing] ${JSON.stringify({ label, count: values.length, totalMs, meanMs: totalMs / values.length })}`,
    );
  }
}
