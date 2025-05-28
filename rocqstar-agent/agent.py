import asyncio
import json
import logging
from logging.handlers import RotatingFileHandler
from typing import Any, List, TypedDict, Literal, Optional, Dict, Callable
from datetime import datetime

from ideformer.agents.coqpilot_agent.planning.simple import simple_plan_generation
import structlog
from langchain_core.messages import HumanMessage, SystemMessage, AIMessage, BaseMessage
from langchain_core.tools import BaseTool
from langgraph.graph import START, StateGraph, END
from langgraph.prebuilt import ToolNode
from langchain_core.messages import ToolMessage

from grazie_langchain_utils.language_models.grazie import ChatGrazie
from ideformer.agents.coqpilot_agent.coq_project_client import CoqProjectClient
from ideformer.agents.coqpilot_agent.prompt import execution_system_prompt
from ideformer.agents.coqpilot_agent.protocol import (
    CoqPilotGeneralMessageE2SContent,
    CoqPilotGeneralMessageS2EContent, CoqPilotGeneralMessageE2SConfig
)
from ideformer.core.agent import IdeFormerAgent, S2EContentT
from .mcp_client import McpHttpClient
from .tools import McpCoqTool, McpCoqToolProvider
from .planning.mad import multi_agent_proof_debate
from ...core.protocol.types import ALLOWED_ARG_TYPES

# Global configuration for logging
TIMESTAMP = datetime.now().strftime("%Y%m%d_%H%M%S")
LOG_FILE_PATH = f"coqpilot_agent_{TIMESTAMP}.log"
MAX_LOG_SIZE_MB = 10
MAX_LOG_FILES = 5

# Configure file handler
file_handler = RotatingFileHandler(
    LOG_FILE_PATH,
    maxBytes=MAX_LOG_SIZE_MB * 1024 * 1024,
    backupCount=MAX_LOG_FILES
)

# Configure structlog
structlog.configure(
    processors=[
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.format_exc_info,
        structlog.processors.JSONRenderer()
    ],
    logger_factory=structlog.stdlib.LoggerFactory(),
    wrapper_class=structlog.stdlib.BoundLogger,
    cache_logger_on_first_use=True,
)

# Get logger with file handler
logger = structlog.get_logger()
logger.addHandler(file_handler)
logger.setLevel(logging.INFO)

MAX_RAW = 60
TAIL_SIZE = 20


class CoqPilotGeneralAgent(IdeFormerAgent[CoqPilotGeneralMessageE2SContent, CoqPilotGeneralMessageS2EContent]):
    """
    An autonomous Coq‐proof‐generation agent structured as a state machine.

    Orchestrates:
      - Session initialization with CoqProjectClient
      - Strategy (plan) generation & ranking
      - Iterative execution, critique, replanning, and summarization
      - Tool invocations via MCP server

    :cvar tools:             List of available BaseTool instances for Coq interaction.
    :cvar executor:          ChatGrazie instance driving tactic execution.
    :cvar critic:            ChatGrazie instance for proof‐progress critique.
    :cvar replanner:         ChatGrazie instance for refining failing strategies.
    :cvar plan_ranker:       ChatGrazie instance for scoring candidate plans.
    :cvar proof_progress_summarizer: ChatGrazie for collapsing long histories.
    :cvar plan_failure_summarizer:   ChatGrazie for explaining failed runs.
    :cvar similar_theorems_analyzer: ChatGrazie for mining analogous proofs.
    :cvar coq_project_client: CoqProjectClient managing Coq RPC sessions.
    :cvar config:            Parsed agent configuration from the system message.
    """
    tools: List[BaseTool]
    executor: ChatGrazie
    replanner: ChatGrazie
    critic: ChatGrazie
    proof_progress_summarizer: ChatGrazie
    plan_ranker: ChatGrazie
    plan_failure_summarizer: ChatGrazie
    similar_theorems_analyzer: ChatGrazie
    coq_project_client: CoqProjectClient
    max_tool_iterations_per_plan_number: int
    max_raw_messages_number: int
    tool_summary: str
    config: CoqPilotGeneralMessageE2SConfig

    class CoqPilotGeneralState(TypedDict):
        """
        TypedDict schema for agent state.

        Attributes:
            messages: Conversation history messages
            proof_version_hash: Current proof version identifier
            is_proof_finished: Whether proof is complete
            chat_iterations: Number of LLM interactions
            tool_calling_iterations: Count of tool calls
            tool_name: Last invoked tool name
            tool_args: Arguments of last tool call
            last_tool: Last tool identifier
            summary: Summarized conversation prefix
            plans: Candidate proof strategies
            plan_scores: Scores assigned to each plan
            plans_to_try: Top plans selected for execution
            current_plan_index: Index of active plan
            coq_session_id: Coq project session ID
            plan_fix_is_needed: Flag for replanning necessity
            current_goals: JSON-encoded current proof goals
            source_target_file_path: Path to the Coq file
            failed_proof_checks: Consecutive failed proof verifications
            finished_proof: Completed proof script
            theorem_statement: Statement of target theorem
        """
        messages: List[BaseMessage]
        proof_version_hash: str
        is_proof_finished: bool
        chat_iterations: int
        tool_calling_iterations: int
        tool_name: str
        tool_args: dict[str, Any]
        last_tool: str
        summary: str
        plans: List[str]
        plan_scores: Dict[str, float]
        plans_to_try: List[str]
        current_plan_index: int
        coq_session_id: str
        plan_fix_is_needed: bool
        current_goals: str
        source_target_file_path: str
        failed_proof_checks: int
        finished_proof: str
        theorem_statement: str

    async def init(self, _: CoqPilotGeneralState):
        """
        Initialize the agent: start a Coq session, fetch theorem, load tools, instantiate LLMs,
        and generate initial proof strategies.

        :param _:          Empty or placeholder state to be populated.
        :returns:          Fully populated initial state dict.
        """
        logger.info("Initializing agent")

        initial_message = await self.initial_message()
        self.config = initial_message.config

        logger.info(f"Config: {self.config}")

        theorem_name, file_path = map(lambda x: f"{x}", initial_message.message.split(" "))

        self.coq_project_client = CoqProjectClient(
            'http://localhost:8000/rest/document'
        )

        start_session_response = self.coq_project_client.start_session(file_path, theorem_name)
        coq_session_id = start_session_response['sessionId']
        proof_hash = start_session_response['proofVersionHash']
        logger.info(f"Started session with ID: {coq_session_id} and proof version hash: {proof_hash}")

        mcp_client = McpHttpClient('http://localhost:3001/mcp', coq_session_id)
        mcp_client.proof_version_hash = proof_hash  # Set initial proof version hash
        session_theorem_response = self.coq_project_client.get_session_theorem(coq_session_id, proof_hash)
        theorem_statement = session_theorem_response['theoremStatement']

        logger.info("Dynamically obtaining tools from client")
        self.tools = await self.get_tools(McpCoqToolProvider(mcp_client))
        logger.info("Tools obtained")
        logger.info("Tools", tools=self.tools)

        self.tool_summary = "\n".join(f"- {t.name}: {t.description}" for t in self.tools)

        # Initialize LLMs with configs
        self.executor = self.get_chat(self.config.proof_flow_config.executor_llm_config, self.tools)
        self.critic = self.get_chat(self.config.proof_flow_config.proof_progress_critic_llm_config, self.tools)
        self.plan_ranker = self.get_chat(self.config.planning_config.plan_ranker_llm_config, self.tools)
        self.plan_failure_summarizer = self.get_chat(self.config.proof_flow_config.plan_failure_summarizer_llm_config,
                                                     self.tools)
        self.similar_theorems_analyzer = self.get_chat(
            self.config.proof_flow_config.similar_theorems_analyzer_llm_config, self.tools)
        self.replanner = self.get_chat(self.config.proof_flow_config.replanner_llm_config, self.tools)
        self.proof_progress_summarizer = self.get_chat(self.config.proof_flow_config.summarizer_llm_config, self.tools)

        # Generate plans based on planning mode
        plans_res = []
        if self.config.planning_config.mode == "mad":
            plans_res = await asyncio.gather(*[
                multi_agent_proof_debate(theorem_statement,
                                         self.tools,
                                         self.config.planning_config.mad_planning_config,
                                         logger,
                                         thread_id=f"p{i}")
                for i in range(self.config.planning_config.plan_samples_number)
            ])
        elif self.config.planning_config.mode == "simple":
            plans_res = await asyncio.gather(*[
                simple_plan_generation(theorem_statement,
                                       self.tools,
                                       self.config.planning_config.simple_planning_config)
                for _ in range(self.config.planning_config.plan_samples_number)
            ])

        plans = [p['final_plan'] for p in plans_res]
        messages = [
            SystemMessage(content=execution_system_prompt.format(theorem_name=theorem_name, file_path=file_path)),
            HumanMessage(
                content=f"Theorem to prove: {theorem_statement} in file: {file_path}")
        ]

        return {
            "messages": messages,
            "proof_version_hash": proof_hash,
            "is_proof_finished": False,
            "chat_iterations": 0,
            "tool_calling_iterations": 0,
            "tool_name": "init",
            "tool_args": {},
            "tool_calls_since_analysis": 0,
            "summary": "",
            "plans": plans,
            "plan_scores": {},
            'plans_to_try': [],
            'current_plan_index': 0,
            'coq_session_id': coq_session_id,
            "plan_fix_is_needed": False,
            "current_goals": "",
            "source_target_file_path": file_path,
            "failed_proof_checks": 0,
            "theorem_statement": theorem_statement,
        }

    async def score_plans(self, state: CoqPilotGeneralState):
        """
        Rate each generated strategy by invoking the plan_ranker LLM and select top candidates.

        :param state:      Current agent state, including `state['plans']`.
        :returns:          Updated state with `plan_scores` and `plans_to_try`.
        """
        scores: Dict[str, int] = {}
        theorem_statement = \
            self.coq_project_client.get_session_theorem(state['coq_session_id'], state['proof_version_hash'])[
                'theoremStatement']
        if len(state['plans']) == 1:
            state['plan_scores'] = {state['plans'][0]: 10}
            state['plans_to_try'] = [state['plans'][0]]
            logger.info("Only one plan, scoring it as 10")
            return state

        for plan in state['plans']:
            logger.info("Rating plan", plan=plan)
            prompt = [
                SystemMessage(content=(
                    "You are a plan evaluator for Coq proof strategies."
                    " You will get a theorem and one candidate plan."
                    " Rate its chance of success from 1 (low) to 10 (high)."
                    " Output **only** valid JSON:"
                    ' {{"reason":"...", "score":<integer>}}'
                )),
                HumanMessage(content=(
                    f"Theorem: {theorem_statement}\n"
                    f"Plan: {plan}\n\n"
                    "Respond with exactly: {{\"reason\":\"...\", \"score\":<1–10>}}"
                ))
            ]
            resp = await self.plan_ranker.ainvoke(prompt)
            logger.info("Plan ranker response", resp=resp.content)
            try:
                scores[plan] = json.loads(resp.content)['score']
            except json.JSONDecodeError:
                logger.info("No score found for plan", plan=plan)
                scores[plan] = 5
        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        state['plan_scores'] = scores
        state['plans_to_try'] = [p for p, _ in ranked[:self.config.planning_config.best_plan_samples_number]]
        logger.info("Scored and ranked plans", plan_scores=scores)
        return state

    async def plan_loop(self, state: CoqPilotGeneralState):
        """
        Sequentially execute each top‐ranked strategy until one succeeds or all fail.

        :param state:      State containing `plans_to_try` and other metadata.
        :returns:          State marked `is_proof_finished=True` on success, or left false.
        """
        state['current_goals'] = json.dumps(
            self.coq_project_client.check_proof("Proof.\nQed.", state['coq_session_id'], state['proof_version_hash'])[
                'goals'])
        for idx, plan in enumerate(state['plans_to_try']):
            state['current_plan_index'] = idx
            if idx + 1 > self.config.planning_config.best_plan_samples_number:
                break
            logger.info("Executing plan", index=idx, plan=plan)
            success, history, finished_proof = await self.execute_single_plan(plan, state['summary'], state)
            if success:
                state['messages'] = history
                state['is_proof_finished'] = True
                state['finished_proof'] = finished_proof
                return state
            # summarize failure
            state['summary'] = await self.summarize_plan_failure(history)
            state['tool_calling_iterations'] = 0
            logger.info("Plan failed, summary for next", summary=state['summary'])
        # all plans tried without success
        state['is_proof_finished'] = False
        return state

    def format_check_proof_response(self, response_data: dict, state: CoqPilotGeneralState):
        """
        Interpret a `check_proof` tool's JSON result and convert it to natural language,
        updating goal state and success flags.

        :param response_data:  Raw JSON dict from MCP `check_proof`.
        :param state:          Mutable agent state to update goals and flags.
        :returns:              Tuple of (message_text, was_error, updated_state).
        """

        is_success = response_data["success"]
        has_error = response_data.get("error", False)
        if not is_success:
            if not has_error:
                state["current_goals"] = json.dumps(response_data["goals"])
                logger.info("current goals", state=state["current_goals"])
                return f"Unfortunately, the last proof you checked is not valid:\n{response_data['attemptedProof']}" + \
                       f"\nIt fails with the error: {response_data['message']}" + \
                       f"\nBut it has a valid prefix {response_data['validPrefix']}" + \
                       f"\nThe goals after this prefix are {response_data['goals']}" + \
                       f"\nPlease continue to prove the theorem taking the valid prefix into account", True, state
            if has_error:
                return f"I couldn't check the last proof you sent. I got {has_error} Please try again to check proof but avoid using admits and non-obligatory goal focusing.", False, state

        if is_success and response_data["message"] == "Proof is incomplete but valid so far":
            proof = response_data["proof"]
            state['current_goals'] = json.dumps(response_data["goals"])
            return f"The proof you just checked has no errors but is incomplete:\n{proof}" + \
                   f"\nThe current goals are {response_data['goals']}" + \
                   f"\nPlease continue to prove the theorem taking the valid prefix into account", False, state

        if is_success and str(response_data["message"]).startswith("Your proof is incomplete but valid so far. It has the following goal at the depth"):
            proof = response_data["proof"]
            state['current_goals'] = json.dumps(response_data["goals"])
            return f"The proof you just checked has no errors but is incomplete:\n{proof}" + \
                   f"\nYou have successfully proved the current branch but there are goals in another branch. {response_data['goals']}" + \
                   f"\nPlease continue to prove the theorem taking the valid prefix into account", False, state


        if is_success and response_data["message"] == "Proof complete and valid":
            return f"Proof is complete", False, state

    async def execute_single_plan(self, plan: str, summary: str, parent_state: CoqPilotGeneralState):
        """
        Run the executor subgraph on a single strategy, including fetching similar proofs.

        :param plan:           Natural-language strategy to follow.
        :param summary:        Summary of previous failures or progress.
        :param parent_state:   Agent state before execution.
        :returns:              (success_flag, full_message_history, finished_proof_text)
        """

        sub_state = parent_state.copy()
        sub_state["messages"] = [
            SystemMessage(content=execution_system_prompt),
            HumanMessage(
                content=f"Theorem to prove: {parent_state['theorem_statement']} in file {parent_state['source_target_file_path']}"),
        ]
        similar_proofs = await self.get_complete_similar_theorems(sub_state)
        if summary:
            sub_state['messages'].append(SystemMessage(content="Summary:\n" + summary +
                                                               "\nContinue theorem proving."))
        sub_state['messages'].append(
            HumanMessage(content=f"You should prove the theorem. Here is the plan you should follow. Plan:\n{plan}.\n"
                                 f"Here are the theorems whose proofs can be similar to the target proof:\n" + '\n\n'.join(
                similar_proofs)))

        executor_graph = self.build_executor_subgraph()
        final = await executor_graph(sub_state)
        return final['is_proof_finished'], final['messages'], final["finished_proof"]

    async def summarize_plan_failure(self, history: List[Any]) -> str:
        """
        Ask the plan_failure_summarizer LLM to bullet-point why a plan run failed.

        :param history:       Complete message history of the failed run.
        :returns:             Concise summary (6-8 bullets) of failure causes.
        """
        valid_messages = []
        number_of_system_messages = 0
        for m in history:
            if isinstance(m, SystemMessage):
                number_of_system_messages += 1
            if number_of_system_messages > 1:
                number_of_system_messages -= 1
                valid_messages.append(HumanMessage(content=f"System message: {m.content}"))
            else:
                valid_messages.append(m)
        prompt = valid_messages + [HumanMessage(content=(
            "Summarize **why** the proof attempt failed, in 6-8 concise bullet points."
        ))]
        logger.info("Summarizing plan")
        resp = await self.plan_failure_summarizer.ainvoke(prompt)
        return resp.content.strip()

    async def do_call_llm(self, state: CoqPilotGeneralState):
        """
        Invoke the executor LLM with the current context (messages + summary).

        :param state:         Current agent state with messages & summary.
        :returns:             Updated state with the LLM's next message appended.
        """
        messages = state["messages"]
        summary = state["summary"]

        context: List[BaseMessage] = []
        if summary:
            context.append(
                HumanMessage(content="Conversation summary so far:\n" + summary)
            )
        context.extend(messages)
        next_message = await self.executor.ainvoke(context)
        logger.info("Received next message from LLM", next_message=next_message)

        state["messages"] = context + [next_message]
        state["summary"] = ""
        return state

    def create_request_content(
            self, tool_name: str, tool_args: dict[str, ALLOWED_ARG_TYPES], metadata: Optional[Dict[str, Any]] = None
    ) -> S2EContentT:
        """
        Package a tool-call request into the S2E protocol format.

        :param tool_name:     Name of the tool to call.
        :param tool_args:     Arguments for that tool.
        :param metadata:      (Optional) Extra metadata to attach.
        :returns:             A `CoqPilotGeneralMessageS2EContent` object.
        """
        if not isinstance(tool_args, dict):
            tool_args = {}
        return CoqPilotGeneralMessageS2EContent.by_tool_call(
            tool_name=tool_name,
            tool_args=tool_args
        )

    async def do_call_tool(self, state: CoqPilotGeneralState):
        """
        Execute the first pending tool call in the last AIMessage via MCP.

        :param state:         Agent state whose last message contains a tool call.
        :returns:             New state updated with the tool's response messages.
        """
        messages = state["messages"]
        last_message = messages[-1]
        if not isinstance(last_message, AIMessage):
            raise ValueError(f"Unexpected message type for calling tools: expected 'ai', got {last_message.type}")

        if not last_message.tool_calls:
            return state

        tool_call = last_message.tool_calls[0]
        tool_name = tool_call["name"]
        tool_args = tool_call["args"]

        logger.info("Calling tool", tool_name=tool_name, tool_args=tool_args)

        single_tool_message = AIMessage(content="", tool_calls=[tool_call])
        messages[-1] = single_tool_message

        tool_node = ToolNode(self.tools, handle_tool_errors=True, messages_key="messages")
        tool_message = await tool_node.ainvoke(state)

        logger.info("Tool response", response_type=type(tool_message).__name__, response=tool_message)

        # Process tool responses
        unsuccessful_attempt = False
        for msg in tool_message["messages"]:
            if isinstance(msg, ToolMessage):
                try:
                    response_data = json.loads(msg.content)
                    if tool_name == "check_proof":
                        msg.content, unsuccessful_attempt, state = self.format_check_proof_response(response_data,
                                                                                                    state)

                        if unsuccessful_attempt:
                            state["failed_proof_checks"] += 1
                        else:
                            state["failed_proof_checks"] = 0

                        if (response_data.get("success") and
                                not response_data.get("goals") and
                                response_data.get("message") != "Proof is incomplete but valid so far"):
                            state["is_proof_finished"] = True
                            state["finished_proof"] = response_data.get("proof")
                            logger.info("Proof completed successfully", proof=response_data.get("proof"))

                        if "hash" in response_data:
                            new_hash = response_data["hash"]
                            if new_hash != state["proof_version_hash"]:
                                state["proof_version_hash"] = new_hash
                                for tool in self.tools:
                                    if isinstance(tool, McpCoqTool):
                                        tool._client.proof_version_hash = new_hash
                except json.JSONDecodeError:
                    pass

        state["messages"].extend(tool_message["messages"])
        tool_calling_iterations = state["tool_calling_iterations"] + len(tool_message["messages"])
        logger.info("Tool calling iterations", current=tool_calling_iterations, max=20)

        return {
            "messages": state["messages"],
            "proof_version_hash": state["proof_version_hash"],
            "is_proof_finished": state["is_proof_finished"],
            "tool_calling_iterations": tool_calling_iterations,
            "tool_name": tool_name,
            "tool_args": tool_args,
            "last_tool": tool_name,
            "summary": state.get("summary", ""),
            "plans": state.get("plans", []),
            "plan_scores": state.get("plan_scores", {}),
            "plans_to_try": state.get("plans_to_try", []),
            "current_plan_index": state.get("current_plan_index", 0),
            "coq_session_id": state.get("coq_session_id", ""),
            "plan_fix_is_needed": unsuccessful_attempt,
            "current_goals": state.get("current_goals", ""),
            "failed_proof_checks": state.get("failed_proof_checks", 0),
            "finished_proof": state.get("finished_proof", ""),
            "theorem_statement": state.get("theorem_statement", ""),
        }

    async def critique(self, state: CoqPilotGeneralState):
        """
       Invoke the critic LLM after repeated failures to highlight plan deviations and improvements.

       :param state:         State including last plan and tool summary.
       :returns:             State with a "[Critic]: ..." message appended.
       """
        messages = state['messages']
        logger.info("Invoking critique agent", last_tool=state['last_tool'], hash=state['proof_version_hash'])
        crit_prompt = [HumanMessage(content=(
            f"Critique the last actions under overall plan:\n{state['plans_to_try'][state['current_plan_index']]}\n"
            "Highlight deviations and suggest improvements. Think about what context should be gathered to prove the theorem. Remember you have access to other files and theorems. If you propose to use specific tool write its name as `tool_name`. Propose to continue by applying tactic by tactic when you think it is useful."
            "Here is the description of the tools:\n"
            f"{self.tool_summary}"
            "Do NOT CALL TOOLS."))]
        crit_msg = await self.critic.ainvoke(messages + crit_prompt)
        logger.info("Critic response received", critic_response=crit_msg.content)
        messages.append(AIMessage(content=f"[Critic]: {crit_msg.content}"))
        return state

    async def replan(self, state: CoqPilotGeneralState):
        """
        Call the replanner LLM to refine the current strategy based on critic feedback.

        :param state:         State containing the critique and current plan.
        :returns:             State with the updated plan in `plans_to_try`.
        """
        messages = state['messages']
        replan_prompt = [HumanMessage(content=(
            f"Refine the proof plan:\n{state['plans_to_try'][state['current_plan_index']]}\n using the critique above and similar-proof insights. Pay attention to what tools are proposed to be called. Here is the description of the tools:\n{self.tool_summary}"
            " Output **only** the updated plan in clear natural language."))]
        plan_msg = await self.replanner.ainvoke(messages + replan_prompt)
        new_plan = plan_msg.content.strip()
        logger.info("Replan response received", new_plan=new_plan)
        state['plans_to_try'][state['current_plan_index']] = new_plan
        messages.append(
            HumanMessage(content=f"I have refined the plan based on the current proof progress: {new_plan}\n"
                                 "Now continue with following this plan and calling tools"))
        state["failed_proof_checks"] = 0

        return state

    async def summarize(self, state: CoqPilotGeneralState):
        """
        Collapse long chat histories into a bullet-point summary, preserving the last TAIL_SIZE messages.

        :param state:         Current state with potentially lengthy `state['messages']`.
        :returns:             State with `state['summary']` updated and trimmed message list.
        """
        raw = state["messages"]
        to_summarize = []

        for msg in raw:
            if len(to_summarize) < len(raw) - TAIL_SIZE:
                to_summarize.append(msg)
                continue
            elif len(to_summarize) >= len(raw) - TAIL_SIZE:
                last_msg = to_summarize[-1]
                pre_last_msg = to_summarize[-2]
                if not (isinstance(last_msg, ToolMessage) and pre_last_msg.type == 'tool_call'):
                    to_summarize.append(msg)
                else:
                    break

        remaining = raw[len(to_summarize):]

        assert to_summarize + remaining == raw

        prompt = [
            HumanMessage(content=(
                    "Please produce a concise bullet-point summary "
                    "of the proof progress so far (4-5) bullet points:\n\n"
                    + "\n".join(m.content for m in to_summarize) + "DO NOT CALL TOOLS."
            ))
        ]
        logger.info("Summarizing conversation so far")
        summary_msg = await self.proof_progress_summarizer.ainvoke(prompt)
        new_summary = summary_msg.content

        # update state
        state["summary"] = new_summary
        state["messages"] = remaining

        return state

    async def get_complete_similar_theorems(self, state: CoqPilotGeneralState):
        """
        Fetch and return full statements+proofs of theorems whose premises match current goals.

        :param state:         State with `state['current_goals']` JSON-encoded list of goals.
        :returns:             List of "statement\nproof" strings for each similar theorem.
        """
        logger.info("Getting similar proofs state")
        goals = state["current_goals"]
        goals_list = json.loads(goals)
        logger.info("Current goals", goals=goals)

        theorem_names = []
        for goal in goals_list:
            if isinstance(goal, str):
                goal_json = goal
            elif isinstance(goal, dict):
                goal_json = json.dumps(goal)
            else:
                logger.warning(f"Unexpected goal type: {type(goal)}", goal=goal)
                continue

            premises = self.coq_project_client.get_premises(
                goal_json,
                state["source_target_file_path"],
                state["coq_session_id"]
            ).get("premises", [])
            theorem_names.extend(premises)

        complete_similar_theorems = []
        for theorem_name in theorem_names:
            complete_theorem = self.coq_project_client.get_theorem(
                state["source_target_file_path"],
                theorem_name,
                state["coq_session_id"],
                state["proof_version_hash"]
            )
            statement = complete_theorem.get("theoremStatement", "")
            proof = complete_theorem.get("theoremProof", "")
            complete_similar_theorems.append(statement + "\n" + proof)

        return complete_similar_theorems

    async def get_similar_proofs_from_target_file(self, state: CoqPilotGeneralState):
        """
        After a check_proof, gather analogous proofs and append them to `state['messages']`.

        :param state:         State with updated `current_goals`.
        :returns:             State with two new messages: the prompt and the LLM's response.
        """
        complete_similar_theorems = await self.get_complete_similar_theorems(state)

        logger.info("Complete similar theorems", complete_similar_theorems=complete_similar_theorems)

        current_theorem_state = self.coq_project_client.get_session_theorem(
            state["coq_session_id"],
            state["proof_version_hash"]
        )

        prompt = HumanMessage(content=(
                f"The current theorem state is {current_theorem_state}\n"
                + "List tactics, ideas, theorems and proof parts you can borrow to advance our proof."
                + "(Do not call any tools.)"
                + "Here are some similar proofs to the goal of after valid proof prefix:\n\n"
                + "\n\n".join(reversed(complete_similar_theorems)) + "\n\n"
        ))
        similar_proofs_msg = await self.similar_theorems_analyzer.ainvoke([prompt])

        logger.info("Complete similar theorems response", similar_proofs_msg=similar_proofs_msg.content)

        state["messages"].extend([prompt, similar_proofs_msg])

        return state

    def should_continue(self, state: CoqPilotGeneralState) -> Literal[
        "early_stopping", "call_llm", "call_tool", "critique", "replan", "summarize"]:
        """
        Decide the next FSM transition based on failure counts, message length, and last tool.

        :param state:         Current agent state.
        :returns:             Next action name for the executor subgraph.
        """
        if state['is_proof_finished'] or state['tool_calling_iterations'] >= 20:
            return 'early_stopping'
        if state['last_tool'] == 'check_proof' and state['failed_proof_checks'] >= 5:
            return 'critique'
        if len(state["messages"]) > MAX_RAW:
            return "summarize"
        if state['messages'] and state['messages'][-1].content.startswith('[Critic]'):
            return 'replan'
        last = state['messages'][-1]
        if isinstance(last, AIMessage) and last.tool_calls:
            return 'call_tool'
        return 'call_llm'

    @staticmethod
    async def early_stopping(state: CoqPilotGeneralState):
        """
       Finalize the run: append a completion message and end the FSM.

       :param state:         State with `is_proof_finished` flag.
       :returns:             A partial state dict signifying termination.
       """
        messages = state["messages"]
        if state["is_proof_finished"]:
            messages.append(AIMessage(content="Proof completed successfully!"))
        else:
            messages.append(AIMessage(content="Agent stopped due to max iterations."))
        return {
            "messages": messages,
            "proof_version_hash": state["proof_version_hash"],
            "is_proof_finished": state["is_proof_finished"],
            "tool_name": "early_stopping",
            "tool_args": {"reason": "proof_completed" if state["is_proof_finished"] else "max_iterations"}
        }

    async def get_graph(self) -> StateGraph:
        """
        Build the high-level FSM graph linking init → score_plans → plan_loop → early_stopping.

        :returns:             Compiled StateGraph object.
        """
        graph = StateGraph(CoqPilotGeneralAgent.CoqPilotGeneralState)
        graph.add_node('init', self.init)
        graph.add_node('score_plans', self.score_plans)
        graph.add_node('plan_loop', self.plan_loop)
        graph.add_node('early_stopping', self.early_stopping)
        graph.add_edge(START, 'init')
        graph.add_edge('init', 'score_plans')
        graph.add_edge('score_plans', 'plan_loop')
        graph.add_edge('plan_loop', 'early_stopping')
        return graph

    @staticmethod
    async def should_call_tool(state: CoqPilotGeneralState) -> Literal["call_tool", "__end__"]:
        """
        Within the executor subgraph, decide if the last AI message contains tool_calls.

        :param state:         State whose last message is checked.
        :returns:             `"call_tool"` if a tool is pending, else `END`.
        """
        messages = state["messages"]
        last_message = messages[-1]
        if not isinstance(last_message, AIMessage):
            raise ValueError(f"Unexpected message type for calling tools: expected 'ai', got {last_message.type}")
        if last_message.tool_calls:
            tool_name = last_message.tool_calls[0]["name"]
            logger.info("Will call tool", tool_name=tool_name)
            return "call_tool"
        else:
            return END

    def build_executor_subgraph(self) -> Callable:
        """
         Compile and return the single-plan executor subgraph function.

         This subgraph wires `call_llm`, `should_call_tool`, `call_tool`, `should_continue`,
         `critique` → `fetch_similar` → `replan`, `summarize`, and `early_stopping`.

         :returns:             Async function taking `initial_state` dict → final state.
         """
        subgraph = StateGraph(self.CoqPilotGeneralState)

        subgraph.add_node("call_llm", self.do_call_llm)
        subgraph.add_node("call_tool", self.do_call_tool)
        subgraph.add_node("critique", self.critique)
        subgraph.add_node("replan", self.replan)
        subgraph.add_node("summarize", self.summarize)
        subgraph.add_node("early_stopping", self.early_stopping)
        subgraph.add_node("fetch_similar", self.get_similar_proofs_from_target_file)

        subgraph.add_edge(START, "call_llm")
        subgraph.add_conditional_edges("call_llm", self.should_call_tool)
        subgraph.add_conditional_edges("call_tool", self.should_continue)
        subgraph.add_edge("critique", "fetch_similar")
        subgraph.add_edge("fetch_similar", "replan")
        subgraph.add_edge("replan", "call_llm")
        subgraph.add_edge("summarize", "call_llm")
        subgraph.add_edge("early_stopping", END)

        compiled = subgraph.compile()

        async def execute_subgraph(initial_state: dict):
            return await compiled.ainvoke(initial_state, {"recursion_limit": 10000})

        return execute_subgraph

    async def run(self):
        """
       Entry point: compile the high-level FSM and invoke it from an empty initial state.

       :returns:             Final agent state after termination.
       """
        graph = await self.get_graph()
        compiled_graph = graph.compile()

        initial_state = CoqPilotGeneralAgent.CoqPilotGeneralState(
            messages=[],
            proof_version_hash="",
            chat_iterations=0,
            tool_calling_iterations=0,
            tool_name="init",
            tool_args={},
            is_proof_finished=False,
            last_tool='',
            summary='',
            plans=[],
            plan_scores={},
            plans_to_try=[],
            current_plan_index=0,
            current_goals="",
        )
        logger.info("Starting agent")
        final_state = await compiled_graph.ainvoke(initial_state, {"recursion_limit": 10000})
        logger.info("Agent finished")
        if isinstance(final_state, dict) and final_state.get("type") == "TERMINATION":
            final_state = final_state["content"]

        return final_state
