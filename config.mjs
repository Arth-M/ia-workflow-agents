// =============================================================================
// CONFIG — only what SEVERAL workflows share: the SDK client, the default
// model, the career limits, the careers schema, and the one LLM-call helper.
// Settings used by a single workflow live at the top of that workflow's file.
// =============================================================================

// --- SETUP --------------------------------------------------------------------
// 1. npm install @anthropic-ai/sdk
// 2. Put your key in .env:  ANTHROPIC_API_KEY=sk-ant-...   (never in this file)
// 3. Run a workflow with:   node --env-file=.env <workflow file>.mjs
//    The SDK reads ANTHROPIC_API_KEY from the environment automatically.
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();
const MODEL = `claude-sonnet-5-5`; // default model for every call that doesn't name one

// Limits checked by the gates in code ("about 10" = accept 8 to 12).
const MIN_CAREERS = 8;
const MAX_CAREERS = 12;

// =============================================================================
// STRUCTURED OUTPUTS — the exact JSON shape each LLM step MUST return.
// The API enforces these schemas: the model can't reply with extra text or a
// wrong shape. Rules: every object needs `additionalProperties: false` and
// lists its fields in `required`. (No "exactly 10 items" rule is possible here,
// so the counts are still checked by the gates in code.)
// =============================================================================

// Careers: a list of job titles + why each fits the person.
const STEP1_SCHEMA = {
  type: `object`,
  properties: {
    careers: {
      type: `array`,
      items: {
        type: `object`,
        properties: {
          career: { type: `string` }, // job title
          reason: { type: `string` }, // why it fits this person
        },
        required: [`career`, `reason`],
        additionalProperties: false,
      },
    },
  },
  required: [`careers`],
  additionalProperties: false,
};

// The ONE helper we need: send a prompt + the JSON schema to follow, get JSON text back.
// `model` is optional: without it, the call uses MODEL.
async function callLLM(system, prompt, schema, model = MODEL) {
  // We stream (avoids HTTP timeouts on long outputs, like 10 detailed plans)
  // and give the model plenty of room with max_tokens.
  const response = await client.beta.messages
    .stream({
      model: model,
      max_tokens: 64000,
      system: system,                                            // the role/rules for this step
      messages: [{ role: `user`, content: prompt }],             // the actual input for this step
      output_config: { effort: `medium`, format: { type: `json_schema`, schema } }, // STRUCTURED OUTPUT: force this JSON shape
      // If the model's safety filter declines the request, the API retries it
      // on another model by itself instead of failing (that's why we use `client.beta`).
      // Haiku has no such fallback, so we only add it for the other models.
      ...(model !== `claude-haiku-5-5` && {
        betas: [`server-side-fallback-2026-07-01`],
        fallbacks: `default`,
      }),
    })
    .finalMessage();                                             // wait for the full answer

  // The schema is only guaranteed when the answer finished normally:
  // `max_tokens` = cut off mid-JSON, `refusal` = declined. Stop the workflow in both cases.
  if (response.stop_reason !== `end_turn`) {
    throw new Error(`LLM call stopped early: ${response.stop_reason}`);
  }
  return response.content.filter((b) => b.type === `text`).map((b) => b.text).join(``);
}

// Make all of this available to the workflow files: `import { ... } from "./config.mjs"`.
export {
  client, // the agent (single_agent.mjs) runs its own loop, so it needs the client directly
  MIN_CAREERS,
  MAX_CAREERS,
  STEP1_SCHEMA,
  callLLM,
};
