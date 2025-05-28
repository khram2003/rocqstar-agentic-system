import json
from typing import List, Dict, Any

from ideformer.core.protocol.config.chat.grazie import GrazieConfig
from langchain_core.messages import SystemMessage, AIMessage, BaseMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import StateGraph, END, MessagesState

from grazie_langchain_utils.language_models.grazie import ChatGrazie
from ..tools import McpCoqTool
from ..protocol import MadPlanningConfig


class MADState(MessagesState):
    """
    State schema for the multi‐agent proof debate.

    :ivar theorem:         The target theorem string.
    :ivar round:           Current round index (starts at 0).
    :ivar winner:          Winning debater identifier ('A' or 'B'), or None until judged.
    :ivar final_plan:      Consolidated proof plan chosen by the judge.
    :ivar tools_summary:   Summary of available MCP tools for reference.
    """
    theorem: str
    round: int
    winner: str | None
    final_plan: str | None
    tools_summary: str | None


async def call_grazie(messages: List[BaseMessage], config: GrazieConfig) -> str:
    """
    Invoke a Grazie‐powered ChatGrazie model with a sequence of messages.

    :param messages:  List of `BaseMessage` (SystemMessage, HumanMessage, etc.) forming the prompt.
    :param config:    `GrazieConfig` containing JWT token, client URL, profile, and sampling settings.
    :returns:         The generated content string from the LLM response.
    """
    grazie_llm = ChatGrazie(
        grazie_jwt_token=config.grazie_jwt_token,
        client_auth_type=config.client_auth_type,
        client_url=config.client_url,
        profile=config.profile,
        # temperature=config.temperature,
        max_tokens_to_sample=config.max_tokens_to_sample
    )
    response = await grazie_llm.ainvoke(messages)
    return response.content


async def multi_agent_proof_debate(
        theorem: str,
        tools: List[McpCoqTool],
        config: MadPlanningConfig,
        logger,
        thread_id: str = "coq_proof_debate"
) -> Dict[str, Any]:
    """
    Run a multi‐agent debate to generate and select a Coq proof strategy.

    Two debaters (A and B) alternately propose and refine a proof plan,
    then a Judge selects the stronger plan.

    :param theorem:    The Coq theorem statement to prove.
    :param tools:      List of `McpCoqTool` instances available for planning.
    :param config:     `MadPlanningConfig` specifying number of rounds and LLM configs for A, B, and Judge.
    :param thread_id:  Optional identifier for checkpointing or tracing this debate.
    :returns:          Dict with keys:
                      - `'transcript'`: `List[str]` of all debate messages in order.
                      - `'winner'`:      `'A'` or `'B'`, the chosen debater.
                      - `'final_plan'`:  `str`, the consolidated proof plan from the Judge.
    """
    tools_summary = "\n".join(f"- {t.name}: {t.description}" for t in tools)

    # Prompt templates including tools_summary
    tmpl_A = ChatPromptTemplate.from_messages([
        ("system", "Available tools for proof planning:\n{tools_summary}"),
        ("system",
         "You are Debater A, a Coq expert. Use only natural language. Build on the tools above where helpful."),
        MessagesPlaceholder(variable_name="messages"),
        ("user", (
            "Theorem to prove:\n{theorem}\n\n"
            "Outline your proof strategy this round, referencing tools if relevant."
        ))
    ])
    tmpl_B = ChatPromptTemplate.from_messages([
        ("system", "Available tools for proof planning:\n{tools_summary}"),
        ("system", "You are Debater B, a critical Coq theorist. Use natural language and tool references."),
        MessagesPlaceholder(variable_name="messages"),
        ("user", (
            "Theorem to prove:\n{theorem}\n\n"
            "Critique and refine Debater A's approach, suggesting tool-based improvements. Encounter critic fom Debater B."
        ))
    ])
    tmpl_J = ChatPromptTemplate.from_messages([
        ("system", "Available tools for proof evaluation:\n{tools_summary}"),
        ("system",
         "You are the Judge: a neutral expert. Use natural language. RESPOND ONLY IN JSON FORMAT {{\"winner\": \"A\", \"plan\": \"...\"}}. DO NOT SENT ANYTHING ELSE."),
        MessagesPlaceholder(variable_name="messages"),
        ("user", (
            "After reading all rounds, decide which plan is stronger ('A' or 'B') and provide a final consolidated proof plan."
            "\n\nRespond only as JSON: {{\"winner\": \"A\", \"plan\": \"...\"}}."
        ))
    ])

    # Node definitions
    def init_node(state):
        """
        Initialize the debate state with the theorem, round counter, and seed message.

        :param state:  Mutable state dict to populate.
        :returns:      Updated state with 'theorem', 'round', 'tools_summary', and initial 'messages'.
        """
        state['theorem'] = theorem
        state['round'] = 0
        state['tools_summary'] = tools_summary
        state['messages'] = [SystemMessage(content=f"Proof debate on: {theorem}")]
        print("Finished initializing node")
        return state

    def gather_tools(state):
        """
        Append an AIMessage listing available tools to the state messages.

        :param state:  Current debate state.
        :returns:      State with one additional AIMessage.
        """
        summary_msg = AIMessage(content=f"Tools available for planning:\n{state['tools_summary']}")
        state["messages"].append(summary_msg)

        return state

    async def node_A(state):
        """
        If under the round limit, generate Debater A's proposal via call_grazie.

        :param state:  Current debate state, including 'messages' and 'round'.
        :returns:      State with Debater A's AIMessage appended.
        """
        if state['round'] < config.rounds_number:
            msgs = state['messages']
            prompt = tmpl_A.invoke({
                'messages': msgs,
                'theorem': state['theorem'],
                'tools_summary': state['tools_summary']
            }).to_messages()
            reply = await call_grazie(prompt, config.pro_plan_llm_config)
            logger.info(f"Pro said: {reply}")
            state['messages'].append(AIMessage(content=reply))
        return state

    async def node_B(state):
        """
        If under the round limit, generate Debater B's critique via call_grazie and increment round.

        :param state:  Current debate state.
        :returns:      State with Debater B's AIMessage appended and 'round' incremented.
        """
        if state['round'] < config.rounds_number:
            msgs = state['messages']
            prompt = tmpl_B.invoke({
                'messages': msgs,
                'theorem': state['theorem'],
                'tools_summary': state['tools_summary']
            }).to_messages()
            reply = await call_grazie(prompt, config.con_plan_llm_config)
            logger.info(f"Con said: {reply}")
            state['messages'].append(AIMessage(content=reply))
            state['round'] += 1
        return state

    async def node_J(state):
        """
        Generate the judge's verdict and final plan via call_grazie.

        :param state:  Current debate state containing all messages.
        :returns:      State updated with 'winner' and 'final_plan' from JSON verdict.
        """
        msgs = state['messages']
        prompt = tmpl_J.invoke({
            'messages': msgs,
            'tools_summary': state['tools_summary']
        }).to_messages()
        raw = await call_grazie(prompt, config.judge_plan_llm_config)
        try:
            verdict = json.loads(raw)
        except json.JSONDecodeError:
            verdict = {"winner": "A", "plan": ""}
        state['winner'] = verdict['winner']
        state['final_plan'] = verdict['plan']
        logger.info(f'Judge verdict: {verdict}')
        return state

    # Build graph
    builder = StateGraph(state_schema=MADState)
    builder.add_node('init', init_node)
    builder.add_node('gather_tools', gather_tools)
    builder.add_node('debate_A', node_A)
    builder.add_node('debate_B', node_B)
    builder.add_node('judge', node_J)
    builder.set_entry_point('init')
    builder.add_edge('init', 'gather_tools')
    builder.add_edge('gather_tools', 'debate_A')
    builder.add_edge('debate_A', 'debate_B')
    builder.add_conditional_edges(
        'debate_B',
        lambda s: s['round'] < config.rounds_number,
        path_map={True: 'debate_A', False: 'judge'}
    )
    builder.add_edge('judge', END)

    app = builder.compile(checkpointer=MemorySaver())

    # Invoke
    init_state = {
        "messages": [],
        "theorem": theorem,
        "round": 0
    }
    result = await app.ainvoke(init_state, {"configurable": {"thread_id": thread_id}})

    transcript = [m.content for m in result['messages']]
    return {
        'transcript': transcript,
        'winner': result['winner'],
        'final_plan': result['final_plan']
    }
