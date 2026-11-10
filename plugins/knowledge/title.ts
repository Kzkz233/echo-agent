/** Package transport filenames are not useful display names. Explicit meaningful titles win. */
export function documentTitle(name: string, text: string, logicalPath?: string) {
  const generic = (s: string) => /^(content|index|readme)(\.[a-z0-9]+)?$/i.test(s.trim());
  const base = name.replace(/\\/g, '/').split('/').at(-1) ?? name;
  if (!generic(base)) return base.slice(0, 500);
  const heading = text.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1];
  if (heading && !generic(heading)) return heading.slice(0, 500);
  const parts = (logicalPath ?? name).replace(/\\/g, '/').split('/').filter(Boolean);
  if (generic(parts.at(-1) ?? '')) parts.pop();
  return (parts.at(-1) ?? base).slice(0, 500);
}
