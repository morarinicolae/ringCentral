import { config } from './config';

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, event: string, data?: Record<string, unknown>): void {
  // Structured single-line JSON logs. In test mode we stay quiet unless it's a
  // warning/error, to keep test output readable.
  if (config.isTest && (level === 'debug' || level === 'info')) return;

  const line = {
    t: new Date().toISOString(),
    level,
    event,
    ...(data ?? {}),
  };
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

export const logger = {
  debug: (event: string, data?: Record<string, unknown>) => emit('debug', event, data),
  info: (event: string, data?: Record<string, unknown>) => emit('info', event, data),
  warn: (event: string, data?: Record<string, unknown>) => emit('warn', event, data),
  error: (event: string, data?: Record<string, unknown>) => emit('error', event, data),
};

// Canonical decision event names (rule 8: log every important decision).
export const Decision = {
  NEW_CLIENT_CREATED: 'new_client_created',
  SELLER_ASSIGNED: 'seller_assigned',
  EXISTING_SELLER_REUSED: 'existing_seller_reused',
  INBOUND_RECEIVED: 'inbound_message_received',
  TELEGRAM_NOTIFIED: 'telegram_notification_sent',
  OUTBOUND_ATTEMPTED: 'outbound_sms_attempted',
  OUTBOUND_SENT: 'outbound_sms_sent',
  OUTBOUND_FAILED: 'outbound_sms_failed',
  DUPLICATE_WEBHOOK: 'duplicate_webhook_ignored',
  OPT_OUT_DETECTED: 'opt_out_detected',
  UNAUTHORIZED_REPLY: 'unauthorized_reply_blocked',
} as const;
