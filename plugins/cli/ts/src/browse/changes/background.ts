export const BACKGROUND_TYPES = new Set([
  "Ping", "CSPViolationReport", "Image", "Media", "Font", "Prefetch", "Manifest", "TextTrack", "SignedExchange", "FedCM", "EventSource", "WebSocket",
]);

export const BACKGROUND_HOSTS = [
  "google-analytics.com", "analytics.google.com", "googletagmanager.com", "googletagservices.com", "doubleclick.net", "googlesyndication.com",
  "googleadservices.com", "adservice.google.com", "stats.g.doubleclick.net", "facebook.net", "connect.facebook.net", "segment.io", "segment.com",
  "mixpanel.com", "amplitude.com", "hotjar.com", "hotjar.io", "clarity.ms", "sentry.io", "ingest.sentry.io", "bugsnag.com", "browser-intake-datadoghq.com",
  "browser-intake-datadoghq.eu", "nr-data.net", "newrelic.com", "fullstory.com", "heapanalytics.com", "plausible.io", "posthog.com", "i.posthog.com",
  "ads.linkedin.com", "bat.bing.com", "clarity.microsoft.com", "analytics.tiktok.com", "tr.snapchat.com", "sc-static.net",
  "quantserve.com", "scorecardresearch.com", "chartbeat.com", "chartbeat.net", "cloudflareinsights.com", "amazon-adsystem.com", "adnxs.com",
  "criteo.com", "criteo.net", "taboola.com", "outbrain.com", "rubiconproject.com", "pubmatic.com", "openx.net", "casalemedia.com", "moatads.com",
  "adsrvr.org", "demdex.net", "omtrdc.net", "everesttech.net", "krxd.net", "bluekai.com", "rlcdn.com", "yieldmo.com", "sharethrough.com", "3lift.com",
  "branch.io", "app-measurement.com", "intercom.io", "intercomcdn.com", "onesignal.com",
  "ct.pinterest.com", "px.ads.linkedin.com", "snap.licdn.com", "mouseflow.com", "crazyegg.com", "matomo.cloud", "kissmetrics.com", "rum.hlx.page",
  "mediamelon.com", "conviva.com", "imrworldwide.com", "litix.io", "jwpltx.com", "metrics.brightcove.com", "parsely.com", "permutive.com", "permutive.app",
  "adsafeprotected.com", "doubleverify.com", "teads.tv", "media.net", "npttech.com", "cxense.com", "tealiumiq.com", "tiqcdn.com", "ensighten.com",
];

export const BACKGROUND_PATHS = ["/g/collect", "/j/collect", "/r/collect", "/cdn-cgi/rum"];
const PATHS = new Set(BACKGROUND_PATHS);
const ICON = /(^|\/)(favicon[^/]*|apple-touch-icon[^/]*)$/iu;

const HOSTS = new Set(BACKGROUND_HOSTS);

function parts(url: string): [string, string] | null {
  const scheme = url.indexOf("://");
  if (scheme < 0) return null;
  const rest = url.slice(scheme + 3);
  const end = rest.search(/[/?#]/u);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d+$/u, "").replace(/\.$/u, "").toLowerCase();
  const path = end < 0 || rest[end] !== "/" ? "/" : rest.slice(end).replace(/[?#].*$/su, "");
  return [host, path];
}

export function backgroundPath(url: string, method = "GET"): boolean {
  const path = parts(url)?.[1];
  if (path === undefined) return false;
  const trimmed = path.length > 1 ? path.replace(/\/+$/u, "") : path;
  return PATHS.has(trimmed.toLowerCase()) || (method === "GET" && ICON.test(trimmed));
}

export function backgroundHost(url: string): boolean {
  let at = parts(url)?.[0] ?? null;
  while (at) {
    if (HOSTS.has(at)) return true;
    const dot = at.indexOf(".");
    if (dot < 0) return false;
    at = at.slice(dot + 1);
  }
  return false;
}

export function knownCollector(url: string, method = "GET"): boolean {
  return backgroundHost(url) || backgroundPath(url, method.toUpperCase());
}

export function background(type: string, url: string, method = "GET"): boolean {
  return BACKGROUND_TYPES.has(type) || backgroundHost(url) || backgroundPath(url, method.toUpperCase());
}
