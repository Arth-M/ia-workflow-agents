// =============================================================================
// CAREER PATHS — a PROMPT CHAINING workflow
// =============================================================================
//
// What "prompt chaining" means (vs. an agent):
//   - A WORKFLOW: the steps and their order are hard-coded by US, in this file.
//     LLM call #1 -> (code check, a "gate") -> LLM call #2 -> (check) -> done.
//   - Each LLM call does ONE focused job and its output becomes the input of
//     the next call.
//   - The LLM never decides what happens next, never calls tools, never loops.
//     That would make it an agent. Here, it just fills in text at each step.
//
//   [user likes/dislikes] -> INPUT GATE -> LLM 1: pick ~10 careers -> GATE -> LLM 2: how to get to each one -> CHECK -> [print]
//
// Run it:  node --env-file=.env workflow_prompt_chaining.mjs   (then answer the questions in the terminal)
// =============================================================================

import readline from "node:readline/promises"; // built into Node: reads what the user types in the terminal
// Client, default model, shared limits, the careers schema and the LLM call live in config.mjs.
import { MIN_CAREERS, MAX_CAREERS, STEP1_SCHEMA, callLLM } from "./config.mjs";

// --- Structured output used only by this workflow ----------------------------
// Plans: how to get to each career (school, certifications, other, steps).
const STEP2_SCHEMA = {
  type: `object`,
  properties: {
    plans: {
      type: `array`,
      items: {
        type: `object`,
        properties: {
          career: { type: `string` },
          school: {
            type: `object`,
            properties: {
              required: { type: `boolean` }, // is a degree needed?
              details: { type: `string` },   // which degree, or why not needed
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
                step: { type: `string` },     // what to do
                timeline: { type: `string` }, // rough duration
              },
              required: [`step`, `timeline`],
              additionalProperties: false,
            },
          },
        },
        required: [`career`, `school`, `certifications`, `other`, `steps`],
        additionalProperties: false,
      },
    },
  },
  required: [`plans`],
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
  // We stop here instead of paying for an LLM call that has nothing to work with.
  if (!likes && !dislikes) {
    console.error(`Gate failed: no user input. Tell us at least what you like or dislike.`);
    process.exit(1);
  }
  const userInput = `Likes: ${likes || `(not given)`}\nDislikes: ${dislikes || `(not given)`}`;
  console.log(`\nUSER INPUT:\n${userInput}\n`);

  // ===========================================================================
  // STEP 1 — LLM call: choose about 10 career paths
  // STEP1_SCHEMA forces the JSON shape, so the prompt only describes the task.
  // ===========================================================================
  const step1Output = await callLLM(
    `You are a career counselor. Based on a person's likes and dislikes, choose 10 different career paths that fit them, best fit first.
For each one, give the job title and one or two sentences on why it fits this person.`,
    `Here is what this person likes and dislikes:\n${userInput}`,
    STEP1_SCHEMA
    // JSON.stringify({
    //   careers: [
    //     { career: `Game UI/UX Designer`, reason: `Combines drawing and video games, creative hands-on work with little math.` },
    //     { career: `2D Game Artist`, reason: `Drawing all day for games they already love.` },
    //     { career: `Illustrator`, reason: `Pure drawing work, often freelance, so few meetings.` },
    //     { career: `Concept Artist`, reason: `Draws characters and worlds for games and films.` },
    //     { career: `IT Support Technician`, reason: `Turns their habit of fixing friends' computers into a job.` },
    //     { career: `Game QA Tester`, reason: `Plays games professionally to find bugs; no math or sales.` },
    //     { career: `Motion Graphics Designer`, reason: `Animated drawings for videos and games.` },
    //     { career: `Tattoo Artist`, reason: `Drawing as a hands-on craft, working one client at a time.` },
    //     { career: `Front-End Web Developer`, reason: `Visual, computer-based work with light math.` },
    //     { career: `Storyboard Artist`, reason: `Draws scenes for animation and games, mostly solo work.` },
    //   ],
    // })
  );

  // ===========================================================================
  // GATE — plain code (no LLM) checking step 1 before moving on.
  // This is a standard part of prompt chaining: if a step produced garbage,
  // stop the chain here instead of feeding garbage into the next call.
  // ===========================================================================
  let careers;
  try {
    careers = JSON.parse(step1Output).careers;
  } catch {
    console.error(`Gate failed: step 1 did not return valid JSON:\n${step1Output}`);
    process.exit(1);
  }
  if (!Array.isArray(careers) || careers.length < MIN_CAREERS || careers.length > MAX_CAREERS) {
    console.error(`Gate failed: step 1 should return about 10 careers, got ${careers?.length ?? 0}.`);
    process.exit(1);
  }
  console.log(`STEP 1 — CHOSEN CAREERS:`);
  careers.forEach((c, i) => console.log(`  ${i + 1}. ${c.career} — ${c.reason}`));
  console.log();

  // ===========================================================================
  // STEP 2 — LLM call: how to get to EACH of those careers
  // Its input is step 1's OUTPUT (that's the "chain"), plus the original input
  // for context. One single call covers all careers: the chain stays
  // input -> LLM 1 -> LLM 2, and the model only explains, it doesn't re-pick.
  // ===========================================================================
  const step2Output = await callLLM(
    `You are a career counselor. For EACH career in the list, explain concretely how to get there:
whether it requires school, certifications, or something else (portfolio, apprenticeship...).
Keep the same careers in the same order, with the job titles exactly as given; do not add or remove any.
For each career: say whether school is required (and which degree), list certifications and other requirements,
then give ordered steps with a rough timeline for each.`,
    `Careers:\n${JSON.stringify(careers, null, 2)}\n\nThe person's likes/dislikes: ${userInput}`,
    STEP2_SCHEMA,
    // Fake answer: short plans, one per career from the fake step 1 answer.
    JSON.stringify({
      plans: [
        { career: `Game UI/UX Designer`, school: { required: false, details: `A Graphic/Interaction/Game Design degree helps but isn't required.` }, certifications: [`Google UX Design Certificate (optional)`], other: [`Game UI portfolio`, `Figma, Unity/Unreal UI`], steps: [{ step: `Learn Figma and a game engine's UI tools`, timeline: `3-6 months` }, { step: `Build a portfolio from game jams and redesigns`, timeline: `~1 year` }] },
        { career: `2D Game Artist`, school: { required: false, details: `Art school or a game art program helps; the portfolio matters most.` }, certifications: [], other: [`Art portfolio`, `Photoshop, Aseprite`], steps: [{ step: `Practice game-ready 2D art (sprites, tiles)`, timeline: `6-12 months` }, { step: `Ship art in game jams, then apply to studios`, timeline: `~1 year` }] },
        { career: `Illustrator`, school: { required: false, details: `An illustration degree is common but optional.` }, certifications: [], other: [`Portfolio`, `Online presence (Instagram, ArtStation)`], steps: [{ step: `Build a consistent style and portfolio`, timeline: `6-12 months` }, { step: `Take small freelance commissions`, timeline: `ongoing` }] },
        { career: `Concept Artist`, school: { required: false, details: `Entertainment design courses help; many are self-taught.` }, certifications: [], other: [`Portfolio of characters and environments`], steps: [{ step: `Study anatomy, perspective, and digital painting`, timeline: `1-2 years` }, { step: `Apply to junior roles or art outsourcing studios`, timeline: `after portfolio` }] },
        { career: `IT Support Technician`, school: { required: false, details: `No degree needed for entry-level roles.` }, certifications: [`CompTIA A+`], other: [`Hands-on troubleshooting experience`], steps: [{ step: `Study for and pass CompTIA A+`, timeline: `2-3 months` }, { step: `Apply for help desk roles`, timeline: `right after` }] },
        { career: `Game QA Tester`, school: { required: false, details: `No degree needed.` }, certifications: [`ISTQB Foundation (optional)`], other: [`Clear bug-report writing`], steps: [{ step: `Practice writing bug reports on games you play`, timeline: `1 month` }, { step: `Apply to QA roles at studios or QA outsourcing firms`, timeline: `1-3 months` }] },
        { career: `Motion Graphics Designer`, school: { required: false, details: `A design or animation degree helps but isn't required.` }, certifications: [`Adobe Certified Professional: After Effects (optional)`], other: [`Demo reel`], steps: [{ step: `Learn After Effects and animation basics`, timeline: `3-6 months` }, { step: `Build a 1-minute demo reel`, timeline: `3-6 months` }] },
        { career: `Tattoo Artist`, school: { required: false, details: `No school; you learn through an apprenticeship.` }, certifications: [`Bloodborne pathogens certificate`, `Local tattoo license (varies by region)`], other: [`Tattoo design portfolio`, `Apprenticeship at a shop`], steps: [{ step: `Build a tattoo-style drawing portfolio`, timeline: `6 months` }, { step: `Find and complete an apprenticeship`, timeline: `1-3 years` }] },
        { career: `Front-End Web Developer`, school: { required: false, details: `A CS degree or bootcamp helps; self-taught is common.` }, certifications: [], other: [`Portfolio of websites`, `HTML, CSS, JavaScript`], steps: [{ step: `Learn HTML, CSS, JavaScript, then React`, timeline: `6-12 months` }, { step: `Build 3-5 portfolio sites and apply`, timeline: `3-6 months` }] },
        { career: `Storyboard Artist`, school: { required: false, details: `An animation or film degree helps but isn't required.` }, certifications: [], other: [`Storyboard portfolio showing sequences`], steps: [{ step: `Learn film language: shots, angles, pacing`, timeline: `3-6 months` }, { step: `Board short scenes and apply to studios`, timeline: `6-12 months` }] },
      ],
    })
  );

  // ===========================================================================
  // FINAL CHECK — same idea as the gate: make sure step 2 returned usable JSON,
  // with one plan per career and at least one step in each plan.
  // ===========================================================================
  let plans;
  try {
    plans = JSON.parse(step2Output).plans;
  } catch {
    console.error(`Step 2 did not return valid JSON:\n${step2Output}`);
    process.exit(1);
  }
  if (!Array.isArray(plans) || plans.length !== careers.length) {
    console.error(`Step 2 should return one plan per career (${careers.length}), got ${plans?.length ?? 0}.`);
    process.exit(1);
  }
  if (plans.some((p) => !Array.isArray(p.steps) || p.steps.length === 0)) {
    console.error(`Step 2 returned a plan with no steps.`);
    process.exit(1);
  }

  // The final result of the workflow: each career's reason (step 1) merged with its plan (step 2).
  // Both lists are in the same order, so career i of step 1 goes with plan i of step 2.
  const result = careers.map((c, i) => ({ ...c, ...plans[i] }));
  console.log(`STEP 2 — HOW TO GET THERE (JSON):`);
  console.log(JSON.stringify(result, null, 2));
}

main();
