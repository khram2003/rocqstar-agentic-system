import json
from typing import Any, Dict, List, Optional

import aiohttp


class MCPServerError(Exception):
    """Exception raised when the MCP server returns an error response."""
    pass


class McpHttpClient:
    """JSON‑RPC client for MCP (Coq) server."""

    def __init__(
            self,
            url: str,
            coq_session_id: str,
            client_name: str = "python-client",
            client_version: str = "0.1.0"
    ):
        """
        Initialize the MCP HTTP client.

        :param url:            Base URL of the MCP server (e.g. "http://localhost:3001/mcp").
        :param coq_session_id: Identifier of the Coq session to attach to.
        :param client_name:    Name to send in the 'clientInfo' payload.
        :param client_version: Version to send in the 'clientInfo' payload.
        """
        self.url = url
        self.coq_session_id = coq_session_id
        self.session_id: Optional[str] = None
        self.proof_version_hash: Optional[str] = None
        self._id_counter = 0
        self.client_info = {"name": client_name, "version": client_version}

    async def _next_id(self) -> int:
        """
        Increment and return the next JSON-RPC request ID.

        :returns: A unique integer ID for the next JSON-RPC call.
        """
        self._id_counter += 1
        return self._id_counter

    async def initialize(self) -> None:
        """
        Send the JSON-RPC 'initialize' method to the MCP server and capture the MCP‐Session‐Id.

        :raises RuntimeError: If no 'mcp-session-id' header is present in the response.
        :returns: None
        """
        rid = await self._next_id()
        payload = {
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": self.client_info,
            },
            "id": rid,
        }
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        }
        async with aiohttp.ClientSession() as http:
            async with http.post(self.url, json=payload, headers=headers) as resp:
                resp.raise_for_status()
                sid = resp.headers.get("mcp-session-id")
                if not sid:
                    raise RuntimeError("No MCP‑Session‑Id header in initialize response")
                self.session_id = sid

    async def list_tools(self) -> List[Dict[str, Any]]:
        """
        Retrieve the list of available tools from the MCP server via 'tools/list'.

        :raises RuntimeError: If the client has not been initialized or the SSE stream ends prematurely.
        :returns: A list of tool definitions, each represented as a dictionary.
        """
        if not self.session_id:
            raise RuntimeError("Client not initialized")
        rid = await self._next_id()
        payload = {
            "jsonrpc": "2.0",
            "method": "tools/list",
            "params": {},
            "id": rid,
        }
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "mcp-session-id": self.session_id,
        }
        async with aiohttp.ClientSession() as http:
            async with http.post(self.url, json=payload, headers=headers) as resp:
                resp.raise_for_status()
                async for raw_line in resp.content:
                    line = raw_line.decode("utf-8", errors="ignore").strip()
                    if line.startswith("data:"):
                        payload = line[len("data:"):].strip()
                        msg = json.loads(payload)
                        return msg["result"]["tools"]
        raise RuntimeError("SSE ended without data")

    async def call_tool(self, tool_name: str, **kwargs: Any) -> str:
        """
        Invoke a specific tool on the MCP server via JSON-RPC 'tools/call'.

        :param tool_name: Name of the MCP tool to call.
        :param kwargs:    Arguments for the tool; if `tool_name == "get_similar_proofs"`,
                          the `goal` argument will be normalized to JSON string.
        :raises RuntimeError:   If the client is not initialized or the SSE stream ends prematurely.
        :raises MCPServerError: If the server returns an error field in its response.
        :raises ValueError:     If the provided `goal` argument is neither str nor dict.
        :returns:               The text of the first chunk in the tool’s response.
        """
        """Invoke a named tool via 'tools/call' SSE."""
        if not self.session_id:
            raise RuntimeError("Client not initialized")
        rid = await self._next_id()
        if tool_name == "get_similar_proofs":
            goal = kwargs.get('goal', "")
            if isinstance(goal, str):
                kwargs['goal'] = goal
            elif isinstance(goal, dict):
                kwargs['goal'] = json.dumps(goal)
            else:
                raise ValueError(f"Goal must be string")

        payload = {
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": kwargs},
            "id": rid,
        }
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "mcp-session-id": self.session_id,
        }
        async with aiohttp.ClientSession() as http:
            async with http.post(self.url, json=payload, headers=headers) as resp:
                resp.raise_for_status()
                async for raw_line in resp.content:
                    line = raw_line.decode("utf-8", errors="ignore").strip()
                    if line.startswith("data:"):
                        payload = line[len("data:"):].strip()
                        msg = json.loads(payload)
                        if 'error' in msg:
                            raise MCPServerError(msg['error'])
                        if "result" in msg and "hash" in msg["result"]:
                            self.proof_version_hash = msg["result"]["hash"]
                        # MCP returns a list of content chunks
                        return msg["result"]["content"][0]["text"]
        raise RuntimeError("SSE ended without data")
