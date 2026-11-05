/**
 * The plain-browser fallback of `requestAuthCode()`: standard OIDC at the single issuer, the app being a
 * public client with PKCE. First silently (`prompt=none`); when the issuer answers that the user must
 * sign in or consent, once more without it (the sign-in page, the per-scope consent page). The page
 * navigates away; when it comes back with `?code&state`, calling `requestAuthCode()` again returns the
 * code with the `redirectUri` and `codeVerifier` the backend needs for `exchangeAuthCode`.
 */
import { BridgeError } from './bridge.ts';

export interface OidcOptions {
  issuer: string;
  appId: string;
  redirectUri: string;
  scopes: string[];
  locale?: string;
}

export interface OidcCode {
  code: string;
  state: string;
  redirectUri: string;
  codeVerifier: string;
}

interface Pending {
  verifier: string;
  redirectUri: string;
  appId: string;
  silent: boolean;
  at: number;
}

const KEY = 'ichopen:oidc:';
const MAX_AGE = 10 * 60_000;
const INTERACTIVE = new Set([
  'login_required',
  'consent_required',
  'interaction_required',
  'account_selection_required',
]);

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function challenge(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Drops `code`, `state`, `error`… from the address bar (they are one-time). */
function cleanUrl(url: URL) {
  for (const k of ['code', 'state', 'error', 'error_description', 'iss', 'session_state']) url.searchParams.delete(k);
  try {
    history.replaceState(history.state, '', url.toString());
  } catch {
    // a sandboxed page
  }
}

/** The answer in the current address, if it is the end of one of our own requests. */
export function takeResult(): { ok: OidcCode } | { retry: Pending & { state: string } } | { error: string } | null {
  const url = new URL(window.location.href);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!state || (!code && !error)) return null;
  const s = store();
  const raw = s?.getItem(KEY + state);
  if (!raw) return null; // not ours (another sign-in of the app's own)
  s?.removeItem(KEY + state);
  cleanUrl(url);
  const p = JSON.parse(raw) as Pending;
  if (Date.now() - p.at > MAX_AGE) return { error: 'expired' };
  if (code) return { ok: { code, state, redirectUri: p.redirectUri, codeVerifier: p.verifier } };
  if (p.silent && error && INTERACTIVE.has(error)) return { retry: { ...p, state } };
  return { error: error ?? 'unknown' };
}

/** Sends the page to the issuer (the returned promise never settles: the page goes away). */
export async function redirect(o: OidcOptions, silent: boolean): Promise<never> {
  const s = store();
  if (!s) throw new BridgeError('unsupported', 'sessionStorage is not available');
  const state = random(16);
  const verifier = random(32);
  s.setItem(
    KEY + state,
    JSON.stringify({ verifier, redirectUri: o.redirectUri, appId: o.appId, silent, at: Date.now() } satisfies Pending),
  );
  const q = new URLSearchParams({
    client_id: o.appId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: ['openid', ...o.scopes.filter((x) => x !== 'openid')].join(' '),
    state,
    nonce: random(16),
    code_challenge: await challenge(verifier),
    code_challenge_method: 'S256',
    ...(silent ? { prompt: 'none' } : {}),
    ...(o.locale ? { ui_locales: o.locale } : {}),
  });
  window.location.assign(`${o.issuer.replace(/\/$/, '')}/auth?${q}`);
  return new Promise<never>(() => {});
}
