from typing import List
from langchain_core.messages import SystemMessage, HumanMessage

from grazie_langchain_utils.language_models.grazie import ChatGrazie
from ..tools import McpCoqTool
from ..protocol import SimplePlanningConfig


async def simple_plan_generation(
        theorem: str,
        tools: List[McpCoqTool],
        config: SimplePlanningConfig
) -> str:
    """
    Generate a single-shot proof plan for `theorem` using simple planning config.
    
    Args:
        theorem: The theorem to prove
        grazie_api_key: Grazie API key
        tools: List of available tools
        config: Simple planning configuration
        
    Returns:
        Generated proof plan as a string
    """
    tools_summary = "\n".join(f"- **{t.name}**: {t.description}" for t in tools)

    chat = ChatGrazie(
        grazie_jwt_token=config.simple_plan_llm_config.grazie_jwt_token,
        client_auth_type=config.simple_plan_llm_config.client_auth_type,
        client_url=config.simple_plan_llm_config.client_url,
        profile=config.simple_plan_llm_config.profile,
        temperature=config.simple_plan_llm_config.temperature,
        max_tokens_to_sample=config.simple_plan_llm_config.max_tokens_to_sample
    )

    system = SystemMessage(content=(
        "You are a Coq expert assistant. "
        "First review the list of available proof‐assistant tools, then outline a clear, stepwise proof strategy. "
        "When you reference a tool in your plan, wrap its name in backticks, e.g. `check_proof`."
    ))

    human = HumanMessage(content=(
        f"**Available tools:**\n{tools_summary}\n\n"
        f"**Theorem to prove:**\n{theorem}\n\n"
        "Please output a numbered plan of tactics and tool calls."
    ))

    response = await chat.ainvoke([system, human])
    return response.content.strip()
