// The one way a `{{key}}` locale template is filled in this plugin's code
// (the frontend's t() is core's i18next). tests/backend/template-fill.test.ts
// fails on any other `.replace` of a `{{` placeholder in src/.

/**
 * Fills `{{key}}` placeholders in one pass. A callback, so `$&`, `$1` or a
 * placeholder inside an inserted value is kept as it is, never read again.
 * A placeholder with no value is left as it is.
 */
export function fill(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key)
      ? String(values[key])
      : match,
  );
}
