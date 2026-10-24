// Probes the CouchDB URL that devices actually use (COUCHDB_PUBLIC_URL), the
// way the LiveSync plugin's own "Check database configuration" does: one
// request per required origin, verifying that the response echoes the origin
// in Access-Control-Allow-Origin and allows credentials. The config check in
// serverConfig.ts reads CouchDB's settings over the admin URL and cannot see
// what a reverse proxy does on the devices' path: redirects, stripped CORS
// headers, or TLS problems all pass it while every device fails. This probe
// sends no credentials and follows no redirects.

import { REQUIRED_CORS_ORIGINS } from './serverConfig.js';

export interface ProbeResponse {
  status: number;
  headers: { get(name: string): string | null };
}

export type FetchLike = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal },
) => Promise<ProbeResponse>;

export interface OriginProbe {
  origin: string;
  ok: boolean;
  httpStatus: number | null;
  allowOrigin: string | null;
  allowCredentials: string | null;
  /** Actionable, one per defect. */
  problems: string[];
}

export interface PublicUrlProbe {
  status: 'ok' | 'warn' | 'fail';
  url: string;
  scheme: string;
  /** The `Server` response header, when the endpoint answered. */
  server: string | null;
  origins: OriginProbe[];
  /** URL-level problems (scheme), plus a one-line summary of origin failures. */
  problems: string[];
  checkedAt: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') {
    return true;
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 127 ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254)
    );
  }
  return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
}

function schemeProblem(url: URL): string | null {
  if (url.protocol === 'https:') {
    return null;
  }
  if (url.protocol !== 'http:') {
    return (
      `COUCHDB_PUBLIC_URL uses the scheme "${url.protocol.replace(/:$/, '')}", which Obsidian ` +
      'cannot open. Use an https URL.'
    );
  }
  return isLocalOrPrivateHost(url.hostname)
    ? 'COUCHDB_PUBLIC_URL is plain http on a local or private address. That works for desktop ' +
        'clients on the same network, but Obsidian on iOS and Android requires https with a ' +
        'certificate the operating system trusts. Put a TLS proxy in front of CouchDB before ' +
        'onboarding mobile devices.'
    : 'COUCHDB_PUBLIC_URL is plain http. Device credentials would travel unencrypted and ' +
        'Obsidian on iOS and Android refuses plain http. Serve CouchDB through a TLS proxy and ' +
        'set COUCHDB_PUBLIC_URL to its https URL.';
}

async function probeOrigin(
  base: string,
  origin: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<{ result: OriginProbe; server: string | null }> {
  const result: OriginProbe = {
    origin,
    ok: false,
    httpStatus: null,
    allowOrigin: null,
    allowCredentials: null,
    problems: [],
  };
  let response: ProbeResponse;
  try {
    response = await fetchImpl(`${base}/`, {
      method: 'GET',
      headers: { Origin: origin, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const cause = (err as Error & { cause?: Error }).cause;
    const reason = cause?.message ?? (err as Error).message;
    result.problems.push(
      `Could not reach ${base} from the manager (${reason}). Devices probably cannot either: ` +
        'check DNS, that the proxy forwards this host to CouchDB, and that its TLS certificate ' +
        'is valid and complete.',
    );
    return { result, server: null };
  }
  result.httpStatus = response.status;
  result.allowOrigin = response.headers.get('access-control-allow-origin');
  result.allowCredentials = response.headers.get('access-control-allow-credentials');
  const server = response.headers.get('server');

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    result.problems.push(
      `${base} answers with a redirect (HTTP ${response.status}${location ? ` to ${location}` : ''}). ` +
        'LiveSync does not follow redirects on this URL and the CORS headers are lost on the way. ' +
        'Set COUCHDB_PUBLIC_URL to the final URL (same scheme, host and path the proxy redirects ' +
        'to) or stop the proxy from redirecting CouchDB requests.',
    );
    return { result, server };
  }
  if (response.status >= 500) {
    result.problems.push(
      `${base} answered HTTP ${response.status}. The proxy or CouchDB behind it is unhealthy; ` +
        'check the proxy upstream and CouchDB logs.',
    );
    return { result, server };
  }
  if (result.allowOrigin === null) {
    result.problems.push(
      `No Access-Control-Allow-Origin header for Origin ${origin}. Enable CORS in CouchDB ` +
        '(chttpd/enable_cors = true, cors/origins listing this origin) and make sure the proxy ' +
        "passes CouchDB's CORS headers through unchanged rather than adding or stripping them.",
    );
  } else if (result.allowOrigin !== origin) {
    result.problems.push(
      `Access-Control-Allow-Origin is "${result.allowOrigin}" for Origin ${origin}; browsers ` +
        'require the exact origin to be echoed when credentials are used. Add this origin to ' +
        'cors/origins in CouchDB and remove any CORS headers the proxy adds itself.',
    );
  }
  if (result.allowCredentials !== 'true') {
    result.problems.push(
      `Access-Control-Allow-Credentials is ${
        result.allowCredentials === null ? 'missing' : `"${result.allowCredentials}"`
      } for Origin ${origin}. Set cors/credentials = true in CouchDB and do not let the proxy ` +
        'strip or rewrite it; without it devices cannot authenticate.',
    );
  }
  result.ok = result.problems.length === 0;
  return { result, server };
}

/**
 * Checks the devices' CouchDB URL end to end. Never throws for a bad
 * endpoint; the result carries the problems. Only a malformed URL throws.
 */
export async function probePublicUrl(
  publicUrl: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<PublicUrlProbe> {
  const url = new URL(publicUrl);
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = publicUrl.replace(/\/+$/, '');
  const problems: string[] = [];
  const scheme = schemeProblem(url);
  if (scheme) {
    problems.push(scheme);
  }
  const origins: OriginProbe[] = [];
  let server: string | null = null;
  for (const origin of REQUIRED_CORS_ORIGINS) {
    const probed = await probeOrigin(base, origin, fetchImpl, timeoutMs);
    origins.push(probed.result);
    server ??= probed.server;
  }
  const failing = origins.filter((o) => !o.ok);
  if (failing.length > 0) {
    problems.push(
      `${failing.length} of ${origins.length} LiveSync origins cannot use ${base}: ` +
        failing.map((o) => o.origin).join(', ') +
        '. Desktop and mobile clients fail silently at this stage; see the per-origin details.',
    );
  }
  return {
    status: failing.length > 0 ? 'fail' : scheme ? 'warn' : 'ok',
    url: base,
    scheme: url.protocol.replace(/:$/, ''),
    server,
    origins,
    problems,
    checkedAt: new Date().toISOString(),
  };
}
