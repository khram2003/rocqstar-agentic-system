import asyncio
from typing import List, Any

from pydantic import PrivateAttr
from langchain_core.tools import BaseTool

from ideformer.agents.coqpilot_agent.mcp_client import McpHttpClient
from ideformer.core.tools.langchain.dynamic import LangChainDynamicToolProvider
from ideformer.core.agent import IdeFormerAgent


class McpCoqTool(BaseTool):
    """
    Wraps a single MCP JSON-RPC tool as a LangChain BaseTool.

    Handles argument normalization, session‐ID and proof‐version hash injection,
    and dispatches calls through an underlying McpHttpClient.
    """
    _client: McpHttpClient = PrivateAttr()
    _requires_session_id: bool = PrivateAttr()
    _requires_proof_version_hash: bool = PrivateAttr()
    _arg_names: List[str] = PrivateAttr()

    def __init__(self, name: str, description: str, client: McpHttpClient, requires_session_id: bool = True,
                 requires_proof_version_hash: bool = False, arg_names: List[str] = None):
        """
        :param name:                      The name of the MCP tool (e.g. "check_proof").
        :param description:               Human-readable description of what the tool does.
        :param client:                    An initialized McpHttpClient instance.
        :param requires_session_id:       Whether to inject `coqSessionId` automatically.
        :param requires_proof_version_hash: Whether to inject `proofVersionHash` automatically.
        :param arg_names:                 Ordered list of parameter names, used to map positional args.
        """
        super().__init__(name=name, description=description)
        self._client = client
        self._requires_session_id = requires_session_id
        self._requires_proof_version_hash = requires_proof_version_hash
        self._arg_names = arg_names or []

    def _run(self, *args: Any, **kwargs: Any) -> str:
        """
        Synchronous wrapper around the async `_arun` method.

        :param args:   Positional arguments to pass to the tool.
        :param kwargs: Keyword arguments to pass to the tool.
        :returns:       The raw text result returned by the MCP server.
        """
        return asyncio.get_event_loop().run_until_complete(
            self._arun(*args, **kwargs)
        )

    async def _arun(self, *args: Any, **kwargs: Any) -> str:
        """
        Invoke the MCP tool asynchronously, normalizing nested args and injecting required IDs.

        :param args:   Positional arguments to map according to `self._arg_names`.
        :param kwargs: Keyword arguments or nested dict/list in the `args` key.
        :returns:       Text response from the MCP server tool call.
        """
        if 'args' in kwargs:
            nested_args = kwargs.pop('args')
            if isinstance(nested_args, list):
                for i, arg in enumerate(nested_args):
                    if i < len(self._arg_names):
                        kwargs[self._arg_names[i]] = arg
            elif isinstance(nested_args, dict):
                kwargs.update(nested_args)

        if args:
            for i, arg in enumerate(args):
                if i < len(self._arg_names):
                    kwargs[self._arg_names[i]] = arg

        if self._requires_session_id:
            kwargs["coqSessionId"] = self._client.coq_session_id
        if self._requires_proof_version_hash:
            kwargs["proofVersionHash"] = self._client.proof_version_hash

        return await self._client.call_tool(self.name, **kwargs)


class McpCoqToolProvider(LangChainDynamicToolProvider):
    """
    Dynamic provider that discovers and wraps all MCP tools at runtime.

    Queries the MCP server's `tools/list` endpoint, constructs McpCoqTool instances
    with appropriate parameter schemas and descriptions.
    """

    def __init__(self, client: McpHttpClient):
        """
        :param client:  An initialized McpHttpClient instance to use for discovery.
        """
        self._client = client
        super().__init__(tools_list_tool_name="tools/list")

    async def tools(self, agent: IdeFormerAgent[Any, Any]) -> List[BaseTool]:
        """
        Fetch and wrap all available MCP tools for use by an IdeFormerAgent.

        :param agent:  The IdeFormerAgent requesting tool access (unused here).
        :returns:      A list of McpCoqTool instances, one per MCP tool definition.
        :raises RuntimeError: If the MCP client has not been initialized.
        """
        if not self._client.session_id:
            await self._client.initialize()
        tool_defs = await self._client.list_tools()
        tools: List[BaseTool] = []
        for td in tool_defs:
            name = td["name"]
            description = td.get("description", "")
            input_schema = td.get("inputSchema", {})
            if input_schema:
                param_descriptions = []
                input_schema_properties = input_schema.get("properties", {})
                for param_name, param_info in input_schema_properties.items():
                    is_required = False
                    if param_name in ["coqSessionId", "proofVersionHash"]:
                        continue
                    if param_name in input_schema.get("required", []):
                        is_required = True
                    if isinstance(param_info, dict) and "description" in param_info:
                        param_descriptions.append(f"{param_name}: {param_info['description']}." + (
                            "This field is required." if is_required else ""))

                if param_descriptions:
                    description += f"\n\n# Parameters for the tool {name}:\n" + "\n".join(
                        f"+ {desc}" for desc in param_descriptions)

            requires_session_id = "coqSessionId" in td["inputSchema"].get("required", [])
            requires_proof_version_hash = "proofVersionHash" in td["inputSchema"].get("required", [])

            arg_names = [
                name for name in td["inputSchema"].get("properties", {}).keys()
                if name not in ["coqSessionId", "proofVersionHash"]
            ]

            tools.append(
                McpCoqTool(
                    name=name,
                    description=description,
                    client=self._client,
                    requires_session_id=requires_session_id,
                    requires_proof_version_hash=requires_proof_version_hash,
                    arg_names=arg_names,
                )
            )
        return tools
