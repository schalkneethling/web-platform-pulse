/**
 * The links an email carries back to the reader. Building them in one place
 * keeps the path and the `token` query name in step with the pages that read
 * them (src/reader/app.tsx).
 */
const tokenUrl = (path: string, publicUrl: string, token: string): string => {
  const url = new URL(path, publicUrl);
  url.searchParams.set("token", token);
  return url.toString();
};

export const confirmUrl = (publicUrl: string, token: string): string =>
  tokenUrl("/confirm", publicUrl, token);

export const unsubscribeUrl = (publicUrl: string, token: string): string =>
  tokenUrl("/unsubscribe", publicUrl, token);
