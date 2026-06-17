import { runAgent } from '../agent/index.js';

/**
 * One-time, capped backfill: on startup, welcome the most recent N un-welcomed
 * top-level posts in the welcome channel. Real-time handling covers everything
 * posted after Buddy is running. Idempotent — it skips any post Buddy already
 * replied to, so restarting won't double-welcome.
 *
 * Controlled by env:
 *   BUDDY_WELCOME_CHANNEL_ID  the channel to back-fill
 *   BUDDY_WELCOME_BACKFILL    how many recent top-level posts to consider (default 0 = off)
 *
 * @param {import('@slack/bolt').App} app
 * @returns {Promise<void>}
 */
export async function runWelcomeBacklog(app) {
  const channel = process.env.BUDDY_WELCOME_CHANNEL_ID;
  const count = Number.parseInt(process.env.BUDDY_WELCOME_BACKFILL || '0', 10);
  if (!channel || !Number.isFinite(count) || count < 1) return;

  try {
    const botUserId = (await app.client.auth.test()).user_id;

    // Newest-first history; keep human top-level posts only, take the most recent N.
    const res = await app.client.conversations.history({ channel, limit: 50 });
    const recent = (res.messages || [])
      .filter(
        (m) => !m.subtype && !m.bot_id && m.user !== botUserId && (!m.thread_ts || m.thread_ts === m.ts),
      )
      .slice(0, count)
      .reverse(); // welcome oldest-of-the-recent first

    let welcomed = 0;
    for (const m of recent) {
      // Skip anything Buddy already replied to (idempotent across restarts).
      const replies = await app.client.conversations.replies({ channel, ts: m.ts, limit: 50 });
      if ((replies.messages || []).some((r) => r.user === botUserId)) continue;

      const deps = { client: app.client, userId: m.user, channelId: channel, threadTs: m.ts, messageTs: m.ts };
      const { responseText } = await runAgent(m.text || '', undefined, deps);
      const reply = (responseText || '').trim();
      if (!reply || reply.replace(/[^a-zA-Z]/g, '').toUpperCase() === 'SKIP') continue;

      await app.client.chat.postMessage({ channel, text: reply, thread_ts: m.ts });
      welcomed += 1;
    }
    app.logger.info(`[welcome-backfill] checked ${recent.length} recent posts, welcomed ${welcomed}.`);
  } catch (e) {
    app.logger.error(`[welcome-backfill] failed: ${e}`);
  }
}
