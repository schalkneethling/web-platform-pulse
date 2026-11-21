/**
 * Transport errors can echo a connection URL whose userinfo carries
 * credentials (the SMTP password is an API key); strip that before the
 * text reaches shared CI logs.
 */
export const scrubCredentials = (message: string): string =>
  message.replace(/\/\/[^/@\s]+@/g, "//***@");
