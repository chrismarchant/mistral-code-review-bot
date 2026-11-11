import { createPrivateKey, createSign, generateKeyPairSync } from 'node:crypto';

/**
 * GitHub App authentication helpers.
 *
 * When GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY are provided, the CLI mints a
 * short-lived app JWT (RS256), finds the app's installation for the target
 * repo, and exchanges it for an installation access token. Reviews then run
 * under the App's Bot identity and the manifest records type=Bot, slug=….
 *
 * Note: GitHub no longer allows headless App *creation* via the REST API
 * (POST /user/apps removed; the manifest flow is browser-session scoped), so
 * the App must be registered once via github.com/settings/apps/new.
 */

export interface AppAuth {
  appId: string;
  privateKeyPem: string;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64url');

/** Mint a short-lived (<=10 min) app JWT. Exported for tests. */
export const mintAppJwt = (appId: string, pem: string, now = Date.now()): string => {
  const key = createPrivateKey(pem);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const iat = Math.floor(now / 1000) - 60; // clock skew allowance
  const exp = iat + 540; // 9 minutes
  const payload = b64url(JSON.stringify({ iat, exp, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(key).toString('base64url');
  return `${header}.${payload}.${signature}`;
};

const api = async (
  fetchImpl: FetchLike,
  jwt: string,
  path: string,
  method = 'GET',
  body?: unknown
) => {
  const res = await fetchImpl(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new Error(`GitHub App API ${method} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
};

/** Resolve the app installation id for a repo, then mint an installation token. */
export const getInstallationToken = async (
  auth: AppAuth,
  owner: string,
  repo: string,
  fetchImpl?: FetchLike
): Promise<{ token: string; installationId: number; appSlug: string }> => {
  const f = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const jwt = mintAppJwt(auth.appId, auth.privateKeyPem);

  const app = (await api(f, jwt, '/app')) as Record<string, any>;
  const installation = (await api(
    f,
    jwt,
    `/repos/${owner}/${repo}/installation`
  )) as Record<string, any>;

  const tokenRes = (await api(
    f,
    jwt,
    `/app/installations/${installation.id}/access_tokens`,
    'POST'
  )) as Record<string, any>;

  return {
    token: tokenRes.token,
    installationId: installation.id,
    appSlug: app.slug,
  };
};

/** Test helper: generate a throwaway RSA keypair (PEM) for signing tests. */
export const _testGenerateKeyPair = () =>
  generateKeyPairSync('rsa', { modulusLength: 2048 });
