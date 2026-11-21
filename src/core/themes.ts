/**
 * Theme order for presentation: platform work first, browsers and runtimes
 * after, commentary (Voices) closing the digest. It lives in a module of its
 * own because the taxonomy needs it and the digest (through the support
 * rollup) imports the web-features differ, which imports the taxonomy: kept
 * in `digest.ts`, the order would be read before it was defined.
 */
export const THEME_ORDER = ["css", "html", "javascript", "api", "browser", "runtime", "voices"];
