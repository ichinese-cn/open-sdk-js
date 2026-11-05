# iChinese Open Platform JS SDK

爱中文开放平台的网页 JS SDK：应用的网页在桌面端、手机 App 和普通浏览器里用同一套代码登录，并调用容器的方法。

The web JS SDK of the iChinese open platform: one set of code for an app's web pages, whether they run in the
desktop app, the mobile apps' web containers or a plain browser. Inside a container `requestAuthCode()` gets the
login code straight from the bridge, without a redirect; in a plain browser it falls back to OIDC.

## Install

```sh
npm install @ichinese/open-js-sdk
```

## Quick start

```ts
import * as ichinese from '@ichinese/open-js-sdk';

ichinese.config({ appId: 'cn.cli_…' });
const env = await ichinese.ready(); // { container: 'desktop' | 'ios' | 'android' | 'browser', … }

// Your backend exchanges the code with the server SDK's exchangeAuthCode.
const result = await ichinese.requestAuthCode();
await fetch('/api/login', { method: 'POST', body: JSON.stringify(result) });
```

In a plain browser `requestAuthCode()` signs in at the issuer (silently first). The page goes there and comes
back; calling `requestAuthCode()` again on the way back returns the code.

## Documentation

Guides and the API reference: <https://open.ichinese.cn>

This repository is generated from the platform's monorepo at each release, so a change made here would be
overwritten; please open an issue instead.

## License

MIT
