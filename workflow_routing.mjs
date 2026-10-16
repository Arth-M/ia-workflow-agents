// =============================================================================
// CAREER OR TRAINING — a ROUTING workflow
// =============================================================================
//
// What "routing" means (vs. an agent):
//   - A WORKFLOW: the possible paths are hard-coded by US, in this file.
//   - A ROUTER looks at the input, puts it in a category, and sends it to the
//     ONE specialized path for that category. Only that path runs.
//   - Here the router is plain code: the person picks "career" or "training"
//     and an `if` sends them down one branch. (A router can also be an LLM
//     call that classifies free text; same idea, the code still does the routing.)
//   - Each branch has its own focused prompt and schema, so neither prompt has
//     to handle both cases.
//
//                                                  ┌─ "career"   -> LLM: pick ~10 careers   -> GATE -> [print]
//   [likes/dislikes] -> INPUT GATE -> ROUTER ──────┤
//                                                  └─ "training" -> LLM: pick ~10 trainings -> GATE -> [print]
//
// Run it:  node --env-file=.env workflow_routing.mjs   (then answer the questions in the terminal)
// =============================================================================

import readline from "node:readline/promises"; // built into Node: reads what the user types in the terminal
// Client, default model, shared limits, the careers schema and the LLM call live in config.mjs.
import { MIN_CAREERS, MAX_CAREERS, STEP1_SCHEMA, callLLM } from "./config.mjs";

// --- Settings used only by this workflow -------------------------------------
// Limits checked by the training gate ("about 10" = accept 8 to 12).
const MIN_TRAININGS = 8;
const MAX_TRAININGS = 12;

// --- Structured output used only by this workflow ----------------------------
// Trainings: a list of training paths (school, certification, bootcamp...) + how to follow each.
const TRAINING_SCHEMA = {
  type: `object`,
  properties: {
    trainings: {
      type: `array`,
      items: {
        type: `object`,
        properties: {
          training: { type: `string` }, // name of the program / certification / course
          // `enum` = the model must pick one of these exact values
          type: { type: `string`, enum: [`school`, `certification`, `bootcamp`, `apprenticeship`, `online course`, `other`] },
          reason: { type: `string` },   // why it fits this person
          duration: { type: `string` }, // rough total duration
          steps: {
            type: `array`,
            items: {
              type: `object`,
              properties: {
                step: { type: `string` },     // what to do
                timeline: { type: `string` }, // rough duration
              },
              required: [`step`, `timeline`],
              additionalProperties: false,
            },
          },
        },
        required: [`training`, `type`, `reason`, `duration`, `steps`],
        additionalProperties: false,
      },
    },
  },
  required: [`trainings`],
  additionalProperties: false,
};

async function main() {
  // ===========================================================================
  // INPUT — ask the person in the terminal what they like and dislike.
  // `readline` is built into Node: it prints a question and waits for the
  // person to type an answer and press Enter.
  // ===========================================================================
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  const likes = (await terminal.question(`What do you like? `)).trim();
  const dislikes = (await terminal.question(`What do you dislike? `)).trim();

  // INPUT GATE — plain code (no LLM): no likes/dislikes, no workflow.
  // We stop here instead of paying for an LLM call that has nothing to work with.
  if (!likes && !dislikes) {
    terminal.close();
    console.error(`Gate failed: no user input. Tell us at least what you like or dislike.`);
    process.exit(1);
  }

  // ===========================================================================
  // ROUTER — which path does the person want? We accept the word or its number.
  // ===========================================================================
  const choice = (await terminal.question(`Are you interested in 1) a career or 2) a training? `)).trim().toLowerCase();
  terminal.close(); // stop listening to the keyboard, otherwise the script never exits

  let route;
  if (choice === `1` || choice === `career`) route = `career`;
  else if (choice === `2` || choice === `training`) route = `training`;
  else {
    console.error(`Gate failed: please answer "career" (1) or "training" (2), got "${choice}".`);
    process.exit(1);
  }

  const userInput = `Likes: ${likes || `(not given)`}\nDislikes: ${dislikes || `(not given)`}`;
  console.log(`\nUSER INPUT:\n${userInput}\nROUTE: ${route}\n`);

  // ===========================================================================
  // BRANCH 1 — "career": LLM call that picks about 10 career paths
  // Same prompt and schema as step 1 of workflow_chain_prompt.mjs.
  // ===========================================================================
  if (route === `career`) {
    const output = await callLLM(
      `You are a career counselor. Based on a person's likes and dislikes, choose 10 different career paths that fit them, best fit first.
For each one, give the job title and one or two sentences on why it fits this person.`,
      `Here is what this person likes and dislikes:\n${userInput}`,
      STEP1_SCHEMA
    );

    // GATE — plain code checking the LLM's answer before showing it.
    const careers = JSON.parse(output).careers;
    if (careers.length < MIN_CAREERS || careers.length > MAX_CAREERS) {
      console.error(`Gate failed: should return about 10 careers, got ${careers.length}.`);
      process.exit(1);
    }

    console.log(`CAREERS THAT FIT YOU:`);
    careers.forEach((c, i) => console.log(`  ${i + 1}. ${c.career} — ${c.reason}`));
    console.log(`\nJSON:\n${JSON.stringify(careers, null, 2)}`);
  }

  // ===========================================================================
  // BRANCH 2 — "training": LLM call that picks about 10 training paths
  // Built on step 2's prompt from workflow_chain_prompt.mjs (school,
  // certifications, steps with timelines), but starting from the likes/dislikes
  // instead of a list of careers.
  // ===========================================================================
  if (route === `training`) {
    const output = await callLLM(
      `You are a career counselor. Based on a person's likes and dislikes, choose 10 different training paths that fit them, best fit first:
school programs, certifications, bootcamps, apprenticeships, online courses, or something else.
For each one: give its name and type, one or two sentences on why it fits this person, its rough total duration,
then ordered steps to follow it with a rough timeline for each.`,
      `Here is what this person likes and dislikes:\n${userInput}`,
      TRAINING_SCHEMA
    );

    // GATE — plain code checking the LLM's answer before showing it.
    const trainings = JSON.parse(output).trainings;
    if (trainings.length < MIN_TRAININGS || trainings.length > MAX_TRAININGS) {
      console.error(`Gate failed: should return about 10 training paths, got ${trainings.length}.`);
      process.exit(1);
    }
    if (trainings.some((t) => t.steps.length === 0)) {
      console.error(`Gate failed: a training path has no steps.`);
      process.exit(1);
    }

    console.log(`TRAINING PATHS THAT FIT YOU:`);
    trainings.forEach((t, i) => console.log(`  ${i + 1}. ${t.training} (${t.type}, ${t.duration}) — ${t.reason}`));
    console.log(`\nJSON:\n${JSON.stringify(trainings, null, 2)}`);
  }
}

main();
