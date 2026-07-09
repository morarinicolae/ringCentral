// Shared string-union types. These mirror the plain-string columns in the
// Prisma schema (no DB enums, so the schema stays portable between SQLite and
// PostgreSQL). Validate at the boundary; store as strings.

export type ContactStatus = 'active' | 'closed' | 'blocked' | 'opt_out';
export const CONTACT_STATUSES: ContactStatus[] = ['active', 'closed', 'blocked', 'opt_out'];

export type ConversationStatus = 'open' | 'closed' | 'blocked';
export const CONVERSATION_STATUSES: ConversationStatus[] = ['open', 'closed', 'blocked'];

export type MessageDirection = 'inbound' | 'outbound';

export type MessageStatus =
  | 'received'
  | 'forwarded_to_seller'
  | 'pending_send'
  | 'sent'
  | 'test_sent'
  | 'failed'
  | 'duplicate'
  | 'blocked';

export type WebhookProvider = 'ringcentral' | 'telegram';
export type WebhookStatus = 'received' | 'processed' | 'duplicate' | 'failed';

export type ActorType = 'system' | 'seller' | 'admin';

/** Normalized inbound SMS, produced from either a real RC webhook or the simulate endpoint. */
export interface InboundSms {
  from: string;
  to: string;
  text: string;
  /** RingCentral's own message id, when the payload carries it. */
  ringcentralMessageId?: string;
  /** ISO timestamp, used for hashing when no RC id is present. */
  timestamp?: string;
}

/** Result of an SMS send attempt through the RingCentral service. */
export interface SendSmsResult {
  ok: boolean;
  /** Final message status to persist. */
  status: MessageStatus;
  ringcentralMessageId?: string;
  failureReason?: string;
  /** true when the send was skipped because TEST_MODE is on. */
  testMode?: boolean;
  /** Raw provider response or error, JSON-stringifiable. */
  raw?: unknown;
}
