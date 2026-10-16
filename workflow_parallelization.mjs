// =============================================================================
// CAREER PATHS — a PARALLELIZATION workflow (the "voting" kind)
// =============================================================================
//
// What "parallelization" means (vs. an agent):
//   - A WORKFLOW: the steps are hard-coded by US, in this file.
//   - The SAME question is sent to several LLMs AT THE SAME TIME (not one after
//     the other). Here: 3 different models each pick the careers that fit.
//   - When all answers are back, our code passes them to ONE more LLM call,
//     the synthesizer, which merges them into a single reconciled answer.
//   - Why: one model can miss things or have blind spots; careers that several
//     models propose independently are more reliable picks.
//   - The LLMs never decide what happens next, never call tools, never loop.
//
//                                         ┌─ LLM A (Opus)   ─┐
//   [likes/dislikes] -> INPUT GATE ───────┼─ LLM B (Sonnet) ─┼─> GATE -> LLM: synthesize -> GATE -> [print]
//                                         └─ LLM C (Haiku)  ─┘
//                                          (all 3 run at once)
//
// Run it:  node --env-file=.env workflow_parallelization.mjs   (then answer the questions in the terminal)
// =============================================================================

import readline from "node:readline/promises"; // built into Node: reads what the user types in the terminal
// Client, default model, shared limits, the careers schema and the LLM call live in config.mjs.
import { MIN_CAREERS, MAX_CAREERS, STEP1_SCHEMA, callLLM } from "./config.mjs";

// --- Settings used only by this workflow -------------------------------------
// The 3 models that answer the same question at the same time (one per size:
// big, medium, small), and the model that merges their answers.
const PARALLEL_MODELS = [`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`];
const SYNTHESIS_MODEL = `claude-haiku-5-5`;
// Limits checked by the synthesis gate (the synthesis is asked for 5 top careers).
const MIN_TOP_CAREERS = 3;
const MAX_TOP_CAREERS = 7;

// --- Structured output used only by this workflow ----------------------------
// Synthesis: the reconciled answer built from the 3 models' career lists.
const SYNTHESIS_SCHEMA = {
  type: `object`,
  properties: {
    top_careers: {
      type: `array`,
      items: {
        type: `object`,
        properties: {
          career: { type: `string` },
          reason: { type: `string` }, // why it fits, combining the models' reasons
          suggested_by: { type: `array`, items: { type: `string`, enum: PARALLEL_MODELS } }, // which models proposed it
        },
        required: [`career`, `reason`, `suggested_by`],
        additionalProperties: false,
      },
    },
    agreements: { type: `string` },        // where the models agree
    disagreements: { type: `string` },     // where they differ, and how it was settled
    reconciled_answer: { type: `string` }, // the final advice, in a few sentences
  },
  required: [`top_careers`, `agreements`, `disagreements`, `reconciled_answer`],
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
  terminal.close(); // stop listening to the keyboard, otherwise the script never exits

  // INPUT GATE — plain code (no LLM): no likes/dislikes, no workflow.
  // We stop here instead of paying for LLM calls that have nothing to work with.
  if (!likes && !dislikes) {
    console.error(`Gate failed: no user input. Tell us at least what you like or dislike.`);
    process.exit(1);
  }
  const userInput = `Likes: ${likes || `(not given)`}\nDislikes: ${dislikes || `(not given)`}`;
  console.log(`\nUSER INPUT:\n${userInput}\n`);

  // ===========================================================================
  // STEP 1 — the SAME LLM call sent to 3 models IN PARALLEL
  // Same prompt and schema as step 1 of workflow_prompt_chaining.mjs.
  //
  // `callLLM(...)` starts a request and immediately returns a "promise" (a
  // result that will arrive later). We start all 3 without waiting, then
  // `Promise.allSettled` waits until every one has finished. Total time is
  // about the time of the SLOWEST model, not the sum of the three.
  // `allSettled` (not `all`) so one failing model doesn't stop the others.
  // ===========================================================================
  console.log(`Asking ${PARALLEL_MODELS.join(`, `)} at the same time...\n`);
  const startedAt = Date.now();
  const results = await Promise.allSettled(
    PARALLEL_MODELS.map((model) =>
      callLLM(
        `You are a career counselor. Based on a person's likes and dislikes, choose 10 different career paths that fit them, best fit first.
For each one, give the job title and one or two sentences on why it fits this person.`,
        `Here is what this person likes and dislikes:\n${userInput}`,
        STEP1_SCHEMA,
        model
      )
    )
  );
  console.log(`All 3 calls finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.\n`);

  // ===========================================================================
  // GATE — plain code checking each model's answer.
  // A model whose call failed, or that returned too few/many careers, is left
  // out. We need at least 2 valid answers for a synthesis to make sense.
  // `results[i]` is the answer of `PARALLEL_MODELS[i]` (same order).
  // ===========================================================================
  const answers = []; // the valid answers: [{ model, careers }, ...]
  results.forEach((result, i) => {
    const model = PARALLEL_MODELS[i];
    if (result.status === `rejected`) {
      console.error(`Left out ${model}: the call failed (${result.reason.message}).`);
      return;
    }
    const careers = JSON.parse(result.value).careers;
    if (careers.length < MIN_CAREERS || careers.length > MAX_CAREERS) {
      console.error(`Left out ${model}: should return about 10 careers, got ${careers.length}.`);
      return;
    }
    answers.push({ model, careers });
  });
  if (answers.length < 2) {
    console.error(`Gate failed: only ${answers.length} valid answer(s), need at least 2 to synthesize.`);
    process.exit(1);
  }

  // Print each model's answer.
  answers.forEach(({ model, careers }) => {
    console.log(`ANSWER FROM ${model}:`);
    careers.forEach((c, i) => console.log(`  ${i + 1}. ${c.career} — ${c.reason}`));
    console.log();
  });

  // ===========================================================================
  // STEP 2 — LLM call: SYNTHESIZE the answers into one reconciled answer
  // Its input is all the valid answers from step 1, labelled with their model.
  // ===========================================================================
  const synthesisOutput = await callLLM(
    `You are a senior career counselor. Several AI models independently suggested careers for the same person.
Reconcile their answers into one recommendation:
- Pick the 5 best careers for this person, best first. Prefer careers several models suggested, but keep a career
  only one model suggested if it clearly fits better. Treat close job titles as the same career.
- For each one, explain why it fits, and list which models suggested it (use the model names exactly as given).
- Summarize where the models agree, where they disagree and how you settled it, then give the final advice in a few sentences.`,
    `The person's likes/dislikes:\n${userInput}\n\nAnswers from each model:\n${JSON.stringify(answers, null, 2)}`,
    SYNTHESIS_SCHEMA,
    SYNTHESIS_MODEL
  );

  // ===========================================================================
  // FINAL CHECK — plain code checking the synthesis before showing it.
  // ===========================================================================
  const synthesis = JSON.parse(synthesisOutput);
  if (synthesis.top_careers.length < MIN_TOP_CAREERS || synthesis.top_careers.length > MAX_TOP_CAREERS) {
    console.error(`Gate failed: synthesis should return about 5 top careers, got ${synthesis.top_careers.length}.`);
    process.exit(1);
  }

  console.log(`SYNTHESIS (by ${SYNTHESIS_MODEL}):`);
  console.log(`\nTop career recommendations:`);
  synthesis.top_careers.forEach((c, i) =>
    console.log(`  ${i + 1}. ${c.career} — ${c.reason}\n     suggested by: ${c.suggested_by.join(`, `)}`)
  );
  console.log(`\nWhere the models agree:\n  ${synthesis.agreements}`);
  console.log(`\nWhere they disagree:\n  ${synthesis.disagreements}`);
  console.log(`\nReconciled answer:\n  ${synthesis.reconciled_answer}`);
}

main();
