import { OAuth2Tokens } from "./oauth-provider.mjs";

//#region src/oauth2/utils.d.ts
declare function getOAuth2Tokens(data: Record<string, any>): OAuth2Tokens;
/**
 * Return the provider's primary Client ID: the single string, or the entry at
 * array index 0 for the cross-platform form used by ID token audience
 * verification. Index 0 is the designated primary and pairs with
 * `clientSecret` for the authorization code flow; later array entries are
 * only used as additional accepted audiences. Returns `undefined` when the
 * primary value is missing or an empty string.
 */
declare function getPrimaryClientId(clientId: unknown): string | undefined;
declare function generateCodeChallenge(codeVerifier: string): Promise<string>;
//#endregion
export { generateCodeChallenge, getOAuth2Tokens, getPrimaryClientId };