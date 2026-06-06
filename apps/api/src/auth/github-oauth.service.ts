import { Injectable, Logger } from '@nestjs/common';
import {
  GITHUB_ENDPOINTS,
  GITHUB_OAUTH_SCOPE_PARAM,
  type OAuthAppConfig,
} from './oauth-config';

/**
 * GitHub OAuth HTTP boundary (be-oauth-allowlist, tasks 2.2 / 2.3).
 *
 * Owns the three GitHub HTTP interactions and nothing else (no allowlist, no DB,
 * no cookies): building the authorize URL, exchanging the authorization `code`
 * for an access token using the confidential `client_secret`, and fetching the
 * authenticated GitHub user. Isolating the network here keeps the controller's
 * orchestration and the allowlist/session logic pure and testable.
 *
 * Security invariants enforced here:
 * - the code-for-token exchange happens SERVER-SIDE only; `client_secret` is sent
 *   to GitHub's token endpoint and NEVER returned toward the browser;
 * - the resulting access token is returned to the caller for SERVER-SIDE storage
 *   (associated to the user for later import calls) and is never logged or echoed
 *   to the client.
 */

/** The GitHub identity fetched from `/user` after a successful token exchange. */
export interface GitHubUser {
  /** Immutable numeric account id; the allowlist + user-record key. */
  readonly id: number;
  /** Mutable username (display only). */
  readonly login: string;
  /** Display name; GitHub may return null, normalised to login here. */
  readonly name: string;
  /** Avatar URL; normalised to empty string when absent. */
  readonly avatarUrl: string;
}

@Injectable()
export class GitHubOAuthService {
  private readonly logger = new Logger(GitHubOAuthService.name);

  /**
   * Builds GitHub's authorize URL carrying `client_id`, the requested scopes
   * (`read:user repo`), the registered `redirect_uri` (when configured), and the
   * anti-CSRF `state`. The browser is redirected here to begin the flow.
   */
  buildAuthorizeUrl(config: OAuthAppConfig, state: string): string {
    const url = new URL(GITHUB_ENDPOINTS.AUTHORIZE);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('scope', GITHUB_OAUTH_SCOPE_PARAM);
    url.searchParams.set('state', state);
    if (config.redirectUri) {
      url.searchParams.set('redirect_uri', config.redirectUri);
    }
    // `allow_signup=false` keeps the flow to existing accounts; harmless for the
    // allowlist gate which rejects any non-allowlisted id regardless.
    url.searchParams.set('allow_signup', 'false');
    return url.toString();
  }

  /**
   * Exchanges an authorization `code` for a GitHub access token, server-side,
   * using the confidential `client_secret`. Returns the raw access token (for
   * server-side storage only). Throws on any non-OK response or an error payload;
   * the error message never includes the token or secret.
   */
  async exchangeCodeForToken(config: OAuthAppConfig, code: string): Promise<string> {
    const body: Record<string, string> = {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
    };
    if (config.redirectUri) {
      body.redirect_uri = config.redirectUri;
    }

    const response = await fetch(GITHUB_ENDPOINTS.TOKEN, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      this.logger.warn(`GitHub token exchange failed: HTTP ${response.status}`);
      throw new Error('GitHub token exchange failed');
    }

    const payload = (await response.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (payload.error || typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
      // Log the GitHub error code (e.g. bad_verification_code) but never the token.
      this.logger.warn(`GitHub token exchange returned error: ${payload.error ?? 'no access_token'}`);
      throw new Error('GitHub token exchange returned no access token');
    }

    return payload.access_token;
  }

  /**
   * Fetches the authenticated GitHub user with the access token. Returns the
   * numeric `id`, `login`, display `name` (falling back to `login` when GitHub
   * returns null), and avatar URL (empty string when absent).
   */
  async fetchUser(accessToken: string): Promise<GitHubUser> {
    const response = await fetch(GITHUB_ENDPOINTS.USER, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'cap-orchestrator',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      this.logger.warn(`GitHub /user fetch failed: HTTP ${response.status}`);
      throw new Error('GitHub user fetch failed');
    }

    const user = (await response.json()) as {
      id?: number;
      login?: string;
      name?: string | null;
      avatar_url?: string | null;
    };

    if (typeof user.id !== 'number' || !Number.isInteger(user.id) || typeof user.login !== 'string') {
      throw new Error('GitHub user response missing a numeric id or login');
    }

    return {
      id: user.id,
      login: user.login,
      name: typeof user.name === 'string' && user.name.length > 0 ? user.name : user.login,
      avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : '',
    };
  }
}
