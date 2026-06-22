import { runAgent } from '../../agent/index.js';
import { handleDiscussionReply, isDiscussionThread } from '../../discussion/index.js';
import { sessionStore } from '../../thread-context/index.js';
import { buildFeedbackBlocks } from '../views/feedback-builder.js';

/**
 * @param {import('@slack/types').MessageEvent} event
 * @returns {event is import('@slack/types').GenericMessageEvent}
 */
function isGenericMessageEvent(event) {
  return !('subtype' in event && event.subtype !== undefined);
}

/**
 * Whether Buddy has already posted in this thread. Used as a restart-proof
 * fallback when the in-memory session record is gone, so follow-up replies in a
 * thread Buddy is part of still get answered (without jumping into other threads).
 * @param {import('@slack/web-api').WebClient} client
 * @param {string | undefined} botUserId
 * @param {string} channel
 * @param {string} threadTs
 * @returns {Promise<boolean>}
 */
async function botPostedInThread(client, botUserId, channel, threadTs) {
  if (!botUserId) return false;
  try {
    const res = await client.conversations.replies({ channel, ts: threadTs, limit: 200 });
    return (res.messages || []).some((m) => m.user === botUserId);
  } catch {
    return false;
  }
}

/**
 * Handle messages sent to the agent via DM or in threads the bot is part of.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'message'>} args
 * @returns {Promise<void>}
 */
export async function handleMessage({ client, context, event, logger, say, sayStream, setStatus }) {
  // Skip message subtypes (edits, deletes, etc.)
  if (!isGenericMessageEvent(event)) return;

  // Skip bot messages
  if (event.bot_id) return;

  const isDm = event.channel_type === 'im';
  const isThreadReply = !!event.thread_ts;
  const isWelcomeChannel =
    !!process.env.BUDDY_WELCOME_CHANNEL_ID && event.channel === process.env.BUDDY_WELCOME_CHANNEL_ID;
  // Comma-separated channel IDs where Buddy reacts to every message but never replies.
  const reactOnlyChannels = (process.env.BUDDY_REACT_CHANNEL_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const isReactOnlyChannel = reactOnlyChannels.includes(event.channel);

  // Channel-watching: in the welcome channel Buddy reacts + greets newcomers; in
  // react-only channels (e.g. #random) it reacts to every message and never posts
  // text. The emoji reaction happens inside runAgent via the add_emoji_reaction tool.
  if ((isWelcomeChannel || isReactOnlyChannel) && !isDm && !isThreadReply) {
    // Only handle FRESH posts in real time — never react to old or re-delivered
    // events. Anything older than 10 minutes is left to the one-time backfill.
    const ageSec = Date.now() / 1000 - Number(event.ts);
    if (Number.isFinite(ageSec) && ageSec > 600) return;
    try {
      const deps = {
        client,
        userId: /** @type {string} */ (context.userId),
        channelId: event.channel,
        threadTs: event.ts,
        messageTs: event.ts,
        userToken: context.userToken,
      };
      const { responseText } = await runAgent(event.text || '', undefined, deps);
      // React-only channels: the reaction already happened; never post text.
      if (isReactOnlyChannel && !isWelcomeChannel) return;
      const reply = (responseText || '').trim();
      if (!reply || reply.replace(/[^a-zA-Z]/g, '').toUpperCase() === 'SKIP') return;
      await say({ text: reply, thread_ts: event.ts });
    } catch (e) {
      logger.error(`Failed to handle channel-watch message: ${e}`);
    }
    return;
  }

  // Discussion threads: when someone weighs in on one of Buddy's posted questions,
  // Buddy replies in-thread to keep the conversation going.
  if (isThreadReply && isDiscussionThread(event.channel, /** @type {string} */ (event.thread_ts))) {
    await handleDiscussionReply({ client, event, logger });
    return;
  }

  if (isDm) {
    // DMs are always handled
  } else if (isThreadReply) {
    // Channel thread replies are handled when Buddy is part of the thread.
    // Fast path: an in-memory session. Restart-proof fallback: check whether
    // Buddy actually posted in this thread before answering.
    const tts = /** @type {string} */ (event.thread_ts);
    const hasSession = sessionStore.getSession(event.channel, tts) !== null;
    if (!hasSession && !(await botPostedInThread(client, context.botUserId, event.channel, tts))) {
      return;
    }
  } else {
    // Top-level channel messages are handled by app_mentioned
    return;
  }

  try {
    const channelId = event.channel;
    const text = event.text || '';
    const threadTs = event.thread_ts || event.ts;
    const userId = /** @type {string} */ (context.userId);

    // Get session ID for conversation context
    const existingSessionId = sessionStore.getSession(channelId, threadTs);

    // Set assistant thread status with loading messages
    await setStatus({
      status: 'Thinking\u2026',
      loading_messages: [
        'Teaching the hamsters to type faster\u2026',
        'Untangling the internet cables\u2026',
        'Consulting the office goldfish\u2026',
        'Polishing up the response just for you\u2026',
        'Convincing the AI to stop overthinking\u2026',
      ],
    });

    // Run the agent with deps for tool access
    const deps = { client, userId, channelId, threadTs, messageTs: event.ts, userToken: context.userToken };
    const { responseText, sessionId: newSessionId } = await runAgent(text, existingSessionId ?? undefined, deps);

    // Stream response in thread with feedback buttons
    const streamer = sayStream();
    await streamer.append({ markdown_text: responseText });
    const feedbackBlocks = buildFeedbackBlocks();
    await streamer.stop({ blocks: feedbackBlocks });

    // Store session ID for future context
    if (newSessionId) {
      sessionStore.setSession(channelId, threadTs, newSessionId);
    }
  } catch (e) {
    logger.error(`Failed to handle message: ${e}`);
    await say({
      text: `:warning: Something went wrong! (${e})`,
      thread_ts: event.thread_ts || event.ts,
    });
  }
}
