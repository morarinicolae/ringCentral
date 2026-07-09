// Opt-out keywords. If an inbound message contains any of these as a
// standalone word (case-insensitive), the contact is marked opt_out and all
// outbound SMS to them is blocked.
export const OPT_OUT_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];

// Contact statuses that must never receive an outbound SMS.
export const NON_SENDABLE_CONTACT_STATUSES = ['opt_out', 'blocked', 'closed'] as const;

// Reply the bot sends when a seller sends a free-text message with no
// reply-to context, so we cannot tell which client it is for.
export const MSG_NO_CONTEXT =
  'Please reply to a specific client message so I know where to send your SMS.';

export const MSG_OPTED_OUT = 'This client opted out. SMS cannot be sent.';

export const MSG_NOT_YOUR_CONVERSATION =
  'This conversation is not assigned to you, so I cannot send your reply.';

export const MSG_UNKNOWN_CONTEXT =
  "I couldn't match that to one of your client conversations. Please reply directly to a client message notification.";

export const MSG_NOT_REGISTERED =
  'You are not registered as a seller in this tool. Ask an admin to add your Telegram ID.';
