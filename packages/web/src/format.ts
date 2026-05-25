/**
 * Turn a Claude Code project slug (a cwd with path separators replaced by `-`)
 * back into a human-readable path. Handles Windows (`C--Users-bob-…`), macOS
 * (`-Users-bob-…`) and Linux (`-home-bob-…`) home prefixes, collapsing them to
 * `~/`. The slug→path mapping is lossy (a literal `-` in a folder name is
 * indistinguishable from a separator), so this is display-only.
 */
export function prettySlug(slug: string): string {
  return slug
    .replace(/^[A-Za-z]--Users-[^-]+-/, "~/") // Windows: C--Users-<user>-
    .replace(/^-(?:Users|home)-[^-]+-/, "~/") // macOS / Linux home dir
    .replace(/-+/g, "/");
}
