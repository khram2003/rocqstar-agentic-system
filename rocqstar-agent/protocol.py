from enum import Enum
from typing import Literal

from pydantic import BaseModel

from ideformer.core.protocol.config.chat.grazie import GrazieConfig
from ideformer.core.protocol.content import IdeFormerMessageE2SContent, IdeFormerMessageS2EContent
from ideformer.core.protocol.types import ALLOWED_ARG_TYPES


class SimplePlanningConfig(BaseModel):
    simple_plan_llm_config: GrazieConfig = GrazieConfig()


class MadPlanningConfig(BaseModel):
    pro_plan_llm_config: GrazieConfig = GrazieConfig()
    con_plan_llm_config: GrazieConfig = GrazieConfig()
    judge_plan_llm_config: GrazieConfig = GrazieConfig()
    rounds_number: int = 5


class PlanningConfig(BaseModel):
    mode: Literal["simple", "mad"] = "simple"
    simple_planning_config: SimplePlanningConfig = SimplePlanningConfig()
    mad_planning_config: MadPlanningConfig = SimplePlanningConfig()
    plan_ranker_llm_config: GrazieConfig = GrazieConfig()
    plan_samples_number: int = 7
    best_plan_samples_number: int = 3


class ProofFlowConfig(BaseModel):
    executor_llm_config: GrazieConfig = GrazieConfig()
    proof_progress_critic_llm_config: GrazieConfig = GrazieConfig()
    replanner_llm_config: GrazieConfig = GrazieConfig()
    summarizer_llm_config: GrazieConfig = GrazieConfig()
    plan_failure_summarizer_llm_config: GrazieConfig = GrazieConfig()
    similar_theorems_analyzer_llm_config: GrazieConfig = GrazieConfig()
    max_tool_iterations_per_plan_number: int = 20
    max_raw_messages_number: int = 60


class CoqPilotGeneralMessageE2SConfig(BaseModel, arbitrary_types_allowed=True):
    planning_config: PlanningConfig = PlanningConfig()
    proof_flow_config: ProofFlowConfig = ProofFlowConfig()


class CoqPilotGeneralMessageE2SContent(IdeFormerMessageE2SContent):
    agent_id: Literal["coqpilot-general"] = "coqpilot-general"
    config: CoqPilotGeneralMessageE2SConfig = CoqPilotGeneralMessageE2SConfig()


class CoqPilotGeneralMessageS2EContent(IdeFormerMessageS2EContent):
    agent_id: Literal["coqpilot-general"] = "coqpilot-general"

    @classmethod
    def by_tool_call(cls, tool_name: str, tool_args: dict[str, ALLOWED_ARG_TYPES]):
        validated_args = {}
        for key, value in tool_args.items():
            if isinstance(value, (str, int, float, bool, Enum)) or value is None:
                validated_args[key] = value
            elif isinstance(value, list):
                validated_args[key] = [
                    v for v in value
                    if isinstance(v, (str, int, float, bool, Enum)) or v is None
                ]

        return cls(tool_name=tool_name, tool_args=validated_args)
