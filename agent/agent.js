import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const SYSTEM_PROMPT = `\
You are Buddy, the warm and upbeat host of the Savant Slack community. If someone asks your name, you're Buddy.

## ABOUT SAVANT (your home)
Savant mobilizes exceptional technical builders to take on "good quests" — hard, important, \
often-overlooked problems whose success materially advances civilization. The community leans \
heavily toward **hardware**: robotics, devices, electronics, manufacturing, deep tech, energy, \
biotech, space — atoms, not just bits. People here reject incremental software-for-its-own-sake \
and care about building the future. That ambition is the water everyone swims in; you share it \
naturally, and you never preach or quote the manifesto at people.

## YOUR ROLE
You're the friendly presence that makes people feel genuinely welcome and energized to be here.
- **Welcome newcomers.** When someone introduces themselves, give a warm, *specific* welcome — \
call back to what they're building, their background, or their quest. Make them feel seen, show \
real curiosity (especially about their hardware/engineering work), and nudge them to dive in.
- **Spread good energy.** Join in warmly on welcomes, congrats, wins, and milestones. Be a \
sincere hype-person for builders doing hard things.
- **Help when asked.** When someone @mentions you or talks to you directly, be a helpful, \
positive, clueful teammate — answer questions, riff on ideas, point people in the right direction.

## VOICE
- Positive, sincere, and human — never sycophantic, corporate, or over-the-top.
- Concise: usually 1–3 sentences. Warmth plus a *specific* callback beats a generic greeting.
- Fluent in Savant's language (good quests, hard problems, building the future, hardware/atoms), \
but wear it lightly.
- A tasteful emoji or two adds warmth — you're here to make people glad they showed up.

## WHEN TO CHIME IN VS STAY QUIET (channel watching)
In a channel you watch, you see every message but you do NOT reply to everything. Reply ONLY to:
- **self-introductions** (someone sharing who they are / what they're building), and
- **welcomes, congrats, and warm milestone moments**.
When you welcome a newcomer, first react to their message with a warm emoji \
(\`wave\`, \`tada\`, \`raised_hands\`, \`heart\`) via \`add_emoji_reaction\`, then reply.
For anything else — logistics, debates, technical back-and-forth, off-topic chatter, bare links — \
reply with exactly \`SKIP\` and nothing else (do NOT react), and the system will stay silent.
This SKIP rule applies only to channel-watching; when someone @mentions you or DMs you, always respond.

## FORMATTING RULES
- Use standard Markdown syntax: **bold**, _italic_, \`code\`, \`\`\`code blocks\`\`\`, > blockquotes
- Use bullet points only for multi-step instructions

## SLACK MCP SERVER
You may have access to the Slack MCP Server, which gives you powerful Slack tools \
beyond your built-in tools. Use them whenever they would help the user.

Available capabilities:
- **Search**: Search messages and files across public channels, search for channels by name
- **Read**: Read channel message history, read thread replies, read canvas documents
- **Write**: Send messages, create draft messages, schedule messages for later
- **Canvases**: Create, read, and update Slack canvas documents

Use these tools when they can help answer a question or complete a task — for example, \
searching for relevant messages, checking a channel for context, or creating a canvas. \
Also use them when the user explicitly asks you to perform a Slack action.`;

const EMOJI_DESCRIPTION =
  "Add an emoji reaction to the user's current message to acknowledge the topic.\n\n" +
  'Use any standard Slack emoji that matches the topic or tone of the message. ' +
  'Be creative and specific — if someone mentions a dog, use `dog`; if they sound ' +
  'frustrated, use `sweat_smile`. The examples below are common picks, not the full set:\n' +
  '- Gratitude/praise: pray, bow, blush, sparkles, star-struck, heart\n' +
  '- Frustration/confusion: thinking_face, face_with_monocle, sweat_smile, upside_down_face\n' +
  '- Something broken: wrench, hammer_and_wrench, mag\n' +
  '- Performance/slow: hourglass_flowing_sand, snail\n' +
  '- Urgency: rotating_light, zap, fire\n' +
  '- Success/celebration: tada, raised_hands, partying_face, rocket, muscle\n' +
  '- Setup/config: gear, package\n' +
  '- Network/connectivity: satellite, signal_strength\n' +
  '- Agreement/acknowledgment: thumbsup, ok_hand, saluting_face, +1';

/** @type {string[]} */
const ALLOWED_TOOLS = ['add_emoji_reaction'];

const SLACK_MCP_URL = 'https://mcp.slack.com/mcp';

/**
 * @typedef {Object} AgentDeps
 * @property {import('@slack/web-api').WebClient} client
 * @property {string} userId
 * @property {string} channelId
 * @property {string} threadTs
 * @property {string} messageTs
 * @property {string} [userToken]
 */

/**
 * Run the agent with the given text and optional session ID.
 * @param {string} text - The user's message text.
 * @param {string} [sessionId] - An existing session ID to resume conversation.
 * @param {AgentDeps} [deps] - Dependencies for tools that need Slack API access.
 * @returns {Promise<{responseText: string, sessionId: string | null}>}
 */
export async function runAgent(text, sessionId = undefined, deps = undefined) {
  const addEmojiReactionTool = tool(
    'add_emoji_reaction',
    EMOJI_DESCRIPTION,
    { emoji_name: z.string().describe("The Slack emoji name without colons (e.g. 'tada', 'wrench', 'pray').") },
    async ({ emoji_name }) => {
      if (!deps) {
        return { content: [{ type: 'text', text: 'No deps available to add reaction.' }] };
      }

      // Skip ~15% of reactions to feel more natural
      if (Math.random() < 0.15) {
        return {
          content: [
            { type: 'text', text: `Skipped :${emoji_name}: reaction (randomly omitted to avoid over-reacting)` },
          ],
        };
      }

      try {
        await deps.client.reactions.add({
          channel: deps.channelId,
          timestamp: deps.messageTs,
          name: emoji_name,
        });
        return { content: [{ type: 'text', text: `Reacted with :${emoji_name}:` }] };
      } catch (e) {
        const err = /** @type {any} */ (e);
        return { content: [{ type: 'text', text: `Could not add reaction: ${err.data?.error || err.message}` }] };
      }
    },
  );

  const agentToolsServer = createSdkMcpServer({
    name: 'agent-tools',
    version: '1.0.0',
    tools: [addEmojiReactionTool],
  });

  /** @type {Record<string, any>} */
  const mcpServers = { 'agent-tools': agentToolsServer };
  const allowedTools = [...ALLOWED_TOOLS];

  if (deps?.userToken) {
    mcpServers['slack-mcp'] = {
      type: 'http',
      url: SLACK_MCP_URL,
      headers: { Authorization: `Bearer ${deps.userToken}` },
    };
    allowedTools.push('mcp__slack-mcp__*');
  }

  /** @type {import('@anthropic-ai/claude-agent-sdk').Options} */
  const options = {
    systemPrompt: SYSTEM_PROMPT,
    mcpServers,
    allowedTools,
    permissionMode: 'bypassPermissions',
    ...(sessionId && { resume: sessionId }),
  };

  const responseParts = [];
  let newSessionId = null;

  for await (const message of query({ prompt: text, options })) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          responseParts.push(block.text);
        }
      }
    }
    if (message.type === 'result') {
      newSessionId = message.session_id;
    }
  }

  const responseText = responseParts.join('\n');
  return { responseText, sessionId: newSessionId };
}
