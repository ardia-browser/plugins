const UNSAFE = /[^A-Za-z0-9_@%+=:,./-]/;

export function shlexQuote(text: string): string {
  if (!text) return "''";
  if (!UNSAFE.test(text)) return text;
  return `'${text.replaceAll("'", "'\"'\"'")}'`;
}
