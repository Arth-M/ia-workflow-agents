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

// you can also use supervisor agents : meaning the orchestrator becomes an agent, and you use
// a meta orchestrator as a workflow

//there is also the dispatcher (or routing/triage/classifier-router) : uses a classifier model (like Jev) to
// dispatch tasks to specific agents. It is a multi agent version of the routing_workflow pattern
// can allow you to dispatch between larger (higher cost) or smaller models (smaller costs) depending on the task difficulty
// that the dispatcher will evaluate. If the dispatcher is not sure, let it have a way to
// ticket it to a human user to avoid bad routing to unsuitable models.
// here the agent dispatcher just fork to a specific agent and this second agent handles the
// task and give the answer

// so you could have an agent making a very specific plan, then a dispatcher
// routing every part of that plan to a specific agent

// evaluator-optimizer mutli agent system also known as reflection, self-refine or critic :
// need a stop condition : STOP CONDITION tangible and deterministic here is very very important
