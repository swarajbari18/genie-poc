//#region src/cookies/cookie-utils.d.ts
interface CookieAttributes {
  value: string;
  "max-age"?: number | undefined;
  expires?: Date | undefined;
  domain?: string | undefined;
  path?: string | undefined;
  secure?: boolean | undefined;
  httponly?: boolean | undefined;
  partitioned?: boolean | undefined;
  samesite?: ("strict" | "lax" | "none") | undefined;
  [key: string]: any;
}
interface ParsedCookieOptions {
  maxAge?: number | undefined;
  expires?: Date | undefined;
  domain?: string | undefined;
  path?: string | undefined;
  secure?: boolean | undefined;
  httpOnly?: boolean | undefined;
  partitioned?: boolean | undefined;
  sameSite?: CookieAttributes["samesite"];
}
declare const SECURE_COOKIE_PREFIX = "__Secure-";
declare const HOST_COOKIE_PREFIX = "__Host-";
/**
 * Remove __Secure- or __Host- prefix from cookie name.
 */
declare function stripSecureCookiePrefix(cookieName: string): string;
/**
 * Split a comma-joined `Set-Cookie` header string into individual cookies.
 */
declare function splitSetCookieHeader(setCookie: string): string[];
declare function parseSetCookieHeader(setCookie: string): Map<string, CookieAttributes>;
declare function toCookieOptions(attributes: CookieAttributes): ParsedCookieOptions;
/**
 * Add or replace a cookie in the request `Cookie` header.
 *
 * Cookie pairs are joined with `; `, but `headers.append("cookie", ...)`
 * joins with `, ` in some runtimes (e.g. Deno, Cloudflare Workers) and
 * breaks downstream cookie parsing. This builds the header value via
 * parse-mutate-serialize.
 */
declare function setRequestCookie(headers: Headers, name: string, value: string): void;
declare function setCookieToHeader(headers: Headers): (context: {
  response: Response;
}) => void;
//#endregion
export { CookieAttributes, HOST_COOKIE_PREFIX, SECURE_COOKIE_PREFIX, parseSetCookieHeader, setCookieToHeader, setRequestCookie, splitSetCookieHeader, stripSecureCookiePrefix, toCookieOptions };