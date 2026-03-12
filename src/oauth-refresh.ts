/**
 * Reads Claude Code's OAuth credentials from ~/.claude/.credentials.json
 * and refreshes the access token when expired.
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import os from 'os';
import { logger } from './logger.js';

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const TOKEN_ENDPOINT = 'https://api.anthropic.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Buffer before expiry to trigger a refresh (5 minutes). */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

interface OAuthCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

/**
 * Get a valid OAuth access token, refreshing if needed.
 * Returns null if credentials file doesn't exist or refresh fails.
 */
export async function getOAuthToken(): Promise<string | null> {
  let creds: OAuthCredentials;
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    creds = JSON.parse(raw);
  } catch {
    logger.debug('No Claude OAuth credentials found at %s', CREDENTIALS_PATH);
    return null;
  }

  const oauth = creds.claudeAiOauth;
  if (!oauth?.accessToken) {
    logger.debug('Credentials file missing accessToken');
    return null;
  }

  // Return current token if still valid
  if (oauth.expiresAt && Date.now() < oauth.expiresAt - EXPIRY_BUFFER_MS) {
    return oauth.accessToken;
  }

  // Token expired or about to expire — refresh it
  logger.info('OAuth access token expired, refreshing...');

  if (!oauth.refreshToken) {
    logger.error('No refresh token available, cannot refresh');
    return null;
  }

  try {
    const newTokens = await refreshToken(oauth.refreshToken);

    // Update credentials file with new tokens
    creds.claudeAiOauth.accessToken = newTokens.accessToken;
    creds.claudeAiOauth.refreshToken = newTokens.refreshToken;
    creds.claudeAiOauth.expiresAt = Date.now() + newTokens.expiresIn * 1000;

    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds), { mode: 0o600 });
    logger.info('OAuth token refreshed, expires in %ds', newTokens.expiresIn);

    return newTokens.accessToken;
  } catch (err) {
    logger.error({ err }, 'Failed to refresh OAuth token');
    return null;
  }
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function refreshToken(refresh: string): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: CLIENT_ID,
    });

    const url = new URL(TOKEN_ENDPOINT);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) {
            reject(new Error(`Token refresh failed (${res.statusCode}): ${data}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            resolve({
              accessToken: parsed.access_token,
              refreshToken: parsed.refresh_token,
              expiresIn: parsed.expires_in,
            });
          } catch (err) {
            reject(new Error(`Failed to parse token response: ${data}`));
          }
        });
      },
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
