/**
 * The open platform's web JS SDK (M4.85): one set of code for an app's web pages, whether they run in
 * the desktop app, the mobile apps (their web containers) or a plain browser.
 *
 *   <script src="https://<our static origin>/open-js-sdk/1/ichinese-open.js"></script>   (global `ichinese`)
 *   import * as ichinese from '@ichinese/open-js-sdk';
 *
 *   ichinese.config({ appId: 'cn.cli_…' });
 *   const env = await ichinese.ready();          // { container: 'desktop' | 'ios' | 'android' | 'browser', … }
 *   const r = await ichinese.requestAuthCode();  // in a container: straight from the bridge
 *   await fetch('/api/login', { method: 'POST', body: JSON.stringify(r) });   // your backend: exchangeAuthCode
 *
 * In a plain browser `requestAuthCode()` signs in at the issuer instead (silently first, `prompt=none`);
 * the page goes there and comes back, and calling `requestAuthCode()` again on the way back returns the
 * code (with the `redirectUri` and `codeVerifier` your backend passes to `exchangeAuthCode`).
 */
import { BridgeError, host, Transport } from './bridge.ts';
import { DEFAULT_ISSUER, VERSION } from './gen/meta.ts';
import { redirect, takeResult } from './oidc.ts';

export { BridgeError } from './bridge.ts';
export { BRIDGE_PROTOCOL, DEFAULT_ISSUER, SCRIPT_URL, VERSION } from './gen/meta.ts';

export type Container = 'desktop' | 'ios' | 'android' | 'browser';

export interface Env {
  container: Container;
  /** The desktop or mobile app's version (null in a browser). */
  containerVersion: string | null;
  /** The interface language (BCP 47). */
  locale: string;
  theme: 'light' | 'dark';
  /** The app the container opened (null in a browser: from `config`). */
  appId: string | null;
  /** This SDK's version. */
  sdkVersion: string;
}

export interface Config {
  /** Your App ID (`<region>.cli_…`): needed in a plain browser (the container knows which app it opened). */
  appId?: string;
  /** The issuer of the browser fallback (default: the release's, `https://id.ichinese.cn`). */
  issuer?: string;
  /** Where the issuer sends the browser back (registered in the developer console; default: this page). */
  redirectUri?: string;
  /** Scopes to ask for in the browser fallback besides `openid` (in a container: all the app declares). */
  scopes?: string[];
}

export interface AuthCode {
  /** One-time, 5 minutes, bound to your app (and in a container, to this page's origin). */
  code: string;
  /** `bridge`: from the container; `oidc`: from the issuer (plain browser). */
  via: 'bridge' | 'oidc';
  /** For `exchangeAuthCode` (oidc only). */
  redirectUri?: string;
  /** For `exchangeAuthCode` (oidc only). */
  codeVerifier?: string;
  /** The OAuth state that came back (oidc only; already checked against the one sent). */
  state?: string;
  /** Seconds the code stays valid (bridge only). */
  expiresIn?: number;
}

export interface ShareCard {
  title: string;
  description?: string;
  /** A page of your app (on one of its trusted origins). */
  url: string;
  imageUrl?: string;
}

let cfg: Config = {};
let transport: Transport | undefined;
let current: Env | undefined;
let readyPromise: Promise<Env> | undefined;

/** Sets the app and the browser fallback's options (call before `requestAuthCode` in a browser). */
export function config(c: Config): void {
  cfg = { ...cfg, ...c };
}

function browserEnv(): Env {
  const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  return {
    container: 'browser',
    containerVersion: null,
    locale: (typeof navigator !== 'undefined' && navigator.language) || 'en',
    theme: dark ? 'dark' : 'light',
    appId: cfg.appId ?? null,
    sdkVersion: VERSION,
  };
}

/** Waits for the page and the container (if any); what `env()` returns afterwards. */
export function ready(): Promise<Env> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    if (typeof document !== 'undefined' && document.readyState === 'loading') {
      await new Promise<void>((r) => document.addEventListener('DOMContentLoaded', () => r(), { once: true }));
    }
    // A mobile container may add its channel a moment after the page starts.
    let b = host();
    for (let i = 0; !b && i < 5 && looksLikeContainer(); i++) {
      await new Promise((r) => setTimeout(r, 60));
      b = host();
    }
    if (!b) {
      current = browserEnv();
      return current;
    }
    transport = new Transport(b);
    const e = await transport.call<{
      container: Container;
      container_version?: string;
      locale?: string;
      theme?: 'light' | 'dark';
      app_id?: string;
    }>('env', {}, 5000);
    current = {
      container: e.container,
      containerVersion: e.container_version ?? null,
      locale: e.locale ?? browserEnv().locale,
      theme: e.theme ?? 'light',
      appId: e.app_id ?? cfg.appId ?? null,
      sdkVersion: VERSION,
    };
    transport.on('themeChanged', (d) => {
      if (current && d && typeof d === 'object') current.theme = (d as { theme: Env['theme'] }).theme;
    });
    transport.on('localeChanged', (d) => {
      if (current && d && typeof d === 'object') current.locale = (d as { locale: string }).locale;
    });
    return current;
  })();
  return readyPromise;
}

/** The containers mark their web views' user agent (`IchineseApp/<version>`). */
function looksLikeContainer() {
  return typeof navigator !== 'undefined' && /\bIchineseApp\//.test(navigator.userAgent);
}

/** Where the page runs (call after `ready()`; before it, a browser's guess). */
export function env(): Env {
  return current ?? browserEnv();
}

/** Whether the page is inside the desktop app or a mobile app. */
export const inContainer = () => env().container !== 'browser';

/**
 * 免登: an authorization code for the signed-in user, for your backend to exchange (`exchangeAuthCode`
 * of the server SDKs). In a container, the user is asked scope by scope first when the app is not added
 * yet or wants something new; `scopes` asks again for ones refused before (unless 「不再询问」).
 * Rejects with a `BridgeError` (`consent_denied`, `origin_not_trusted`, `app_disabled`, …).
 */
export async function requestAuthCode(opts: { scopes?: string[] } = {}): Promise<AuthCode> {
  const e = await ready();
  if (e.container !== 'browser' && transport) {
    const r = await transport.call<{ code: string; expires_in: number }>(
      'requestAuthCode',
      opts.scopes?.length ? { scopes: opts.scopes } : {},
      // The user may take a while in the consent window.
      null,
    );
    return { code: r.code, via: 'bridge', expiresIn: r.expires_in };
  }
  const back = takeResult();
  if (back && 'ok' in back) return { ...back.ok, via: 'oidc' };
  const appId = cfg.appId;
  if (!appId) throw new BridgeError('invalid_params', 'config({ appId }) first: needed outside the containers');
  const o = {
    issuer: cfg.issuer ?? DEFAULT_ISSUER,
    appId,
    redirectUri: cfg.redirectUri ?? `${location.origin}${location.pathname}`,
    scopes: opts.scopes ?? cfg.scopes ?? [],
    locale: e.locale,
  };
  if (back && 'retry' in back) return redirect(o, false);
  if (back && 'error' in back) {
    throw new BridgeError(
      back.error === 'access_denied' ? 'consent_denied' : back.error,
      `the issuer answered ${back.error}`,
    );
  }
  return redirect(o, true);
}

/** The window's title (in a browser: the document's). */
export async function setTitle(title: string): Promise<void> {
  const e = await ready();
  const t = String(title).slice(0, 100);
  if (e.container === 'browser' || !transport) {
    document.title = t;
    return;
  }
  await transport.call('setTitle', { title: t });
}

/** Closes the app's window (or its page in the mobile container). */
export async function close(): Promise<void> {
  const e = await ready();
  if (e.container === 'browser' || !transport) {
    window.close();
    return;
  }
  await transport.call('close');
}

/** Opens a link in the system browser (http and https only). */
export async function openExternal(url: string): Promise<void> {
  const u = new URL(url, location.href);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new BridgeError('invalid_params', 'http(s) links only');
  const e = await ready();
  if (e.container === 'browser' || !transport) {
    window.open(u.toString(), '_blank', 'noopener,noreferrer');
    return;
  }
  await transport.call('openExternal', { url: u.toString() });
}

/**
 * 分享到会话: the container's own conversation picker; the chosen conversations get a card of your app.
 * `shared: false` when the user closed the picker. In a browser: the system share sheet when there is
 * one, else `BridgeError('unsupported_method')`.
 */
export async function shareToChat(card: ShareCard): Promise<{ shared: boolean }> {
  const e = await ready();
  if (e.container === 'browser' || !transport) {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: card.title, text: card.description, url: card.url });
        return { shared: true };
      } catch {
        return { shared: false };
      }
    }
    throw new BridgeError('unsupported_method', 'sharing to a conversation needs the desktop or mobile app');
  }
  return transport.call<{ shared: boolean }>(
    'shareToChat',
    { title: card.title, description: card.description, url: card.url, image_url: card.imageUrl },
    null,
  );
}

/** Container events: `themeChanged` ({ theme }), `localeChanged` ({ locale }). Returns an unsubscribe. */
export function on(event: 'themeChanged' | 'localeChanged', listener: (data: unknown) => void): () => void {
  if (!transport) return () => {};
  return transport.on(event, listener);
}

/** Tests: forget what `ready()` found. */
export function _reset() {
  cfg = {};
  transport = undefined;
  current = undefined;
  readyPromise = undefined;
}
