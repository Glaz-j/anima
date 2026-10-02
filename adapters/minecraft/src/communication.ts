export const BROADCAST_TAG = '[世界]';
export const BROADCAST_PREFIX = `${BROADCAST_TAG} `;
export const BROADCAST_MAX_LENGTH = 240;
export const NPC_COMMUNICATION = Object.freeze({ mode: 'local', radius: 16, distance: 'euclidean-3d',
  sentDoesNotConfirmHearing: true,
  broadcast: Object.freeze({ available: true, scope: 'server', action: 'broadcast' }),
});

export function hasBroadcastTag(message: string) { return message.trimStart().startsWith(BROADCAST_TAG); }

export function ordinaryChatText(message: unknown, max: number): message is string {
  return typeof message === 'string' && Boolean(message.trim()) && message.length <= max
    && !/^\s*\//u.test(message) && !/[\u0000-\u001f\u007f-\u009f\u00a7\u2028\u2029]/u.test(message);
}

/** Only native chat events enter this parser. Malformed/empty/overlong channel
 * messages are rejected whole, never truncated into a different valid message. */
export function parseChatChannel(message: unknown): { channel: 'local' | 'broadcast'; message: string } | undefined {
  if (typeof message !== 'string') return;
  if (hasBroadcastTag(message)) {
    if (!message.startsWith(BROADCAST_PREFIX)) return;
    const body = message.slice(BROADCAST_PREFIX.length);
    if (!ordinaryChatText(body, BROADCAST_MAX_LENGTH) || hasBroadcastTag(body)) return;
    return { channel: 'broadcast', message: body };
  }
  if (ordinaryChatText(message, 500)) return { channel: 'local', message };
}
