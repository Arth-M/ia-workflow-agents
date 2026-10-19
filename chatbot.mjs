// =============================================================================
// CAREER COUNSELOR — a CHATBOT
// =============================================================================
//
// What a chatbot is (vs. a workflow or an agent):
//   - The PERSON drives: they type a message, the model answers, they type
//     again... The loop runs as long as the person wants to talk.
//   - The model doesn't choose any action and has no tools: it answers, then
//     waits for the next message. (Workflow: the CODE decides the steps.
//     Agent: the MODEL decides the steps. Chatbot: the PERSON does.)
//   - The output is text for a human to read, not JSON for code to use.
//
// The API remembers nothing between calls, so each time we send the WHOLE
// conversation so far: that's how the model "remembers" what was said.
//
//   ┌─> PERSON types a message -> add it to the history -> MODEL answers (streamed) -> add it to the history ─┐
//   └──────────────────────────────────── repeat until the person types "exit" ──────────────────────────────┘
//
// Run it:  node --env-file=.env chatbot.mjs   (type "exit" to quit)
// =============================================================================

import readline from "node:readline/promises"; // built into Node: reads what the user types in the terminal
// The SDK client lives in config.mjs.
import { client } from "./config.mjs";

// --- Settings used only by this chatbot --------------------------------------
const CHAT_MODEL = `claude-sonnet-5-5`;
const EXIT_WORDS = [`exit`, `quit`, `bye`]; // typing one of these ends the chat

// The chatbot's role. Unlike the workflows, there's no fixed output format:
// it's a conversation, so it answers in plain text and asks questions when needed.
const SYSTEM_PROMPT = `You are a friendly career counselor chatting with someone in a terminal.
Help them find career paths that fit their likes and dislikes, and explain how to get there
(school, certifications, other requirements, rough timelines) when they're interested.
Ask questions to understand them better. Keep answers short and conversational:
a few sentences or a short list, no long reports. Plain text only, no markdown (it's a terminal).`;

async function main() {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });

  // The conversation history: every message from both sides, in order.
  // It's resent in full on every call, so it grows as the chat goes on
  // (and each call costs a bit more than the previous one).
  //
  // PROMPT CACHING keeps that cost down. Each call starts with exactly the
  // same text as the previous call (system prompt + earlier messages) plus the
  // new turn. The API can keep that already-sent part in a cache: re-reading
  // it from the cache costs about 10% of the normal price, and the model
  // starts answering a bit faster. Only the new turn is billed at full price.
  // Rules to keep it working:
  //   - never edit an earlier message or the system prompt (any change breaks the cache from that point on);
  //   - the cache expires after 5 minutes without a call (each call resets the timer);
  //   - nothing is cached below 512 tokens, so the first few short exchanges aren't cached yet.
  const messages = [];

  console.log(`Career counselor chatbot — tell me what you like and dislike. Type "exit" to quit.\n`);

  // ===========================================================================
  // THE CHAT LOOP — one turn = the person speaks, then the model answers.
  // ===========================================================================
  while (true) {
    const userMessage = (await terminal.question(`You: `)).trim();
    if (EXIT_WORDS.includes(userMessage.toLowerCase())) break; // the person decides when it ends
    if (!userMessage) continue; // empty line: ask again, no API call

    messages.push({ role: `user`, content: userMessage });

    // Stream the answer: print each piece of text as soon as it arrives,
    // so the person sees it being written (like in claude.ai) instead of waiting.
    process.stdout.write(`\nCounselor: `);
    let response;
    try {
      const stream = client.beta.messages.stream({
        model: CHAT_MODEL,
        max_tokens: 16000,
        // PROMPT CACHING (automatic): the API puts a cache marker at the end of
        // the conversation and moves it forward each turn, so every call re-reads
        // everything before it from the cache. No other code needed.
        cache_control: { type: `ephemeral` },
        system: SYSTEM_PROMPT,
        messages: messages,
        output_config: { effort: `low` }, // chat doesn't need deep thinking: low effort = faster answers
        // If the safety filter declines, the API retries on another model by itself.
        betas: [`server-side-fallback-2026-07-01`],
        fallbacks: `default`,
      });
      stream.on(`text`, (text) => process.stdout.write(text)); // print each piece as it arrives
      response = await stream.finalMessage(); // wait for the end of the answer
    } catch (error) {
      // An API error (bad key, rate limit, network...): say so, drop the
      // unanswered message from the history, and let the person try again.
      console.error(`\n[Error: ${error.message}]\n`);
      messages.pop();
      continue;
    }
    console.log(`\n`);

    if (response.stop_reason === `refusal`) console.log(`[The model declined to answer this message.]\n`);
    if (response.stop_reason === `max_tokens`) console.log(`[The answer was cut off: it was too long.]\n`);

    // Show the cache at work: how this call's input tokens were billed.
    //   read from cache   -> ~10% of the price (the conversation already sent)
    //   written to cache  -> ~125% of the price, once (what this turn added, saved for the next call)
    //   not cached        -> full price
    const usage = response.usage;
    console.log(`[input tokens: ${usage.cache_read_input_tokens ?? 0} read from cache, ` +
      `${usage.cache_creation_input_tokens ?? 0} written to cache, ${usage.input_tokens} not cached]\n`);

    // Save the model's answer in the history: the WHOLE content (including
    // its hidden thinking), not just the text, so the next call has it all.
    messages.push({ role: `assistant`, content: response.content });
  }

  terminal.close(); // stop listening to the keyboard, otherwise the script never exits
  console.log(`\nGoodbye! (${messages.length / 2} exchanges)`);
}

main();
