import { Controller, Get, QueryParams, UseBefore } from "@tsed/common";
import { Required } from "@tsed/schema";
import { unlinkSync } from "fs";

import { FilePathMiddleware } from "../middlewares/filePathMiddleware";
import { ApiGoal, ProofError } from "../models/apiGoal";
import {
    AboutCoqCommand,
    CheckCoqCommand,
    PrintAllCoqCommand,
    PrintCoqCommand,
    SearchCoqCommand,
} from "../services/coqCommandType";
import { CoqProjectObserverService } from "../services/coqProjectObserverService";
import { SessionManager } from "../services/sessionManager";
import { prepareProofToCheck } from "../utils/proofPreparationUtil";
import { ProofGoal } from "../../coqLsp/coqLspTypes";
import { hypToString } from "../../core/exposedCompletionGeneratorUtils";

interface ProofCheckResponse {
    success: boolean;
    message: string;
    hash?: string;
    proof?: string;
    goals?: ApiGoal[];
    error?: ProofError;
    validPrefix?: string;
    attemptedProof?: string;
}

interface ProofTreeNode {
    hash: string;
    content: string[];
    steps: string[];
    children: (ProofTreeNode | null)[];
}

@Controller("/document")
export class CoqProjectController {
    constructor(
        private readonly coqProjectObserverService: CoqProjectObserverService,
        private readonly sessionManager: SessionManager
    ) {}

    /** Returns the project root directory information */
    @Get()
    async getProjectRoot(): Promise<any> {
        return {
            message:
                "Server is expecting the coq project to be with the same root as the server.",
            projectRoot: this.coqProjectObserverService.getProjectRoot(),
        };
    }

    /** Retrieves theorem names from a specified file, optionally using a session's auxiliary file.
     * If sessionId is provided, uses the session's auxiliary file, otherwise uses the complete source file.
     */
    @Get("/theorem-names")
    @UseBefore(FilePathMiddleware)
    async getTheoremNamesFromFile(
        @Required() @QueryParams("filePath") filePath: string,
        @QueryParams("coqSessionId") sessionId?: string
    ): Promise<any> {
        try {
            // If session ID is provided, use the session's auxiliary file
            if (sessionId) {
                const session = await this.sessionManager.getSession(sessionId);
                if (!session) {
                    return { success: false, message: "Session not found" };
                }

                return {
                    message: "Theorem names from the session auxiliary file",
                    theoremNames:
                        await this.coqProjectObserverService.getTheoremNamesFromFile(
                            filePath,
                            session.auxFileUri
                        ),
                    isSessionBased: true,
                };
            } else {
                return {
                    message: "Theorem names from the complete source file",
                    theoremNames:
                        await this.coqProjectObserverService.getTheoremNamesFromFile(
                            filePath
                        ),
                    isSessionBased: false,
                };
            }
        } catch (error) {
            return {
                success: false,
                message: "Failed to get theorem names",
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /** Returns a list of all Coq files in the project */
    @Get("/all-coq-files")
    getAllCoqFiles(): any {
        return {
            coqFiles: this.coqProjectObserverService.getCoqFilesInProject(),
        };
    }

    /** Retrieves theorem information from a specific session and proof version.
     * Returns the theorem statement and proof content for a given session and proof version hash.
     */
    @Get("/session-theorem")
    // @UseBefore(FilePathMiddleware)
    async retrieveTheoremFromSession(
        @Required() @QueryParams("coqSessionId") sessionId: string,
        @Required() @QueryParams("proofVersionHash") proofVersionHash: string
    ): Promise<any> {
        try {
            const session = await this.sessionManager.getSession(sessionId);
            if (!session) {
                return { success: false, message: "Session not found" };
            }

            // we aim only for full proof generation
            const currentProof =
                session.proofVersions.get(proofVersionHash)?.proofContent;
            if (!currentProof) {
                return { success: false, message: "Proof version not found" };
            }

            return {
                theoremStatement: session.theoremStatement,
                theoremProof: currentProof.join("\n"),
                isIncomplete: true,
                sessionId: sessionId,
            };
        } catch (error) {
            return {
                message: "Failed to retrieve theorem from session",
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /** Retrieves complete theorem with proof from a source file.
     * Returns the theorem statement and proof from the original source file.
     */
    @Get("/theorem")
    @UseBefore(FilePathMiddleware)
    async retrieveCompleteTheoremFromFile(
        @Required() @QueryParams("filePath") filePath: string,
        @Required() @QueryParams("theoremName") theoremName: string,
        @Required() @QueryParams("coqSessionId") sessionId: string,
        @Required() @QueryParams("proofVersionHash") proofVersionHash: string
    ): Promise<any> {
        const session = await this.sessionManager.getSession(sessionId);
        if (!session) {
            return { success: false, message: "Session not found" };
        }

        if (
            theoremName === session.theoremName &&
            session.sourceFilePath === filePath
        ) {
            return await this.retrieveTheoremFromSession(
                sessionId,
                proofVersionHash
            );
        }

        try {
            const theorem =
                await this.coqProjectObserverService.retrieveTheoremWithProofFromFile(
                    filePath,
                    theoremName
                );

            return {
                theoremStatement: theorem.statement,
                theoremProof: theorem.proof?.onlyText(),
                isIncomplete: theorem.proof?.is_incomplete,
                isFromOriginalFile: true,
            };
        } catch (error) {
            return {
                success: false,
                message: "Failed to retrieve complete theorem",
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /** Validates a proof in the context of a session and returns goals/errors.
     * Checks if the proof is valid, complete, or has errors, and returns appropriate goals and error messages.
     * Also handles updating the proof version in the session.
     */
    @Get("/check-proof")
    async checkProofInFile(
        @Required() @QueryParams("proof") proof: string,
        @Required() @QueryParams("coqSessionId") sessionId: string,
        @Required() @QueryParams("proofVersionHash") proofVersionHash: string
    ): Promise<ProofCheckResponse> {
        let currentSession = null;
        try {
            currentSession = await this.sessionManager.getSession(sessionId);
            if (!currentSession) {
                return { success: false, message: "Session not found" };
            }

            const preparedProof = prepareProofToCheck(proof);
            const preparedProofLines = preparedProof.split("\n");

            const currentProofVersion =
                currentSession.proofVersions.get(proofVersionHash);
            if (!currentProofVersion) {
                return { success: false, message: "Proof version not found" };
            }
            // const currentProof = currentProofVersion.proofContent;

            const auxFileContent = currentSession.filePrefixContent;
            // .concat(currentProof)
            // .concat(preparedProofLines);

            const positionToCheckAt = {
                line: auxFileContent.length + 1 + preparedProofLines.length,
                character: preparedProofLines.at(-1)?.length || 0,
            };

            console.log(
                `Controller: Checking proof at position L${positionToCheckAt.line}:C${positionToCheckAt.character}, version ${currentSession.auxFileVersionNumber}`
            );

            const result = await this.coqProjectObserverService.checkCoqProof(
                preparedProof,
                currentSession.auxFileUri,
                currentSession.filePrefixContent,
                currentSession.auxFileVersionNumber,
                positionToCheckAt
            );

            currentSession.auxFileVersionNumber =
                currentSession.auxFileVersionNumber + 2;
            const updatedProofVersionHash =
                await this.sessionManager.commitProofPortion(
                    sessionId,
                    preparedProof.split("\n"),
                    currentSession.auxFileVersionNumber + 1,
                    proofVersionHash
                );
            if (!updatedProofVersionHash) {
                throw new Error("Failed to commit proof portion");
            }

            // Case 1: Proof is complete and valid
            if (
                !result.err &&
                result.val.length === 0 &&
                !preparedProof.includes("admit.")
            ) {
                const updatedProofVersion = currentSession.proofVersions.get(
                    updatedProofVersionHash
                );
                if (!updatedProofVersion) {
                    throw new Error("Proof version not found");
                }
                updatedProofVersion.validProofStepsPrefix = preparedProofLines
                    .map((line) => line.replace("Proof.", ""))
                    .map((line) => line.split("."))
                    .flat()
                    .map((step) => step.trim())
                    .filter((step) => step.length > 0)
                    .map((step) => `${step}.`);

                updatedProofVersion.isIncomplete = false;

                return {
                    success: true,
                    message: "Proof complete and valid",
                    proof: preparedProof,
                    goals: [],
                    hash: updatedProofVersionHash,
                };
            }

            if (
                !result.err &&
                result.val.length === 0 &&
                preparedProof.includes("admit.")
            ) {
                return {
                    success: true,
                    message: "Proof is incomplete but valid so far. ",
                    proof: preparedProof,
                    goals: [],
                };
            }

            // Case 2: Proof has remaining goals (incomplete but valid so far)
            if (
                (!result.err && result.val.length > 0) ||
                (preparedProof.includes("admit.") &&
                    !result.err &&
                    result.val.length === 0) ||
                (result.err && result.val.name === "stack_subgoals")
            ) {
                const updatedProofVersion = currentSession.proofVersions.get(
                    updatedProofVersionHash
                );
                if (!updatedProofVersion) {
                    throw new Error("Proof version not found");
                }
                if (preparedProof.includes("admit.")) {
                    // get prefix of proof lines before admit
                    const prefixOfProofLines = preparedProofLines.slice(
                        0,
                        preparedProofLines.indexOf("admit.") + 1
                    );
                    updatedProofVersion.validProofStepsPrefix =
                        prefixOfProofLines
                            .map((line) => line.replace("Proof.", ""))
                            .map((line) => line.split("."))
                            .flat()
                            .map((step) => step.trim())
                            .filter((step) => step.length > 0)
                            .map((step) => `${step}.`);
                } else {
                    updatedProofVersion.validProofStepsPrefix =
                        preparedProofLines
                            .map((line) => line.split("."))
                            .flat()
                            .map((step) => step.trim())
                            .filter((step) => step.length > 0)
                            .map((step) => `${step}.`);
                }
                if (result.ok){
                    const currentGoals = result.val;
                    return {
                        success: true,
                        message: "Proof is incomplete but valid so far",
                        hash: updatedProofVersionHash,
                        proof: preparedProof,
                        goals: currentGoals,
                    };
                }
                if (result.err && result.val.name === "stack_subgoals") {
                    let messageToSend = "Your proof is incomplete but valid so far. It has the following goal at the depth ";
                    const message = JSON.parse(result.val.message);
                    let apiGoals: ApiGoal[] = [];
                    for (const kek of message) {
                        const depth = kek[0];
                        const goals = kek[1];
                        if (goals.length > 0) {
                            apiGoals = goals.map((goal: ProofGoal) => ({
                                conclusion: goal.ty.toString(),
                                hypothesis: goal.hyps.map((hyp) => hypToString(hyp)),
                            }));
                            messageToSend += `${depth}:`;
                            break;
                        }
                    }




                    return {
                        success: true,
                        message: messageToSend,
                        hash: updatedProofVersionHash,
                        proof: preparedProof,
                        goals: apiGoals
                    };
                }
            }

            // Case 3: Proof has errors
            if (result.err) {
                console.log(
                    `Controller: Proof has errors ${JSON.stringify(result)}`
                );
                const proofStartLine =
                    currentSession.filePrefixContent.length + 1; // Proof.
                const errorousLineNumber = result.val.location?.start.line;
                if (!errorousLineNumber) {
                    throw new Error("Errorous line not found");
                }
                const errorousLineNumberInProof =
                    errorousLineNumber - proofStartLine - 1;
                const errorMessage = result.val.message;

                console.log(`Controller: Proof start line: ${proofStartLine}`);
                console.log(
                    `Controller: source file prefix content: ${currentSession.filePrefixContent.length}`
                );
                console.log(
                    `Controller: source file prefix content: ${currentSession.filePrefixContent[currentSession.filePrefixContent.length - 1]}`
                );
                console.log(
                    `Controller: Errorous line number: ${errorousLineNumber}`
                );
                console.log(`Controller: Error message: ${errorMessage}`);

                const proofContent = currentSession.proofVersions.get(
                    updatedProofVersionHash
                )?.proofContent;
                if (!proofContent) {
                    throw new Error("Proof content not found");
                }

                console.log(`Controller: Proof content: ${proofContent}`);
                console.log(
                    `Controller: Errorous line number in proof: ${errorousLineNumberInProof}`
                );

                const validProofPrefixLines = currentSession.proofVersions
                    .get(updatedProofVersionHash)
                    ?.proofContent.slice(0, errorousLineNumberInProof);
                if (!validProofPrefixLines) {
                    throw new Error("Valid proof prefix lines not found");
                }
                console.log(
                    `Controller: Valid proof prefix lines: ${validProofPrefixLines}`
                );
                const validProofPortion = validProofPrefixLines.join("\n");
                // Check the valid proof portion
                console.log(
                    `Controller: Valid proof portion: ${validProofPortion}`
                );

                const preparedValidProofPortion =
                    prepareProofToCheck(validProofPortion);
                console.log(
                    `Controller: Prepared valid proof portion: ${preparedValidProofPortion}`
                );
                const preparedValidProofPortionLines =
                    preparedValidProofPortion.split("\n");

                const positionToCheckAtForValidPrefix = {
                    line:
                        auxFileContent.length +
                        1 +
                        preparedValidProofPortionLines.length,
                    character:
                        preparedValidProofPortionLines.at(-1)?.length || 0,
                };

                console.log(
                    `Controller: Position to check at for valid prefix: ${JSON.stringify(positionToCheckAtForValidPrefix)}`
                );

                const resultOfCheckingValidPrefix =
                    await this.coqProjectObserverService.checkCoqProof(
                        preparedValidProofPortion,
                        currentSession.auxFileUri,
                        currentSession.filePrefixContent,
                        currentSession.auxFileVersionNumber,
                        positionToCheckAtForValidPrefix
                    );

                if (resultOfCheckingValidPrefix.err) {
                    throw new Error(
                        `Failed to check valid proof portion: ${resultOfCheckingValidPrefix.val.message}`
                    );
                }

                currentSession.auxFileVersionNumber =
                    currentSession.auxFileVersionNumber + 2;
                const updatedProofVersionHashForValidPrefix =
                    await this.sessionManager.commitProofPortion(
                        sessionId,
                        validProofPrefixLines,
                        currentSession.auxFileVersionNumber + 1,
                        updatedProofVersionHash
                    );

                if (!updatedProofVersionHashForValidPrefix) {
                    throw new Error("Failed to commit valid proof portion");
                }

                return {
                    success: false,
                    message: `Proof contains errors ${errorMessage} at L${errorousLineNumber}`,
                    validPrefix: preparedValidProofPortion,
                    attemptedProof: preparedProof,
                    goals: resultOfCheckingValidPrefix.val,
                    hash: updatedProofVersionHashForValidPrefix,
                };
            } else {
                return {
                    success: false,
                    message: "Failed to check proof",
                    error: {
                        message: "Unknown error",
                    },
                };
            }
        } catch (error) {
            return {
                success: false,
                message: "Failed to check proof",
                error: {
                    message:
                        error instanceof Error ? error.message : String(error),
                },
            };
        }
    }

    /** Retrieves all objects (theorems, definitions, etc.) from the current session's file.
     * Uses the PrintAllCoqCommand to list all objects in the file.
     */
    @Get("/get-objects")
    async getObjectsInFile(
        @Required() @QueryParams("coqSessionId") sessionId: string
    ): Promise<any> {
        const session = await this.sessionManager.getSession(sessionId);
        if (!session) {
            return { message: "Session not found" };
        }

        const command = new PrintAllCoqCommand().toString().split("\n");
        const auxFileContent = session.filePrefixContent;
        const positionToCheckAt = {
            line: auxFileContent.length + command.length,
            character: -1 + (command.at(-1)?.length || 0),
        };

        try {
            const result = await this.coqProjectObserverService.runCoqCommand(
                session.filePrefixContent,
                new PrintAllCoqCommand(),
                session.auxFileVersionNumber,
                session.auxFileUri,
                positionToCheckAt
            );

            return {
                message: "Objects retrieved successfully",
                objects: result,
            };
        } catch (error) {
            return {
                message: "Failed to get objects",
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /** Searches for a pattern in the current session's file.
     * Uses the SearchCoqCommand to find matches for the given pattern.
     */
    @Get("/search-pattern")
    async runCommandInFile(
        @Required() @QueryParams("pattern") pattern: string,
        @Required() @QueryParams("coqSessionId") sessionId: string
    ): Promise<any> {
        const session = await this.sessionManager.getSession(sessionId);
        if (!session) {
            return { success: false, message: "Session not found" };
        }

        const command = new SearchCoqCommand(pattern).toString().split("\n");
        const auxFileContent = session.filePrefixContent;
        const positionToCheckAt = {
            line: auxFileContent.length + command.length,
            character: -1 + (command.at(-1)?.length || 0),
        };

        try {
            const result = await this.coqProjectObserverService.runCoqCommand(
                session.filePrefixContent,
                new SearchCoqCommand(pattern),
                session.auxFileVersionNumber,
                session.auxFileUri,
                positionToCheckAt
            );

            return {
                message: "Pattern searched successfully",
                result: result,
            };
        } catch (error) {
            return {
                message: "Failed to search pattern",
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /** Prints the type and definition of a term in the current session's file.
     * Uses the PrintCoqCommand to display information about the specified term.
     */
    @Get("/print-term")
    async printTermInFile(
        @Required() @QueryParams("term") term: string,
        @Required() @QueryParams("coqSessionId") sessionId: string
    ): Promise<any> {
        try {
            const session = await this.sessionManager.getSession(sessionId);
            if (!session) {
                return { success: false, message: "Session not found" };
            }

            const command = new PrintCoqCommand(term).toString().split("\n");
            const auxFileContent = session.filePrefixContent;
            const positionToCheckAt = {
                line: auxFileContent.length + command.length,
                character: -1 + (command.at(-1)?.length || 0),
            };

            const execResult =
                await this.coqProjectObserverService.runCoqCommand(
                    session.filePrefixContent,
                    new PrintCoqCommand(term),
                    session.auxFileVersionNumber,
                    session.auxFileUri,
                    positionToCheckAt
                );

            return {
                message: "Term printed successfully",
                result: execResult,
            };
        } catch (error) {
            return {
                message: "Failed to print term",
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /** Checks if a term is well-typed in the current session's file.
     * Uses the CheckCoqCommand to verify the term's type correctness.
     */
    @Get("/check-term")
    async checkTermInFile(
        @Required() @QueryParams("term") term: string,
        @Required() @QueryParams("coqSessionId") sessionId: string
    ): Promise<any> {
        try {
            const session = await this.sessionManager.getSession(sessionId);
            if (!session) {
                return { success: false, message: "Session not found" };
            }

            const command = new CheckCoqCommand(term).toString().split("\n");
            const auxFileContent = session.filePrefixContent;
            const positionToCheckAt = {
                line: auxFileContent.length + command.length,
                character: -1 + (command.at(-1)?.length || 0),
            };

            const execResult =
                await this.coqProjectObserverService.runCoqCommand(
                    session.filePrefixContent,
                    new CheckCoqCommand(term),
                    session.auxFileVersionNumber,
                    session.auxFileUri,
                    positionToCheckAt
                );

            return {
                message: "Term checked successfully",
                result: execResult,
            };
        } catch (error) {
            return {
                message: "Failed to check term",
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    @Get("/about-term")
    async aboutTermInFile(
        @Required() @QueryParams("term") term: string,
        @Required() @QueryParams("coqSessionId") sessionId: string
    ): Promise<any> {
        try {
            const session = await this.sessionManager.getSession(sessionId);
            if (!session) {
                return { success: false, message: "Session not found" };
            }

            const command = new AboutCoqCommand(term).toString().split("\n");
            const auxFileContent = session.filePrefixContent;
            const positionToCheckAt = {
                line: auxFileContent.length + command.length,
                character: -1 + (command.at(-1)?.length || 0),
            };

            const execResult =
                await this.coqProjectObserverService.runCoqCommand(
                    session.filePrefixContent,
                    new AboutCoqCommand(term),
                    session.auxFileVersionNumber,
                    session.auxFileUri,
                    positionToCheckAt
                );

            return {
                message: "Term explained successfully",
                result: execResult,
            };
        } catch (error) {
            return {
                message: "Failed to explain term",
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /** Retrieves premises (dependencies) for a theorem from a file.
     * Returns relevant premises that could be useful for proving the given goal,
     * with an optional limit on the number of premises returned.
     */
    @Get("/get-premises")
    async getPremisesFromFile(
        @Required() @QueryParams("goal") goal: string,
        @Required() @QueryParams("filePath") filePath: string,
        @Required() @QueryParams("coqSessionId") sessionId: string,
        @QueryParams("maxNumberOfPremises") maxNumberOfPremises: number = 7
    ): Promise<any> {
        try {
            const session = await this.sessionManager.getSession(sessionId);
            if (!session) {
                return { success: false, message: "Session not found" };
            }

            // Parse the goal from the query string
            const parsedGoal: ApiGoal = JSON.parse(goal);
            console.log(
                `Controller: Getting premises for goal: ${JSON.stringify(parsedGoal)}`
            );

            const targetTheoremName = session.theoremName;
            const targetFilePath = session.sourceFilePath;

            const premises =
                await this.coqProjectObserverService.getPremisesFromFile(
                    filePath,
                    targetFilePath,
                    parsedGoal,
                    targetTheoremName,
                    session.auxFileUri
                );

            return {
                premises: premises.slice(0, maxNumberOfPremises),
            };
        } catch (error) {
            return {
                message: "Failed to get premises",
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /** Initializes a new proof session for a theorem.
     * Creates a new session for working on a specific theorem from a file.
     */
    @Get("/start-session")
    @UseBefore(FilePathMiddleware)
    async startSession(
        @Required() @QueryParams("filePath") filePath: string,
        @Required() @QueryParams("theoremName") theoremName: string
    ): Promise<any> {
        const result = await this.sessionManager.startSession(
            filePath,
            theoremName,
            this.coqProjectObserverService
        );
        return result;
    }

    /** Retrieves information about a specific session.
     * Returns the session object containing all its current state and proof versions.
     */
    @Get("/get-session")
    async getSession(
        @Required() @QueryParams("coqSessionId") sessionId: string
    ): Promise<any> {
        const session = await this.sessionManager.getSession(sessionId);
        return {
            session: session,
        };
    }

    /** Closes a session and cleans up associated resources.
     * Deletes the auxiliary file and removes the session from the session manager.
     */
    @Get("/finish-session")
    async finishSession(
        @Required() @QueryParams("coqSessionId") sessionId: string
    ): Promise<any> {
        try {
            const session = await this.sessionManager.getSession(sessionId);
            if (!session) {
                return { success: false, message: "Session not found" };
            }

            // Clean up the auxiliary file if it exists
            if (session.auxFileUri) {
                try {
                    unlinkSync(session.auxFileUri.fsPath);
                } catch (error) {
                    console.error("Failed to delete auxiliary file:", error);
                }
            }

            await this.sessionManager.closeSession(sessionId);
            return {
                success: true,
                message: "Session finished and resources cleaned up",
            };
        } catch (error) {
            return {
                success: false,
                message: "Failed to finish session",
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /** Retrieves a specific proof version by its hash.
     * Returns the proof version object associated with the given hash in the session.
     */
    @Get("/proof-version-by-hash")
    async getProofVersionByHash(
        @Required() @QueryParams("sessionId") sessionId: string,
        @Required() @QueryParams("proofVersionHash") proofVersionHash: string
    ): Promise<any> {
        const session = await this.sessionManager.getSession(sessionId);
        if (!session) {
            return { success: false, message: "Session not found" };
        }

        const proofVersion = session.proofVersions.get(proofVersionHash);
        return { proofVersion: proofVersion };
    }

    /** Returns the complete proof history tree for a session.
     * Constructs and returns a tree structure representing all proof versions and their relationships.
     */
    @Get("/proof-history")
    async getProofHistory(
        @Required() @QueryParams("coqSessionId") sessionId: string
    ): Promise<any> {
        const session = await this.sessionManager.getSession(sessionId);
        if (!session) {
            return { success: false, message: "Session not found" };
        }

        const rootHash = Array.from(session.proofVersions.entries()).find(
            ([_hash, version]) => version.parentHash === null
        )?.[0];

        if (!rootHash) {
            return { success: false, message: "No root proof version found" };
        }

        const buildProofTree = (hash: string): ProofTreeNode | null => {
            const version = session.proofVersions.get(hash);
            if (!version) {
                return null;
            }

            return {
                hash,
                content: version.proofContent,
                steps: version.proofSteps,
                children: version.childrenHashes.map((childHash) =>
                    buildProofTree(childHash)
                ),
            };
        };

        const proofTree = buildProofTree(rootHash);
        return { success: true, proofTree };
    }
}
