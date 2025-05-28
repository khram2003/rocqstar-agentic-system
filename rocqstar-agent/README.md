
# RocqStar Agentic System

This repository provides an autonomous agent framework for generating and repairing Coq proofs using a multi-stage planning and execution pipeline. The system integrates a variety of components, from HTTP clients interfacing with Coq servers to language-model-driven planners and executors.

_Ths code is not runnable as it has the dependencies which are under NDA._

---

## 📁 File Structure

```text
├── agent.py                # Core agent logic and state machine
├── coq_project_client.py   # HTTP client for Coq project operations
├── mcp_client.py           # JSON-RPC client for MCP (Coq) server
├── tools.py                # Dynamic tool provider and tool wrappers
├── planning/               # Proof planning strategies
│   ├── mad.py              # Multi-Agent Debate (MAD) planner
│   └── simple.py           # Single-shot simple planner
└── README.md               # (This file) Overview and documentation
```

---

## 📄 Detailed File Descriptions

### 1. `agent.py`

**Purpose:**

Serves as the orchestrator for end-to-end proof generation and repair by modeling the entire workflow as a finite state machine (FSM) built on `langgraph.StateGraph`. It ties together session management, strategy planning, execution, error handling, and iterative refinement—all driven by language models and Coq-tool interactions.

**Key Components & Workflow:**

* **Initialization (`init`)**:

    * Parses incoming user message to extract `file_path` and `theorem_name`.
    * Starts a Coq session via `CoqProjectClient.start_session`, storing `session_id` and `proof_version_hash`.
    * Instantiates `McpHttpClient`, initializes MCP session, and dynamically retrieves tool definitions via `McpCoqToolProvider`.
    * Builds and names tool wrappers (`McpCoqTool`) for methods like `check_proof`, `get_premises`, etc.
    * Creates LLM clients (`ChatGrazie`) for **executor**, **critic**, **plan\_ranker**, **planner**, **summarizer**, and **failure\_summarizer**, each configured from `self.config`.
    * Generates an initial set of candidate strategies (`plans`) by invoking either `simple_plan_generation` (single-shot) or `multi_agent_proof_debate` (MAD) based on `planning_config.mode`.
    * Seeds the FSM state with:

        * `messages`: system prompt and user message
        * `plans`, `plan_scores`, `plans_to_try`, `current_plan_index`
        * Session identifiers, counters (`tool_calling_iterations`, `failed_proof_checks`), and an empty `summary`.

* **Plan Scoring (`score_plans`)**:

    * When >1 plan exists, iterates over each strategy string:

        * Prompts the **plan\_ranker** model to assign a JSON score (1–10).
        * Parses output, defaults to 5 on parse failure.
    * Sorts plans descending by score and retains top `best_plan_samples_number` into `plans_to_try`.
    * Logs detailed `plan_scores` for later analysis.

* **Plan Loop (`plan_loop`)**:

    * Retrieves initial proof goals via `check_proof` tool to populate `current_goals`.
    * Iterates through `plans_to_try` up to the configured maximum:

        1. Sets `current_plan_index`, logs selected strategy.
        2. Calls `execute_single_plan(plan, summary, state)` to attempt the proof.
        3. On success, marks `is_proof_finished = True`, saves `finished_proof`, and exits loop.
        4. On failure, invokes `summarize_plan_failure` to produce concise bullet points, resets tool counters, and continues.
    * If all strategies fail, exits with `is_proof_finished = False`.

* **Executor Subgraph (`build_executor_subgraph`)**:

    * Defines sub-FSM nodes:

        * `call_llm`: sends messages + summary to **executor** LLM and appends reply.
        * `call_tool`: extracts first `tool_call` from last AI message, invokes via `ToolNode`, and merges responses.
        * `critique`: after *N* consecutive `check_proof` failures, runs **critic** to diagnose deviations.
        * `fetch_similar`: queries `get_premises` + `get_theorem` to assemble similar theorems for inspiration.
        * `replan`: refines the current strategy using **replanner** and prior criticism.
        * `summarize`: condenses long histories with **proof\_progress\_summarizer** when message length exceeds `MAX_RAW`.
        * `early_stopping`: halts when proof complete or max tool calls reached.
    * Uses `should_call_tool` and `should_continue` predicates to route between nodes.

* **Tool Interaction & Error Handling**:

    * Tools (e.g., `check_proof`) are wrapped in `McpCoqTool`, auto-injecting `coqSessionId` and `proofVersionHash`.
    * `format_check_proof_response`:

        * Parses JSON from `check_proof`, updates `current_goals`, `failed_proof_checks`, and `proof_version_hash`.
        * Distinguishes between syntax/runtime errors, incomplete-but-valid proofs, and completion.
    * Tracks `failed_proof_checks` to trigger critique after threshold breaches.

* **Critique & Replanning**:

    * **Critic** LLM (`critic`) is invoked when repeated proof checks fail, producing improvement suggestions without calling tools.
    * Gathers insights on similar proven theorems and feeds them to **replanner** LLM, which outputs a refined strategy string.
    * Integrates refined plan back into the subgraph for continued execution.

* **Summarization**:

    * Monitors raw message length (`MAX_RAW`), and when exceeded, extracts the tail (`TAIL_SIZE`) to preserve context.
    * **proof\_progress\_summarizer** collapses earlier messages into a 4–5 bullet summary, reducing memory while retaining key facts.

### 2. `coq_project_client.py`

**Purpose:** Synchronous HTTP client for interacting with a Coq project server.

**Highlights:**

* Methods to start sessions, fetch theorem statements, validate proofs (`check_proof`), and retrieve premises or full proofs.
* Uses `requests` to perform REST calls and returns JSON responses.

### 3. `mcp_client.py`

**Purpose:** Asynchronous JSON-RPC client for the MCP Coq server, leveraging SSE for streaming responses.

**Highlights:**

* `initialize()`: Performs the `initialize` JSON-RPC handshake and captures the `mcp-session-id`.
* `list_tools()`: Streams available tactics/tools via Server-Sent Events.
* `call_tool()`: Invokes named MCP tools, updates the proof-version hash, and returns textual output.
* Custom error handling with `MCPServerError`.

### 4. `tools.py`

**Purpose:** Adapts MCP JSON-RPC tools into LangChain-compatible `BaseTool` instances and provides them dynamically.

**Key Classes:**

* `McpCoqTool`: Wraps a single MCP tool, injecting session and proof-version context.
* `McpCoqToolProvider`: Discovers available MCP tools at runtime and constructs `McpCoqTool` objects.

### 5. `planning/mad.py`

**Purpose:** Implements a Multi-Agent Debate (MAD) proof planner, where two AI debaters (`A` and `B`) iteratively propose and critique strategies, followed by a judge to select the best plan.

**Flow:**

1. **Initialization**: Record theorem and available tools.
2. **Debate Rounds**: Alternate between Debater A (proposes) and Debater B (critiques/improves) for *n* rounds.
3. **Judgment**: A judge LLM decides the winner and consolidates a final proof strategy.

### 6. `planning/simple.py`

**Purpose:** Provides a straightforward, single-shot plan-generation strategy using a single Grazie chat model.

**Flow:**

1. Lists available tools.
2. Sends a prompt asking the model to produce a numbered step-by-step proof outline.

---

