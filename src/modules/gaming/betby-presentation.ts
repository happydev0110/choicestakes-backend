import type { Config } from "../../config/env.js";

/** Presentation routes and query names from BetbyLaunchParameters, section 6.
 * Apply only to the configured Betby game, after validating the provider URL.
 */
export function applyBetbyPresentation(link: string, theme: Config["SPORTSBOOK_THEME"]) {
  const url = new URL(link);
  const entry = /^\/(?:sports(?:\/embed)?|home)\/?$/.test(url.pathname);
  const layout = /^\/sportsbook\/(?:tile|sidebar|classic)(\/.*)?$/.exec(url.pathname);
  // An aggregator wrapper may not forward query parameters. Leave it intact
  // rather than guessing at its API or rewriting a nested/signed launch URL.
  if (!entry && !layout) return { link, applied: false };

  if (layout) url.pathname = `/sportsbook/tile${layout[1] ?? ""}`;
  // Preserve the encoding/order of session tokens and other provider values.
  // URLSearchParams.set() would reserialize the entire original query string.
  const query = url.search.slice(1).split("&").filter((part) => {
    if (!part) return false;
    const name = new URLSearchParams(part).keys().next().value;
    return name !== "color" && name !== "defaultLayout";
  });
  if (entry) query.push("defaultLayout=tile");
  query.push(`color=${encodeURIComponent(theme)}`);
  url.search = query.join("&");
  return { link: url.href, applied: true };
}
