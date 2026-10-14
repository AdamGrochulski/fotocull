/** Longest base name kept, leaving room for a `_N` suffix and the extension. */
const MAX_CHARS = 100;

/**
 * Preview of the backend's `sanitize_name` (src-tauri/src/names.rs): the name a
 * renamed photo is actually saved under, or "" when nothing usable is left and
 * the original name is kept. Separators and characters Windows rejects become
 * `-`, so "Meeting 14/10" is saved as "Meeting 14-10" instead of failing.
 */
export function sanitizeName(raw: string): string {
  const replaced = Array.from(raw)
    .map((c) => {
      if ('/\\:*?"<>|'.includes(c)) return "-";
      const code = c.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code < 0xa0) ? " " : c;
    })
    .join("");

  let name = replaced
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .trim();

  const chars = Array.from(name);
  if (chars.length > MAX_CHARS) {
    name = chars.slice(0, MAX_CHARS).join("").replace(/[. ]+$/, "");
  }
  if (!name) return "";

  const head = name.split(".")[0].toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(head)) {
    const at = name.indexOf(".");
    name = at === -1 ? `${name}_` : `${name.slice(0, at)}_${name.slice(at)}`;
  }
  return name;
}
