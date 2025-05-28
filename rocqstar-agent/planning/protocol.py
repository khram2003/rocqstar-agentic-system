from typing import Literal

from pydantic import BaseModel, Field

from ideformer.core.protocol.config.chat.grazie import GrazieConfig
from ideformer.core.protocol.content import IdeFormerMessageE2SContent, IdeFormerMessageS2EContent
from grazie.api.client.profiles import Profile


class CoqPilotProPlanMessageE2SConfig(BaseModel, arbitrary_types_allowed=True):
    llm_config: GrazieConfig = GrazieConfig(
        profile=Profile.ANTHROPIC_CLAUDE_35_SONNET.name,
        temperature=0.0,
        max_tokens_to_sample=8192,
    )
    max_agent_iterations: int = Field(
        default=50,
        description="Maximum number of iterations (i.e. Tool calls from server to user) allowed",
    )


class CoqPilotProPlanMessageE2SContent(IdeFormerMessageE2SContent):
    agent_id: Literal["coqpilot-pro-plan-v2.5.0"] = "coqpilot-pro-plan-v2.5.0"
    # be aware: there is message: str field in IdeFormerMessageE2SContent!
    config: CoqPilotProPlanMessageE2SConfig = CoqPilotProPlanMessageE2SConfig()


class CoqPilotProPlanMessageS2EContent(IdeFormerMessageS2EContent):
    agent_id: Literal["coqpilot-pro-plan-v2.5.0"] = "coqpilot-pro-plan-v2.5.0"
    # be aware: there is tool_name: str field in IdeFormerMessageS2EContent
    # be aware: there is tool_args: dict[str, ALLOWED_ARG_TYPES] field in IdeFormerMessageS2EContent
