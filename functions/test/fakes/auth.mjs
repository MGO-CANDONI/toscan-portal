export const claims = new Map(), revoked = new Set();
export function getAuth() {
  return {
    async setCustomUserClaims(uid, c) { claims.set(uid, c); },
    async revokeRefreshTokens(uid) { revoked.add(uid); }
  };
}
