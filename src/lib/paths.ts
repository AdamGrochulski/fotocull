/**
 * Ostatni segment ścieżki (nazwa folderu) — do zwięzłego wyświetlania.
 * Obsługuje separatory Windows (\) i Unix (/).
 */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
