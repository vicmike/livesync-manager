import { randomBytes } from 'node:crypto';
import { safeEqual } from '../crypto/index.js';

const TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * Server-side confirmation tokens for destructive operations
 * (docs/API.md § Destructive operations). A token is bound to one
 * operation on one resource, expires in 5 minutes, and is single-use.
 * In-memory is correct: single-instance app, and a restart invalidating
 * pending confirmations is the safe direction.
 */
export class ConfirmTokenService {
  private readonly tokens = new Map<
    string,
    { operation: string; resourceId: string; expiresAt: number }
  >();

  issue(operation: string, resourceId: string): string {
    this.purge();
    const token = randomBytes(16).toString('base64url');
    this.tokens.set(token, { operation, resourceId, expiresAt: Date.now() + TOKEN_TTL_MS });
    return token;
  }

  /** Returns true and invalidates the token iff it matches operation + resource and is fresh. */
  consume(operation: string, resourceId: string, token: string): boolean {
    this.purge();
    for (const [stored, meta] of this.tokens) {
      if (safeEqual(stored, token)) {
        this.tokens.delete(stored);
        return meta.operation === operation && meta.resourceId === resourceId;
      }
    }
    return false;
  }

  private purge(): void {
    const now = Date.now();
    for (const [token, meta] of this.tokens) {
      if (meta.expiresAt <= now) {
        this.tokens.delete(token);
      }
    }
  }
}
