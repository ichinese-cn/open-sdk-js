// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ichinese from '../src/index.ts';

type Msg = { v: number; id: string; method: string; params: Record<string, unknown> };

/** A fake container: answers like the desktop app's bridge. */
function installContainer(answer: (m: Msg) => { ok: boolean; result?: unknown; error?: { code: string } }) {
  const sent: Msg[] = [];
  window.ichOpenBridge = {
    postMessage(raw: string) {
      const m = JSON.parse(raw) as Msg;
      sent.push(m);
      setTimeout(() => window.__ichOpenBridgeReceive?.(JSON.stringify({ v: 1, id: m.id, ...answer(m) })), 0);
    },
  };
  return sent;
}

beforeEach(() => {
  ichinese._reset();
  delete window.ichOpenBridge;
  delete window.__ichOpenBridgeReceive;
  sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('in a container', () => {
  it('ready() asks the container for its environment', async () => {
    const sent = installContainer(() => ({
      ok: true,
      result: { container: 'desktop', container_version: '0.1.0', locale: 'zh-CN', theme: 'dark', app_id: 'cn.cli_x' },
    }));
    const env = await ichinese.ready();
    expect(env).toMatchObject({ container: 'desktop', locale: 'zh-CN', theme: 'dark', appId: 'cn.cli_x' });
    expect(sent[0]).toMatchObject({ v: 1, method: 'env' });
    expect(ichinese.inContainer()).toBe(true);
  });

  it('requestAuthCode() gets the code from the bridge, passing scopes asked again', async () => {
    const sent = installContainer((m) =>
      m.method === 'env'
        ? { ok: true, result: { container: 'android' } }
        : { ok: true, result: { code: 'cn.bc-123', expires_in: 300 } },
    );
    const r = await ichinese.requestAuthCode({ scopes: ['profile'] });
    expect(r).toEqual({ code: 'cn.bc-123', via: 'bridge', expiresIn: 300 });
    expect(sent[1]).toMatchObject({ method: 'requestAuthCode', params: { scopes: ['profile'] } });
  });

  it('a refusal comes back as a BridgeError with its code', async () => {
    installContainer((m) =>
      m.method === 'env'
        ? { ok: true, result: { container: 'ios' } }
        : { ok: false, error: { code: 'consent_denied' } },
    );
    await expect(ichinese.requestAuthCode()).rejects.toMatchObject({ name: 'BridgeError', code: 'consent_denied' });
  });

  it('container methods and events', async () => {
    const sent = installContainer((m) => ({
      ok: true,
      result: m.method === 'env' ? { container: 'desktop', theme: 'light' } : { shared: true },
    }));
    await ichinese.setTitle('Hello');
    await ichinese.openExternal('https://example.com/a');
    expect(await ichinese.shareToChat({ title: 'T', url: 'https://example.com/' })).toEqual({ shared: true });
    await ichinese.close();
    expect(sent.map((m) => m.method)).toEqual(['env', 'setTitle', 'openExternal', 'shareToChat', 'close']);
    window.__ichOpenBridgeReceive?.(JSON.stringify({ v: 1, event: 'themeChanged', data: { theme: 'dark' } }));
    expect(ichinese.env().theme).toBe('dark');
    await expect(ichinese.openExternal('javascript:alert(1)')).rejects.toMatchObject({ code: 'invalid_params' });
  });
});

describe('in a plain browser', () => {
  it('requestAuthCode() goes to the issuer silently with PKCE, then returns the code on the way back', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      href: 'https://app.example.com/home',
      origin: 'https://app.example.com',
      pathname: '/home',
      assign,
    } as Location);
    ichinese.config({ appId: 'cn.cli_a1b2c3d4e5f6a7b8', issuer: 'https://id.example.com', scopes: ['profile'] });
    void ichinese.requestAuthCode();
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    const to = new URL(assign.mock.calls[0]![0] as string);
    expect(to.origin + to.pathname).toBe('https://id.example.com/auth');
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      client_id: 'cn.cli_a1b2c3d4e5f6a7b8',
      redirect_uri: 'https://app.example.com/home',
      scope: 'openid profile',
      prompt: 'none',
      code_challenge_method: 'S256',
    });
    const state = to.searchParams.get('state')!;

    // The issuer answers consent_required: once more, interactively.
    ichinese._reset();
    ichinese.config({ appId: 'cn.cli_a1b2c3d4e5f6a7b8', issuer: 'https://id.example.com' });
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      href: `https://app.example.com/home?error=consent_required&state=${state}`,
      origin: 'https://app.example.com',
      pathname: '/home',
      assign,
    } as Location);
    void ichinese.requestAuthCode();
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(2));
    const again = new URL(assign.mock.calls[1]![0] as string);
    expect(again.searchParams.get('prompt')).toBeNull();
    const state2 = again.searchParams.get('state')!;

    // Back with a code.
    ichinese._reset();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      href: `https://app.example.com/home?code=cn.oc-9&state=${state2}`,
      origin: 'https://app.example.com',
      pathname: '/home',
      assign,
    } as Location);
    const r = await ichinese.requestAuthCode();
    expect(r).toMatchObject({
      code: 'cn.oc-9',
      via: 'oidc',
      redirectUri: 'https://app.example.com/home',
      state: state2,
    });
    expect(r.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('needs the App ID outside the containers', async () => {
    await expect(ichinese.requestAuthCode()).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('ignores a code whose state is not ours', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      href: 'https://app.example.com/cb?code=x&state=forged',
      origin: 'https://app.example.com',
      pathname: '/cb',
      assign,
    } as Location);
    ichinese.config({ appId: 'cn.cli_a1b2c3d4e5f6a7b8', issuer: 'https://id.example.com' });
    void ichinese.requestAuthCode();
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    expect(new URL(assign.mock.calls[0]![0] as string).searchParams.get('prompt')).toBe('none');
  });
});
