/**
 * Central place to plug in APM / metrics (OpenTelemetry, Datadog, etc.).
 * Keep payloads free of secrets and PII beyond opaque IDs.
 */
export const monitoring = {
  recordEvent(name: string, attrs?: Record<string, string | number | boolean>): void {
    void name;
    void attrs;
  },
};
