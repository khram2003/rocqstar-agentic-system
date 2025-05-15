import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import * as express from "express";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { z } from "zod";

const COQ_SERVER_URL =
    process.env.COQ_SERVER_URL || "http://localhost:8000/rest";
const PORT = Number(process.env.PORT) || 3001;

// Initialize logger
const logger = pino({
    level: "info",
    transport: { target: "pino-pretty", options: { colorize: true } },
});
logger.info("Starting stateless MCP server for Coq", {
    port: PORT,
    url: COQ_SERVER_URL,
});

const app = express();
app.use(express.json());

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

// Handle POST requests for client-to-server communication
app.post("/mcp", async (req, res) => {
    // Check for existing session ID
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    console.log("--------------------------------");
    console.log(req.body);
    console.log("--------------------------------");
    console.log(req.headers);
    console.log("--------------------------------");
    if (sessionId && transports[sessionId]) {
        // Reuse existing transport
        transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
        const eventStore = new InMemoryEventStore();
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            eventStore, // Enable resumability
            onsessioninitialized: (sessionId) => {
                // Store the transport by session ID
                transports[sessionId] = transport;
            },
        });

        // Clean up transport when closed
        transport.onclose = () => {
            if (transport.sessionId) {
                delete transports[transport.sessionId];
            }
        };
        const server = new McpServer({
            name: "example-server",
            version: "1.0.0",
        });

        server
            .tool("get_project_root", {}, async (_, { sessionId }) => {
                logger.info("Tool: get_project_root", { sessionId });
                const resp = await axios.get(`${COQ_SERVER_URL}/document`);
                return {
                    content: [
                        { type: "text", text: JSON.stringify(resp.data) },
                    ],
                };
            })
            .update({
                description: "Returns the project root directory information",
            });

        server
            .tool("list_coq_files", {}, async (_, { sessionId }) => {
                logger.info("Tool: list_coq_files", { sessionId });
                const resp = await axios.get(
                    `${COQ_SERVER_URL}/document/all-coq-files`
                );
                return {
                    content: [
                        { type: "text", text: JSON.stringify(resp.data) },
                    ],
                };
            })
            .update({
                description: "Returns a list of all Coq files in the project",
            });

        server
            .tool(
                "get_theorem_names_from_file_with_target_theorem",
                { filePath: z.string(), coqSessionId: z.string() },
                async ({ filePath, coqSessionId }, { sessionId }) => {
                    logger.info(
                        "Tool: get_theorem_names_from_file_with_target_theorem",
                        { filePath, coqSessionId, sessionId }
                    );
                    const resp = await axios.get(
                        `${COQ_SERVER_URL}/document/theorem-names`,
                        { params: { filePath, coqSessionId } }
                    );
                    return {
                        content: [
                            { type: "text", text: JSON.stringify(resp.data) },
                        ],
                    };
                }
            )
            .update({
                description:
                    "Retrieves available theorem names from a file with a target theorem",
                paramsSchema: {
                    filePath: z.string().describe("Path to the Coq file"),
                    coqSessionId: z
                        .string()
                        .describe("ID of the current Coq session"),
                },
            });

        server
            .tool(
                "get_theorem_names_from_file_without_target_theorem",
                { filePath: z.string() },
                async ({ filePath }, { sessionId }) => {
                    logger.info(
                        "Tool: get_theorem_names_from_file_without_target_theorem",
                        { filePath, sessionId }
                    );
                    const resp = await axios.get(
                        `${COQ_SERVER_URL}/document/theorem-names`,
                        { params: { filePath } }
                    );
                    return {
                        content: [
                            { type: "text", text: JSON.stringify(resp.data) },
                        ],
                    };
                }
            )
            .update({
                description:
                    "Retrieves available theorem names from a file without a target theorem",
                paramsSchema: {
                    filePath: z.string().describe("Path to the Coq file"),
                },
            });

        server
            .tool(
                "get_current_target_theorem_state",
                { coqSessionId: z.string(), proofVersionHash: z.string() },
                async ({ coqSessionId, proofVersionHash }, { sessionId }) => {
                    logger.info("Tool: get_current_target_theorem_state", {
                        coqSessionId,
                        proofVersionHash,
                        sessionId,
                    });
                    const resp = await axios.get(
                        `${COQ_SERVER_URL}/document/session-theorem`,
                        { params: { coqSessionId, proofVersionHash } }
                    );
                    return {
                        content: [
                            { type: "text", text: JSON.stringify(resp.data) },
                        ],
                    };
                }
            )
            .update({
                description: "Retrieves current state of a target theorem",
                paramsSchema: {
                    coqSessionId: z
                        .string()
                        .describe("ID of the current Coq session"),
                    proofVersionHash: z
                        .string()
                        .describe("Hash of the current proof version"),
                },
            });

        server
            .tool(
                "get_specific_theorem_with_proof_by_name",
                {
                    filePath: z.string(),
                    theoremName: z.string(),
                    proofVersionHash: z.string(),
                    coqSessionId: z.string(),
                },
                async (
                    { filePath, theoremName, proofVersionHash, coqSessionId },
                    { sessionId }
                ) => {
                    logger.info(
                        "Tool: get_specific_theorem_with_proof_by_name",
                        { filePath, theoremName, sessionId, proofVersionHash }
                    );
                    const resp = await axios.get(
                        `${COQ_SERVER_URL}/document/theorem`,
                        {
                            params: {
                                filePath,
                                theoremName,
                                coqSessionId,
                                proofVersionHash,
                            },
                        }
                    );
                    return {
                        content: [
                            { type: "text", text: JSON.stringify(resp.data) },
                        ],
                    };
                }
            )
            .update({
                description: "Retrieves a specific theorem with proof by name",
                paramsSchema: {
                    filePath: z.string().describe("Path to the Coq file"),
                    theoremName: z
                        .string()
                        .describe("Name of the theorem to retrieve"),
                    coqSessionId: z
                        .string()
                        .describe("ID of the current Coq session"),
                    proofVersionHash: z
                        .string()
                        .describe("Hash of the current proof version"),
                },
            });

        server
            .tool(
                "check_proof",
                {
                    proof: z.string(),
                    coqSessionId: z.string(),
                    proofVersionHash: z.string(),
                },
                async (
                    { proof, coqSessionId, proofVersionHash },
                    { sessionId }
                ) => {
                    logger.info("Tool: check_proof", {
                        proof,
                        coqSessionId,
                        proofVersionHash,
                        sessionId,
                    });
                    const resp = await axios.get(
                        `${COQ_SERVER_URL}/document/check-proof`,
                        { params: { proof, coqSessionId, proofVersionHash } }
                    );
                    return {
                        content: [
                            { type: "text", text: JSON.stringify(resp.data) },
                        ],
                    };
                }
            )
            .update({
                description:
                    "Validates a proof (or a part of a proof) in the context of a session and returns goals/errors",
                paramsSchema: {
                    proof: z
                        .string()
                        .describe(
                            "The proof to validate. It should start with 'Proof.'"
                        ),
                    coqSessionId: z
                        .string()
                        .describe("ID of the current Coq session"),
                    proofVersionHash: z
                        .string()
                        .describe("Hash of the current proof version"),
                },
            });

        server
            .tool(
                "get_similar_proofs",
                {
                    goal: z.string(),
                    filePath: z.string(),
                    coqSessionId: z.string(),
                    maxNumberOfPremises: z.number().optional().default(7),
                },
                async (
                    { goal, filePath, coqSessionId, maxNumberOfPremises },
                    { sessionId }
                ) => {
                    logger.info("Tool: get_premises", {
                        goal,
                        filePath,
                        coqSessionId,
                        maxNumberOfPremises,
                        sessionId,
                    });
                    const resp = await axios.get(
                        `${COQ_SERVER_URL}/document/get-premises`,
                        {
                            params: {
                                goal,
                                filePath,
                                coqSessionId,
                                maxNumberOfPremises,
                            },
                        }
                    );
                    return {
                        content: [
                            { type: "text", text: JSON.stringify(resp.data) },
                        ],
                    };
                }
            )
            .update({
                description: "Retrieves similar proofs for a goal in a file",
                paramsSchema: {
                    goal: z
                        .string()
                        .describe(
                            'The goal to find similar proofs for. Should be a JSON string matching the interface: "{ hypothesis: string[], conclusion: string }". IT IS A STRING NOT AN OBJECT'
                        ),
                    filePath: z.string().describe("Path to the Coq file"),
                    maxNumberOfPremises: z
                        .number()
                        .optional()
                        .default(7)
                        .describe("Maximum number of premises to return"),
                    coqSessionId: z
                        .string()
                        .describe("ID of the current Coq session"),
                },
            });

        server
            .tool(
                "get_objects",
                { coqSessionId: z.string() },
                async ({ coqSessionId }, { sessionId }) => {
                    logger.info("Tool: get_objects", {
                        coqSessionId,
                        sessionId,
                    });
                    const resp = await axios.get(
                        `${COQ_SERVER_URL}/document/get-objects`,
                        { params: { coqSessionId } }
                    );
                    return {
                        content: [
                            { type: "text", text: JSON.stringify(resp.data) },
                        ],
                    };
                }
            )
            .update({
                description:
                    "Retrieves all objects in a session. Uses Print All Coq Command.",
                paramsSchema: {
                    coqSessionId: z
                        .string()
                        .describe("ID of the current Coq session"),
                },
            });

        server
            .tool(
                "about_term",
                { term: z.string(), coqSessionId: z.string() },
                async ({ term, coqSessionId }, { sessionId }) => {
                    logger.info("Tool: about_term", {
                        term,
                        coqSessionId,
                        sessionId,
                    });
                    const resp = await axios.get(
                        `${COQ_SERVER_URL}/document/about-term`,
                        { params: { term, coqSessionId } }
                    );
                    return {
                        content: [
                            { type: "text", text: JSON.stringify(resp.data) },
                        ],
                    };
                }
            )
            .update({
                description:
                    "Explains a term in the current session's file. Uses About Coq Command.",
                paramsSchema: {
                    term: z.string().describe("The term to explain"),
                    coqSessionId: z
                        .string()
                        .describe("ID of the current Coq session"),
                },
            });

        server
            .tool(
                "search_pattern",
                { pattern: z.string(), coqSessionId: z.string() },
                async ({ pattern, coqSessionId }, { sessionId }) => {
                    logger.info("Tool: search_pattern", {
                        pattern,
                        coqSessionId,
                        sessionId,
                    });
                    const resp = await axios.get(
                        `${COQ_SERVER_URL}/document/search-pattern`,
                        { params: { pattern, coqSessionId } }
                    );
                    return {
                        content: [
                            { type: "text", text: JSON.stringify(resp.data) },
                        ],
                    };
                }
            )
            .update({
                description:
                    "Searches for a pattern in the current session's file. Uses Search Coq Command.",
                paramsSchema: {
                    pattern: z.string().describe("The pattern to search for"),
                    coqSessionId: z
                        .string()
                        .describe("ID of the current Coq session"),
                },
            });

        server
            .tool(
                "print_term",
                { term: z.string(), coqSessionId: z.string() },
                async ({ term, coqSessionId }, { sessionId }) => {
                    logger.info("Tool: print_term", {
                        term,
                        coqSessionId,
                        sessionId,
                    });
                    const resp = await axios.get(
                        `${COQ_SERVER_URL}/document/print-term`,
                        { params: { term, coqSessionId } }
                    );
                    return {
                        content: [
                            { type: "text", text: JSON.stringify(resp.data) },
                        ],
                    };
                }
            )
            .update({
                description:
                    "Prints a term in the current session's file. Uses Print Coq Command.",
                paramsSchema: {
                    term: z.string().describe("The term to print"),
                    coqSessionId: z
                        .string()
                        .describe("ID of the current Coq session"),
                },
            });

        server
            .tool(
                "check_term",
                { term: z.string(), coqSessionId: z.string() },
                async ({ term, coqSessionId }, { sessionId }) => {
                    logger.info("Tool: check_term", {
                        term,
                        coqSessionId,
                        sessionId,
                    });
                    const resp = await axios.get(
                        `${COQ_SERVER_URL}/document/check-term`,
                        { params: { term, coqSessionId } }
                    );
                    return {
                        content: [
                            { type: "text", text: JSON.stringify(resp.data) },
                        ],
                    };
                }
            )
            .update({
                description:
                    "Checks a term in the current session's file. Uses Check Coq Command.",
                paramsSchema: {
                    term: z.string().describe("The term to check"),
                    coqSessionId: z
                        .string()
                        .describe("ID of the current Coq session"),
                },
            });

        // Connect to the MCP server
        await server.connect(transport);
        console.log("Server connected");
    } else {
        // Invalid request
        res.status(400).json({
            jsonrpc: "2.0",
            error: {
                code: -32000,
                message: "Bad Request: No valid session ID provided",
            },
            id: null,
        });
        return;
    }

    console.log("Handling request");

    // Handle the request
    await transport.handleRequest(req, res, req.body);

    console.log("Request handled");
});

// Reusable handler for GET and DELETE requests
const handleSessionRequest: express.RequestHandler = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send("Invalid or missing session ID");
        return;
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
};

app.get("/mcp", handleSessionRequest);

app.delete("/mcp", handleSessionRequest);

app.listen(PORT);
