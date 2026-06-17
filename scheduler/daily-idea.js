import cron from 'node-cron';

import { runAgent } from '../agent/index.js';

const DAILY_PROMPT =
  'Post your daily startup idea. Pitch exactly ONE fresh, funny startup idea in your usual ' +
  'format (name, one-line pitch, the joke), then a short conversation-starting hook. ' +
  'No preamble like "here\'s your idea" — just the idea.';

/**
 * Schedule a once-a-day startup-idea drop into a Slack channel.
 *
 * Controlled by env vars (all read at startup):
 *   BUDDY_CHANNEL_ID  required to enable — the channel to post into (e.g. C0123ABCD)
 *   BUDDY_DAILY_CRON  optional cron expression, default '0 9 * * *' (9:00am daily)
 *   BUDDY_TZ          optional IANA timezone, default 'America/Los_Angeles'
 *
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function startDailyIdea(app) {
  const channel = process.env.BUDDY_CHANNEL_ID;
  const schedule = process.env.BUDDY_DAILY_CRON || '0 9 * * *';
  const timezone = process.env.BUDDY_TZ || 'America/Los_Angeles';

  if (!channel) {
    app.logger.info('[daily-idea] BUDDY_CHANNEL_ID not set — daily idea disabled.');
    return;
  }
  if (!cron.validate(schedule)) {
    app.logger.error(`[daily-idea] Invalid BUDDY_DAILY_CRON "${schedule}" — daily idea disabled.`);
    return;
  }

  cron.schedule(
    schedule,
    async () => {
      try {
        app.logger.info('[daily-idea] generating daily startup idea…');
        const { responseText } = await runAgent(DAILY_PROMPT);
        if (!responseText?.trim()) {
          app.logger.error('[daily-idea] empty response — nothing posted.');
          return;
        }
        await app.client.chat.postMessage({
          channel,
          text: '💡 Buddy’s startup idea of the day',
          blocks: [{ type: 'markdown', text: responseText }],
        });
        app.logger.info(`[daily-idea] posted to ${channel}.`);
      } catch (e) {
        app.logger.error(`[daily-idea] failed: ${e}`);
      }
    },
    { timezone },
  );

  app.logger.info(`[daily-idea] scheduled "${schedule}" (${timezone}) → channel ${channel}`);
}
