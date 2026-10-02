/**
 * Whether what someone typed into the box is a furl to unfurl, given what
 * parseFurlLink found in it. A link counts only on one of our own hosts. Bare
 * text counts only when it is nothing but furl characters: "intranet/",
 * "/word" or "#word" go to the enfurl path, because a typed word with a slash
 * is far more likely a host than a furl, and unfurling it gives garbage.
 */
export function pastedFurl(
  raw: string,
  link: { code: string; host: string } | null,
  ownHosts: string[],
): { code: string; wrapped: boolean } | null {
  if (!link) return null;
  if (link.host) return ownHosts.includes(link.host) ? { code: link.code, wrapped: true } : null;
  return /^[A-Za-z0-9_-]+\+?$/.test(raw) ? { code: link.code, wrapped: false } : null;
}
