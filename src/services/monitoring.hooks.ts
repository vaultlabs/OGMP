/**
 * Central place to plug in APM / metrics (OpenTelemetry, Datadog, Logtail, Sentry, etc.).
 * Keep payloads free of secrets and PII beyond opaque IDs.
 *
 * Example: in Sentry, `Sentry.captureMessage(name, { level: "info", extra: attrs })`.
 */
export const monitoring = {
  recordEvent(name: string, attrs?: Record<string, string | number | boolean>): void {
    void name;
    void attrs;
  },
};
