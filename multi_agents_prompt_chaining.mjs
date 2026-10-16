// can also be called sequential multi agents, waterfall, pipeline, linear delegation etc

//  in multi agents system, the orchestrator is always a workflow : plain code that runs the agents in a
// FIXED ORDER, with GATES (safeguards) between agents calls. Agents never choose who goes next and under
// which conditions.

// other methods in multi agents system includes parallelization, etc (just as in workflow
// but this time instead of having only model calls in each step  you have agents calls to leave
// them access to choices and looping multiple times for each agent, usually a ReAct agent - or else -
// look at reAct_single_agent.mjs comments)

//  usually in multi agent parallelization it is good to use different models from different companies
// so that the pre train data are different and the results may vary a lot more, which gives
// a better distribution over the possible correct answers.

// The aggregator in parallelization is also usually ran by deterministic code only to avoid hallucinations and
// have all the responses from the differents models untouched before other analyses and decision making

// be AWARE that parallelization is EXPENSIVE
