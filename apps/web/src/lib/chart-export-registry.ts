export interface ChartExportSnapshot {
  dataUrl: string;
  width: number;
  height: number;
}

export type ChartExportProvider = () => ChartExportSnapshot | null;

const registry = new WeakMap<Element, ChartExportProvider>();

/**
 * Register a snapshot provider for a rendered chart host element.
 * Returns an unregister callback that only removes this exact provider.
 */
export function registerChartExporter(
  element: Element,
  provider: ChartExportProvider,
): () => void {
  registry.set(element, provider);
  return () => {
    if (registry.get(element) === provider) {
      registry.delete(element);
    }
  };
}

/** Capture a chart PNG snapshot from an element or its registered chart host. */
export function captureRegisteredChart(element: Element): ChartExportSnapshot | null {
  const provider = registry.get(element);
  if (!provider) return null;
  try {
    return provider();
  } catch {
    return null;
  }
}
