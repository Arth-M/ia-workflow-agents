# IA workflows and agents

A hands-on practice project to learn how LLM systems are built with the Claude API: the classic **workflow patterns**, a **single ReAct agent**, and a **chatbot**, all solving the same small problem so they're easy to compare.

**The problem:** a person says what they like and dislike, and the system suggests about 10 career paths (or training paths) and explains how to get there (school, certifications, other requirements, steps with timelines).

Every file is plain JavaScript (ES modules, `.mjs`), heavily commented, and written to be read top to bottom.

## Workflow, agent or chatbot?

The difference is **who decides what happens next**:

| | Who drives | How many model calls | Output |
|---|---|---|---|
| **Workflow** | **the code**: fixed steps, with gates in between | always the same | JSON, read by code |
| **Agent** | **the model**: it picks its next action (tool) at each step | variable, decided by the model | JSON, checked by code |
| **Chatbot** | **the person**: they type, the model answers, repeat | as many as the person wants | text, read by a human |

A loop or a growing message history doesn't make something an agent: the evaluator-optimizer workflow and the chatbot have both. What makes it an agent is that the **model** chooses the actions, their order, how many there are, and when it's done. The more of these choices the model makes, the more "agentic" the system is.

## The files

| File | Pattern | What it does | Models |
|---|---|---|---|
| [`workflow_prompt_chaining.mjs`](workflow_prompt_chaining.mjs) | Prompt chaining | LLM call 1 picks ~10 careers → gate → LLM call 2 explains how to get to each one → check | Sonnet 5.5 |
| [`workflow_routing.mjs`](workflow_routing.mjs) | Routing | Asks "career or training?", then runs only that branch, each with its own prompt and schema | Sonnet 5.5 |
| [`workflow_parallelization.mjs`](workflow_parallelization.mjs) | Parallelization (voting) | The same question goes to 3 models at once; a 4th call synthesizes their answers into top careers, agreements, disagreements and a reconciled answer | Opus 5.5, Sonnet 5.5, Haiku 5.5 → Haiku 5.5 |
| [`workflow_evaluator_optimizer.mjs`](workflow_evaluator_optimizer.mjs) | Evaluator-optimizer | A generator grades each career and estimates how long it takes; code checks the numbers, an LLM checks they're realistic; the generator retries (without knowing the criteria) until it passes or hits the limit | Opus 5.5 (generator), Haiku 5.5 (evaluator) |
| [`reAct_single_agent.mjs`](reAct_single_agent.mjs) | Single ReAct agent | Same job as prompt chaining, but the model decides its steps: it thinks, acts with a tool, reads the result, and repeats. Tools: `web_search`, `ask_user`, `submit_career_plan` | Sonnet 5.5 |
| [`chatbot.mjs`](chatbot.mjs) | Chatbot | A career counselor you chat with in the terminal; streamed answers and prompt caching | Sonnet 5.5 |
| [`config.mjs`](config.mjs) | Shared setup | The SDK client, the default model, the career limits, the careers schema and `callLLM` (the helper the workflows use) | |
| [`multi_agents_prompt_chaining.mjs`](multi_agents_prompt_chaining.mjs) | Notes | Notes on multi-agent systems (sequential, parallel, supervisor, dispatcher, evaluator-optimizer, peer-to-peer) and metrics | |

Settings used by a single file (its models, limits and schemas) live at the top of that file; `config.mjs` only holds what several files share.

## Setup

You need Node.js 20.6 or later (for `--env-file`) and an Anthropic API key.

1. Install the SDK:
   ```bash
   npm install
   ```
2. Create a `.env` file at the root of the project with your key (it's already in `.gitignore`):
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
   Keys are created at [console.anthropic.com](https://console.anthropic.com). The API is billed separately from a Claude Pro/Max subscription, with prepaid credits.

## Running

Each file asks its questions in the terminal:

```bash
node --env-file=.env workflow_prompt_chaining.mjs
node --env-file=.env workflow_routing.mjs
node --env-file=.env workflow_parallelization.mjs
node --env-file=.env workflow_evaluator_optimizer.mjs
node --env-file=.env reAct_single_agent.mjs
node --env-file=.env chatbot.mjs        # type "exit" to quit
```

## What the code shows

- **Gates:** plain code checks between steps (empty input, wrong number of careers, missing fields). When a step produces garbage, the run stops there instead of feeding it to the next call.
- **Structured outputs:** each workflow step passes a JSON schema to the API (`output_config.format`), so the model can only reply in that exact shape.
- **Streaming:** long answers are streamed to avoid HTTP timeouts. The chatbot also prints the text as it arrives.
- **Prompt caching** (chatbot): the part of the conversation already sent is re-read from a cache at about 10% of the price. Writing it the first time costs about 125%, so it pays off from the second call. Nothing under 512 tokens is cached, and the cache expires after 5 minutes without a call.
- **Refusal fallback:** if the safety filter declines a request, the API retries it on another model by itself (`fallbacks: "default"`). Haiku has no such fallback, so it's skipped there.
- **Agent safeguards:** the agent stops after 10 model calls, makes at most 5 web searches, and its final answer is checked by code. If the check fails, the agent reads the error and fixes its answer.

## Cost

Every run makes real, paid API calls:

- **Prompt chaining and routing:** 2 calls and 1 call.
- **Parallelization:** 4 calls, 1 of them on Opus. The most expensive workflow.
- **Evaluator-optimizer:** 1 to 6 calls, depending on how many tries the generator needs.
- **Agent:** usually 2 to 4 calls plus web searches, up to 10 calls. Each call resends the whole conversation, search results included.
- **Chatbot:** 1 call per message. Each call costs a bit more than the previous one as the conversation grows, which is what the prompt caching offsets.

To spend less while experimenting, switch a model to `claude-haiku-5-5` or lower the `effort` in `config.mjs`.
