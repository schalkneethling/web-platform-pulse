import type { DigestView } from "./digest.ts";

/** The slice of a subscriber a channel needs to address them. */
export interface Recipient {
  email: string;
  /** Keys the unsubscribe link every message must carry. */
  unsubscribeToken: string;
}

export type DeliveryResult =
  | { status: "sent" }
  | {
      status: "failed";
      /** The full reason, for the database. It may name the recipient. */
      error: string;
      /** The part of the reason that is safe to print to a shared log: no address. */
      diagnostic: string;
    };

/**
 * Delivery sits behind a channel interface (§10) so channels are additive
 * and a self-hoster supplies their own provider. The reader channel is the
 * persisted digest itself; email is the first push channel.
 */
export interface DeliveryChannel {
  readonly id: string;
  send(digest: DigestView, recipient: Recipient): Promise<DeliveryResult>;
}
