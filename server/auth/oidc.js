import { Issuer, generators } from 'openid-client';
import { config } from '../config.js';
import { redis } from '../redis/client.js';
import { keys } from '../redis/keys.js';
import { AppError } from '../utils/errors.js';

const OIDC_STATE_TTL_SECONDS = 600; // 10 minutes
let clientPromise = null;

export function getRedirectUri() {
  return `${config.publicUrl}${config.oidc.redirectPath}`;
}

async function getOidcClient() {
  if (!config.oidc.enabled) {
    throw new AppError(
      503,
      'OIDC_NOT_CONFIGURED',
      'OIDC login is not configured on this server (missing OIDC_CLIENT_ID).',
    );
  }
  if (!clientPromise) {
    clientPromise = Issuer.discover(config.oidc.issuer)
      .then((issuer) => {
        return new issuer.Client({
          client_id: config.oidc.clientId,
          client_secret: config.oidc.clientSecret || undefined,
          redirect_uris: [getRedirectUri()],
          response_types: ['code'],
          token_endpoint_auth_method: config.oidc.clientSecret ? 'client_secret_basic' : 'none',
        });
      })
      .catch((err) => {
        clientPromise = null;
        throw err;
      });
  }
  return clientPromise;
}

export function sanitizeReturnTo(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) {
    return '/';
  }
  return raw.slice(0, 256);
}

export async function beginOidcLogin(returnTo = '/') {
  const client = await getOidcClient();
  const state = generators.state();
  const nonce = generators.nonce();
  const codeVerifier = generators.codeVerifier();
  const codeChallenge = generators.codeChallenge(codeVerifier);

  const key = keys.oidcState(state);
  await redis
    .multi()
    .hset(key, {
      codeVerifier,
      nonce,
      returnTo: sanitizeReturnTo(returnTo),
      createdAt: String(Date.now()),
    })
    .expire(key, OIDC_STATE_TTL_SECONDS)
    .exec();

  const authUrl = client.authorizationUrl({
    scope: config.oidc.scopes,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return { authUrl, state };
}

export async function completeOidcLogin(req) {
  const client = await getOidcClient();
  const params = client.callbackParams(req);
  if (!params.state) {
    throw new AppError(400, 'INVALID_OIDC_STATE', 'Missing OIDC state parameter.');
  }

  // Single-use state consumption (atomic HGETALL + DEL)
  const stateKey = keys.oidcState(params.state);
  const res = await redis.multi().hgetall(stateKey).del(stateKey).exec();
  const stored = res?.[0]?.[1];

  if (!stored || !stored.codeVerifier || !stored.nonce) {
    throw new AppError(400, 'INVALID_OIDC_STATE', 'Login state expired or already used.');
  }

  const tokenSet = await client.callback(getRedirectUri(), params, {
    state: params.state,
    nonce: stored.nonce,
    code_verifier: stored.codeVerifier,
  });

  const claims = tokenSet.claims();
  if (!claims || !claims.sub) {
    throw new AppError(400, 'INVALID_ID_TOKEN', 'OIDC provider did not return a subject claim.');
  }

  const name =
    claims.name ||
    claims.preferred_username ||
    (claims.email ? claims.email.split('@')[0] : `User ${String(claims.sub).slice(0, 6)}`);

  return {
    user: {
      userId: String(claims.sub),
      name,
      email: claims.email || '',
      picture: claims.picture || '',
    },
    returnTo: sanitizeReturnTo(stored.returnTo),
  };
}

