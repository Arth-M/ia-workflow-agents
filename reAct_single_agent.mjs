// =============================================================================
// CAREER PATHS — a SINGLE ReAct AGENT
// =============================================================================
// OTHER AGENTS COULD BE plan-and-execute agents , reflexion and refine,
//  =========================================================================
// Same job as workflow_prompt_chaining.mjs (likes/dislikes -> ~10 careers ->
// how to get to each one), but done by ONE agent instead of a fixed workflow.
//
// Workflow vs agent:
//   - In the workflows, OUR CODE decides the steps: call 1, gate, call 2, done.
//   - Here, THE MODEL decides the steps. Our code only runs a loop: it gives
//     the model a goal and some tools, runs whatever tool the model asks for,
//     sends back the result, and repeats until the model hands in its answer.
//
// What "ReAct" (Reason + Act) means: the agent loops through
//     THOUGHT     -> it reasons about what it knows and what it still needs
//     ACTION      -> it calls a tool
//     OBSERVATION -> it reads the tool's result
//   ...and again, until it has enough to give its final answer.
//
// It is a SINGLE agent: one model, one conversation, one loop. It never hands
// work to another agent.
//
// Its tools:
//   - web_search          : searches the web (degrees, certifications, durations...). Runs on Anthropic's servers.
//   - ask_user            : asks the person a question in the terminal (e.g. their country). Runs here.
//   - submit_career_plan  : hands in the final answer. Our code checks it; if it's wrong, the agent must fix it.
//
//   [likes/dislikes] -> INPUT GATE -> ┌─> THOUGHT -> ACTION (tool) -> OBSERVATION ─┐ -> submit_career_plan -> CHECK -> [print]
//                                     └──────────────── repeat ────────────────────┘   (stop after MAX_STEPS)
//
// Run it:  node --env-file=.env single_agent.mjs   (then answer the questions in the terminal)
// =============================================================================

import readline from "node:readline/promises"; // built into Node: reads what the user types in the terminal
import Anthropic from "@anthropic-ai/sdk"; // only to recognize the SDK's error types
// The SDK client and the shared career limits live in config.mjs.
import { client, MIN_CAREERS, MAX_CAREERS } from "./config.mjs";

// --- Settings used only by this agent ----------------------------------------
const AGENT_MODEL = `claude-sonnet-5-5`;
const MAX_STEPS = 10; // max model calls in the loop: an agent decides when it's done, so we cap it (time and cost)
const MAX_WEB_SEARCHES = 5; // cap on web searches for the whole run ($10 per 1,000 searches, plus the tokens they add)

// --- The agent's goal and rules (its system prompt) --------------------------
// We give a goal and tools, not a list of steps: deciding the steps is the agent's job.
const SYSTEM_PROMPT = `You are a career counselor agent. Your goal: based on a person's likes and dislikes,
find 10 different career paths that fit them (best fit first), and for each one explain concretely how to get there:
whether school is required (and which degree), certifications, other requirements (portfolio, apprenticeship, license...),
and ordered steps with a rough timeline.

Work step by step: think about what you know and what you're missing, use a tool, look at the result, and repeat.
- Use web_search to check requirements and durations you're not sure about. Searches are limited, so use them where they matter most.
- Use ask_user only if a missing detail would really change your answer (for example their country, since degrees
  and licenses differ by country). Ask at most 2 questions.
- When you're done, call submit_career_plan with your full answer. If it comes back with an error, fix it and submit again.`;

// --- The tools the agent can use ---------------------------------------------
const TOOLS = [
  // SERVER tool: Anthropic runs the search and puts the results in the response.
  // No code on our side; we just print what happened.
  {
    type: `web_search_20260209`,
    name: `web_search`,
    max_uses: MAX_WEB_SEARCHES,
  },

  // CLIENT tools: the model asks for them, OUR code runs them (see the loop).
  // `eager_input_streaming`: the tool's input streams as it's written instead of
  // arriving all at once. In exchange the API doesn't check it, so our code does.
  {
    name: `ask_user`,
    description: `Ask the person a question in the terminal and get their answer. Use only when the answer would really change your recommendations.`,
    eager_input_streaming: true,
    input_schema: {
      type: `object`,
      properties: {
        question: {
          type: `string`,
          description: `The question to ask, short and clear.`,
        },
      },
      required: [`question`],
      additionalProperties: false,
    },
  },
  {
    name: `submit_career_plan`,
    description: `Hand in the final answer: about 10 careers, best fit first, each with why it fits and how to get there. Call it once you're done.`,
    eager_input_streaming: true,
    input_schema: {
      type: `object`,
      properties: {
        careers: {
          type: `array`,
          items: {
            type: `object`,
            properties: {
              career: { type: `string` }, // job title
              reason: { type: `string` }, // why it fits this person
              school: {
                type: `object`,
                properties: {
                  required: { type: `boolean` }, // is a degree needed?
                  details: { type: `string` }, // which degree, or why not needed
                },
                required: [`required`, `details`],
                additionalProperties: false,
              },
              certifications: { type: `array`, items: { type: `string` } },
              other: { type: `array`, items: { type: `string` } }, // portfolio, apprenticeship, license...
              steps: {
                type: `array`,
                items: {
                  type: `object`,
                  properties: {
                    step: { type: `string` }, // what to do
                    timeline: { type: `string` }, // rough duration
                  },
                  required: [`step`, `timeline`],
                  additionalProperties: false,
                },
              },
            },
            required: [
              `career`,
              `reason`,
              `school`,
              `certifications`,
              `other`,
              `steps`,
            ],
            additionalProperties: false,
          },
        },
      },
      required: [`careers`],
      additionalProperties: false,
    },
  },
];

// CHECK for submit_career_plan — plain code, same idea as the gates in the workflows.
// Returns what's wrong (sent back to the agent so it can fix it), or null if it's fine.
function checkSubmission(input) {
  const careers = input?.careers;
  if (!Array.isArray(careers)) return `"careers" must be a list.`;
  if (careers.length < MIN_CAREERS || careers.length > MAX_CAREERS) {
    return `Give about 10 careers (between ${MIN_CAREERS} and ${MAX_CAREERS}), you gave ${careers.length}.`;
  }
  for (const c of careers) {
    const name = c?.career || `(unnamed career)`;
    if (typeof c?.career !== `string` || typeof c?.reason !== `string`)
      return `${name}: "career" and "reason" must be text.`;
    if (
      typeof c.school?.required !== `boolean` ||
      typeof c.school?.details !== `string`
    )
      return `${name}: "school" needs "required" (true/false) and "details".`;
    if (!Array.isArray(c.certifications) || !Array.isArray(c.other))
      return `${name}: "certifications" and "other" must be lists.`;
    if (!Array.isArray(c.steps) || c.steps.length === 0)
      return `${name}: give at least one step.`;
    if (
      c.steps.some(
        (s) => typeof s?.step !== `string` || typeof s?.timeline !== `string`,
      )
    )
      return `${name}: each step needs "step" and "timeline".`;
  }
  return null;
}

async function main() {
  // ===========================================================================
  // INPUT — same questions and gate as the workflows.
  // The terminal stays open: the agent may ask more questions with ask_user.
  // ===========================================================================
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const likes = (await terminal.question(`What do you like? `)).trim();
  const dislikes = (await terminal.question(`What do you dislike? `)).trim();

  if (!likes && !dislikes) {
    terminal.close();
    console.error(
      `Gate failed: no user input. Tell us at least what you like or dislike.`,
    );
    process.exit(1);
  }
  const userInput = `Likes: ${likes || `(not given)`}\nDislikes: ${dislikes || `(not given)`}`;
  console.log(`\nUSER INPUT:\n${userInput}\n`);

  // The conversation: the agent's memory. Each turn of the loop adds to it,
  // so the agent always sees everything it thought, did and observed so far.
  const messages = [
    {
      role: `user`,
      content: `Here is what this person likes and dislikes:\n${userInput}`,
    },
  ];
  let finalPlan = null; // set when submit_career_plan passes the check

  // ===========================================================================
  // THE AGENT LOOP — call the model, run the tools it asks for, send back the
  // results, repeat. The MODEL decides what to do at each step; we only obey.
  // ===========================================================================
  for (let step = 1; step <= MAX_STEPS && !finalPlan; step++) {
    console.log(`=== STEP ${step}/${MAX_STEPS} ===`);

    let response;
    try {
      response = await client.beta.messages
        .stream({
          model: AGENT_MODEL,
          max_tokens: 64000,
          system: SYSTEM_PROMPT,
          messages: messages,
          tools: TOOLS,
          // `summarized` = we get a readable summary of its reasoning: that's the THOUGHT we print.
          thinking: { type: `adaptive`, display: `summarized` },
          output_config: { effort: `medium` },
          // If the safety filter declines, the API retries on another model by itself.
          betas: [`server-side-fallback-2026-07-01`],
          fallbacks: `default`,
          cache_control: { type: "ephemeral" },
        })
        .finalMessage(); // wait for the full answer
      console.log(
        `TOKENS: input=${response.usage.input_tokens} cache_read=${response.usage.cache_read_input_tokens} cache_write=${response.usage.cache_creation_input_tokens} output=${response.usage.output_tokens}`,
      );
      console.log("Réponse complète :", response);
    } catch (error) {
      // An API error (bad key, rate limit, server down...): stop.
      if (error instanceof Anthropic.APIError) throw error;
      // Anything else here means a tool input wasn't valid JSON: retry this step.
      console.error(
        `The agent's tool input wasn't valid JSON, retrying this step.\n`,
      );
      continue;
    }

    // Print what the agent did in this step: its thoughts, its actions, what it observed.
    for (const block of response.content) {
      if (block.type === `thinking` && block.thinking)
        console.log(`THOUGHT: ${block.thinking}`);
      if (block.type === `text` && block.text)
        console.log(`AGENT: ${block.text}`);
      if (block.type === `server_tool_use`)
        console.log(`ACTION: ${block.name}(${JSON.stringify(block.input)})`);
      if (block.type === `web_search_tool_result`) {
        // Success = a list of results; error = a single object with an error_code.
        if (Array.isArray(block.content))
          console.log(
            `OBSERVATION: ${block.content.length} results — ${block.content
              .map((r) => r.title)
              .slice(0, 3)
              .join(` | `)}`,
          );
        else
          console.log(
            `OBSERVATION: search failed (${block.content.error_code})`,
          );
      }
      if (block.type === `tool_use`)
        console.log(
          `ACTION: ${block.name}(${block.name === `submit_career_plan` ? `${block.input?.careers?.length ?? 0} careers` : JSON.stringify(block.input)})`,
        );
    }

    // Stops that mean "something went wrong": don't run tools from a cut-off or declined answer.
    if (response.stop_reason === `refusal`)
      throw new Error(`The agent declined the request.`);
    if (response.stop_reason === `max_tokens`)
      throw new Error(`The agent's answer was cut off (max_tokens).`);

    // Save the agent's turn in its memory: the WHOLE content (thoughts, tool calls...), not just the text.
    messages.push({ role: `assistant`, content: response.content });

    // `pause_turn`: the server paused during its web searches; sending the
    // conversation back as is lets it continue where it stopped.
    if (response.stop_reason === `pause_turn`) continue;

    // The agent stopped without calling a tool: it hasn't handed in its answer yet.
    const toolCalls = response.content.filter((b) => b.type === `tool_use`);
    if (toolCalls.length === 0) {
      messages.push({
        role: `user`,
        content: `Please hand in your final answer with the submit_career_plan tool.`,
      });
      continue;
    }

    // -------------------------------------------------------------------------
    // RUN THE TOOLS the agent asked for, and collect what each one returns:
    // that's the OBSERVATION the agent reads at the next step.
    // -------------------------------------------------------------------------
    const toolResults = [];
    for (const call of toolCalls) {
      if (call.name === `ask_user`) {
        if (typeof call.input?.question !== `string`) {
          toolResults.push({
            type: `tool_result`,
            tool_use_id: call.id,
            is_error: true,
            content: `"question" must be text.`,
          });
          continue;
        }
        const answer = (
          await terminal.question(`\nAGENT ASKS: ${call.input.question}\n> `)
        ).trim();
        console.log(`OBSERVATION: the person answered "${answer}"`);
        toolResults.push({
          type: `tool_result`,
          tool_use_id: call.id,
          content: answer || `(no answer)`,
        });
      }

      if (call.name === `submit_career_plan`) {
        const problem = checkSubmission(call.input);
        if (problem) {
          // Not accepted: the agent reads the error at the next step and fixes its answer.
          console.log(`OBSERVATION: submission rejected — ${problem}`);
          toolResults.push({
            type: `tool_result`,
            tool_use_id: call.id,
            is_error: true,
            content: problem,
          });
        } else {
          console.log(`OBSERVATION: submission accepted.`);
          toolResults.push({
            type: `tool_result`,
            tool_use_id: call.id,
            content: `Accepted.`,
          });
          finalPlan = call.input.careers; // ends the loop
        }
      }

      // Every tool call needs an answer, even one we don't know (the API rejects the next request otherwise).
      if (call.name !== `ask_user` && call.name !== `submit_career_plan`) {
        toolResults.push({
          type: `tool_result`,
          tool_use_id: call.id,
          is_error: true,
          content: `Unknown tool "${call.name}".`,
        });
      }
    }
    // All the results go back together, in one message, as the next "user" turn.
    messages.push({ role: `user`, content: toolResults });
    console.log("Répponse des outils utilisés", toolResults);
    console.log();
  }

  terminal.close(); // stop listening to the keyboard, otherwise the script never exits

  // ===========================================================================
  // RESULT
  // ===========================================================================
  if (!finalPlan) {
    console.error(
      `\nThe agent didn't hand in a valid answer within ${MAX_STEPS} steps.`,
    );
    process.exit(1);
  }
  console.log(`\nFINAL ANSWER — CAREERS AND HOW TO GET THERE (JSON):`);

  console.log(JSON.stringify(finalPlan, null, 2));
}

main();
