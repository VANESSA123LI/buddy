import fs from 'node:fs';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import cron from 'node-cron';

const MODEL = 'claude-haiku-4-5';
const DATA_DIR = 'data';
const HISTORY_FILE = path.join(DATA_DIR, 'discussion-history.json');
const POST_EVERY_DAYS = 2; // "every other day"
const NO_REPEAT_DAYS = 60; // don't repeat a question seen in this window
const PRUNE_DAYS = 90; // keep a little history beyond the no-repeat window

const QUESTION_SYSTEM = `\
You generate ONE fun, casual discussion-starter question for a Slack #random channel. The goal is \
community engagement — questions that are easy and fun for anyone to answer and that spark opinions, \
stories, and light-hearted debate.

Rules:
- Keep it to 1-2 sentences, concise and conversational.
- Casual and friendly — the kind of thing you'd ask a group of coworkers hanging out.
- Invite opinions, hot takes, favorites, or hypotheticals. Light, playful debate is great.
- Rotate widely across these topics, picking a different vibe each time: sports, entertainment, \
gaming, food, travel, technology, nostalgia, pop culture, and hypothetical "would you rather" / \
"if you could" scenarios.
- AVOID anything political, religious, or otherwise controversial or sensitive. Keep it universally \
light and inclusive.
- Output ONLY the question text — no preamble, no quotes, no "Here's a question", no hashtags.

Examples of the style and length:
- Who do you think is winning the World Cup this year?
- What's the greatest video game of all time?
- If you could instantly master one skill, what would it be?
- What's a movie everyone loves that you just couldn't get into?
- What's the best snack ever invented?
- Which fictional world would you most want to live in?
- What's a piece of technology you can't imagine living without?
- What's your most rewatchable TV show?`;

const REPLY_SYSTEM = `\
You are Buddy, the warm, upbeat host of a Slack #random discussion thread. You posted a fun question \
and people are weighing in. When someone replies, respond in ONE short, friendly sentence: react to \
their specific take, then either ask a quick follow-up or nudge others to chime in. A little playful \
disagreement is welcome — keep it light and inclusive. Sound like a real person, use contractions, \
never corporate. Output only your reply — no preamble, no quotes, and never the word "SKIP".`;

/** @typedef {{ channel: string, ts: string, question: string, date: string }} Entry */

/** @type {Entry[]} */
let history = [];
/** @type {Set<string>} fast lookup of `${channel}:${ts}` for discussion threads */
const threadIndex = new Set();

function reindex() {
  threadIndex.clear();
  for (const h of history) threadIndex.add(`${h.channel}:${h.ts}`);
}

function loadHistory() {
  try {
    history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (!Array.isArray(history)) history = [];
  } catch {
    history = [];
  }
  reindex();
}

function saveHistory() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch {
    // best-effort persistence; a failed write just means we might re-ask sooner
  }
}

/** Today's date as YYYY-MM-DD in the given timezone. */
function todayStr(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

/** Whole days from date string a to date string b (both YYYY-MM-DD). */
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** One-shot generation through the Agent SDK with a dedicated system prompt. */
async function generate(systemPrompt, prompt) {
  let text = '';
  for await (const message of query({
    prompt,
    options: { systemPrompt, model: MODEL, permissionMode: 'bypassPermissions' },
  })) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') text += block.text;
      }
    }
  }
  return text.trim().replace(/^["']|["']$/g, '');
}

async function generateQuestion(recentQuestions) {
  const avoid = recentQuestions.length ? recentQuestions.map((q) => `- ${q}`).join('\n') : '(none yet)';
  const prompt =
    `Questions already asked in the last ${NO_REPEAT_DAYS} days — do NOT repeat or closely echo any of these:\n` +
    `${avoid}\n\nWrite ONE brand-new discussion question now. Output only the question.`;
  let q = await generate(QUESTION_SYSTEM, prompt);
  // Exact-duplicate guard: one retry if we somehow land on a recent question verbatim.
  const seen = new Set(recentQuestions.map((s) => s.toLowerCase()));
  if (seen.has(q.toLowerCase())) {
    q = await generate(QUESTION_SYSTEM, `${prompt}\n\n"${q}" was already used — pick a different topic.`);
  }
  return q;
}

async function maybePost(app, channel, tz) {
  const today = todayStr(tz);
  const last = history.length ? history[history.length - 1] : null;
  if (last && daysBetween(last.date, today) < POST_EVERY_DAYS) {
    return; // not time yet — keeps the every-other-day cadence across restarts/missed ticks
  }

  const recent = history.filter((h) => daysBetween(h.date, today) <= NO_REPEAT_DAYS).map((h) => h.question);
  const question = await generateQuestion(recent);
  if (!question) {
    app.logger.error('[discussion] empty question — nothing posted.');
    return;
  }

  const res = await app.client.chat.postMessage({ channel, text: question });
  history.push({ channel, ts: /** @type {string} */ (res.ts), question, date: today });
  history = history.filter((h) => daysBetween(h.date, today) <= PRUNE_DAYS);
  reindex();
  saveHistory();
  app.logger.info(`[discussion] posted question to ${channel}: ${question}`);
}

/**
 * Schedule the every-other-day discussion question.
 * Env: BUDDY_QUESTION_CHANNEL_ID (required), BUDDY_QUESTION_CRON (default 4pm daily),
 * BUDDY_TZ (default America/Los_Angeles). The cron runs daily; the 2-day cadence is
 * enforced from persisted history so restarts and missed ticks don't double-post.
 * @param {import('@slack/bolt').App} app
 */
export function startDiscussions(app) {
  const channel = process.env.BUDDY_QUESTION_CHANNEL_ID;
  const schedule = process.env.BUDDY_QUESTION_CRON || '0 16 * * *';
  const tz = process.env.BUDDY_TZ || 'America/Los_Angeles';

  if (!channel) {
    app.logger.info('[discussion] BUDDY_QUESTION_CHANNEL_ID not set — discussion questions disabled.');
    return;
  }
  if (!cron.validate(schedule)) {
    app.logger.error(`[discussion] invalid BUDDY_QUESTION_CRON "${schedule}" — disabled.`);
    return;
  }

  loadHistory();
  cron.schedule(
    schedule,
    () => maybePost(app, channel, tz).catch((e) => app.logger.error(`[discussion] post failed: ${e}`)),
    { timezone: tz },
  );
  app.logger.info(`[discussion] scheduled "${schedule}" (${tz}), every ${POST_EVERY_DAYS} days → ${channel}`);
}

/** Whether a thread root is one of Buddy's discussion questions. */
export function isDiscussionThread(channel, ts) {
  return threadIndex.has(`${channel}:${ts}`);
}

/**
 * Reply in-thread to someone weighing in on a discussion question.
 * @param {{ client: import('@slack/web-api').WebClient, event: any, logger: any }} args
 */
export async function handleDiscussionReply({ client, event, logger }) {
  try {
    const entry = history.find((h) => h.channel === event.channel && h.ts === event.thread_ts);
    const question = entry ? entry.question : '(the discussion question)';
    const reply = await generate(
      REPLY_SYSTEM,
      `The discussion question was: "${question}"\nSomeone just replied: "${event.text || ''}"\nWrite your one-sentence reply now.`,
    );
    if (reply) {
      await client.chat.postMessage({ channel: event.channel, thread_ts: event.thread_ts, text: reply });
    }
  } catch (e) {
    logger.error(`[discussion] reply failed: ${e}`);
  }
}
