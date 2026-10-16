// =============================================================================
// CAREER PATHS — an EVALUATOR-OPTIMIZER workflow
// =============================================================================
//
// What "evaluator-optimizer" means (vs. an agent):
//   - A GENERATOR (Sonnet) proposes an answer; an EVALUATION step checks it.
//   - If the answer fails, the generator tries again. This repeats until the
//     answer passes or we reach MAX_ITERATIONS.
//   - It's still a WORKFLOW: the loop, its limit and the stop condition are
//     hard-coded by US. The LLMs never decide what happens next or call tools.
//
// The evaluation has two parts, each doing what it's best at:
//   1. CODE checks the numbers (exact, free, instant): at least 5 careers with
//      a grade above 8/10 that take less than 2 years (24 months) to get into.
//   2. An LLM EVALUATOR (Haiku) checks what code can't: do those grades and
//      durations sound realistic? A career it flags no longer counts.
//
// The generator is NOT told the criteria. It only knows its list didn't pass
// and that it should find careers that fit the person better. If it knew the
// target, it could just inflate grades or shorten durations to pass.
//
//                                    ┌──────────── "didn't pass, find better fits" ────────────┐
//                                    v                                                         │
//   [likes/dislikes] -> INPUT GATE -> GENERATOR -> GATE -> CODE CHECK ─> HAIKU: realistic? ─> passed? ─> [print]
//                                                     (stop after MAX_ITERATIONS tries)
//
// Run it:  node --env-file=.env workflow_evaluator_optimizer.mjs   (then answer the questions in the terminal)
// =============================================================================

import readline from "node:readline/promises"; // built into Node: reads what the user types in the terminal
// Client, shared limits and the LLM call live in config.mjs.
import { MIN_CAREERS, MAX_CAREERS, callLLM } from "./config.mjs";

// --- Settings used only by this workflow -------------------------------------
const GENERATOR_MODEL = `claude-opus-5-5`; // suggests the careers (the "optimizer")
const EVALUATOR_MODEL = `claude-haiku-5-5`;  // judges if grades and durations are realistic
const MAX_ITERATIONS = 3; // how many tries the generator gets before we stop (caps time and cost)
// The criteria, checked by code: at least MIN_QUALIFYING careers must have a
// grade ABOVE MIN_GRADE and take LESS than MAX_MONTHS to get into.
const MIN_QUALIFYING = 5;
const MIN_GRADE = 8;   // grade is out of 10
const MAX_MONTHS = 24; // 2 years

// --- Structured outputs used only by this workflow ---------------------------
// Graded careers: like STEP1_SCHEMA in config.mjs, plus a grade and the time to get there.
const GRADED_CAREERS_SCHEMA = {
  type: `object`,
  properties: {
    careers: {
      type: `array`,
      items: {
        type: `object`,
        properties: {
          career: { type: `string` },  // job title
          reason: { type: `string` },  // why it fits this person
          grade: { type: `integer` },  // how well it fits this person, from 0 to 10
          months: { type: `integer` }, // realistic time to get into this career, in months
        },
        required: [`career`, `reason`, `grade`, `months`],
        additionalProperties: false,
      },
    },
  },
  required: [`careers`],
  additionalProperties: false,
};

// Realism check: the careers whose grade or duration doesn't sound right.
const REALISM_SCHEMA = {
  type: `object`,
  properties: {
    unrealistic: {
      type: `array`,
      items: {
        type: `object`,
        properties: {
          career: { type: `string` },  // job title, exactly as given
          problem: { type: `string` }, // what's wrong: grade too high for this person, duration too short...
        },
        required: [`career`, `problem`],
        additionalProperties: false,
      },
    },
  },
  required: [`unrealistic`],
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

  let careers;          // the generator's latest list
  let passed = false;   // did the latest list pass the evaluation?

  // ===========================================================================
  // THE LOOP — generate, check, evaluate; retry if it failed.
  // ===========================================================================
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    console.log(`=== ITERATION ${iteration}/${MAX_ITERATIONS} ===\n`);

    // -------------------------------------------------------------------------
    // GENERATOR (Sonnet) — step 1's prompt from workflow_prompt_chaining.mjs,
    // plus an honest grade and duration for each career. It never sees the
    // criteria. From the 2nd try on, it gets its previous list and is only
    // told that it didn't pass.
    // -------------------------------------------------------------------------
    let generatorInput = `Here is what this person likes and dislikes:\n${userInput}`;
    if (iteration > 1) {
      generatorInput += `\n\nYour previous list:\n${JSON.stringify(careers, null, 2)}` +
        `\n\nThis list did not pass our checks. Give a new list of 10 careers that fit this person better.`;
    }

    const generatorOutput = await callLLM(
      `You are a career counselor. Based on a person's likes and dislikes, choose 10 different career paths that fit them, best fit first.
    For each one, give the job title, one or two sentences on why it fits this person,
    an honest grade from 0 to 10 for how well it fits this person, and the realistic number of months it takes to get into it.`,
      generatorInput,
      GRADED_CAREERS_SCHEMA,
      GENERATOR_MODEL
    );

    // GATE — plain code checking the generator's answer before evaluating it.
    careers = JSON.parse(generatorOutput).careers;
    if (careers.length < MIN_CAREERS || careers.length > MAX_CAREERS) {
      console.error(`Gate failed: the generator should return about 10 careers, got ${careers.length}.`);
      process.exit(1);
    }

    console.log(`GENERATOR (${GENERATOR_MODEL}) suggested:`);
    careers.forEach((c, i) => console.log(`  ${i + 1}. ${c.career} — grade ${c.grade}/10, ${c.months} months — ${c.reason}`));
    console.log();

    // -------------------------------------------------------------------------
    // EVALUATION 1/2 — CODE checks the numbers.
    // If too few careers qualify, no need to pay for the LLM check: retry now.
    // -------------------------------------------------------------------------
    let qualifying = careers.filter((c) => c.grade > MIN_GRADE && c.months < MAX_MONTHS);
    console.log(`CODE CHECK: ${qualifying.length} career(s) with grade > ${MIN_GRADE} and < ${MAX_MONTHS} months (need ${MIN_QUALIFYING}).`);
    if (qualifying.length < MIN_QUALIFYING) {
      console.log(`  -> FAILED\n`);
      continue; // next iteration
    }
    console.log(`  -> passed\n`);

    // -------------------------------------------------------------------------
    // EVALUATION 2/2 — HAIKU checks if the grades and durations are realistic.
    // It doesn't know the criteria either: it only judges realism. Careers it
    // flags are removed from the qualifying ones.
    // -------------------------------------------------------------------------
    const realismOutput = await callLLM(
      `You are a strict career expert. You'll get a person's likes and dislikes and a list of careers suggested for them,
      each with a fit grade (0-10) and the number of months it takes to get into it.
      Flag every career whose grade is too high for this person, or whose duration is too short to be realistic
      for someone starting from scratch (school, certifications, experience required...). Don't flag careers that look right.`,
      `The person's likes/dislikes:\n${userInput}\n\nCareers:\n${JSON.stringify(careers, null, 2)}`,
      REALISM_SCHEMA,
      EVALUATOR_MODEL
    );
    const unrealistic = JSON.parse(realismOutput).unrealistic;
    const flagged = unrealistic.map((u) => u.career);
    qualifying = qualifying.filter((c) => !flagged.includes(c.career));

    console.log(`REALISM CHECK (${EVALUATOR_MODEL}): ${unrealistic.length} career(s) flagged as unrealistic.`);
    unrealistic.forEach((u) => console.log(`  - ${u.career}: ${u.problem}`));
    console.log(`  ${qualifying.length} realistic qualifying career(s) left (need ${MIN_QUALIFYING}).`);

    if (qualifying.length >= MIN_QUALIFYING) {
      console.log(`  -> passed\n`);
      passed = true;
      break; // good enough: stop looping
    }
    console.log(`  -> FAILED\n`);
  }

  // ===========================================================================
  // RESULT — the last list, and whether it passed the evaluation.
  // ===========================================================================
  if (passed) {
    console.log(`RESULT: the list passed the evaluation.`);
  } else {
    console.log(`RESULT: still not passing after ${MAX_ITERATIONS} tries; here is the last list.`);
  }
  console.log(JSON.stringify(careers, null, 2));
}

main();
