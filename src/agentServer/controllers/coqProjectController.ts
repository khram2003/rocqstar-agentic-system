import { Controller, Get, QueryParams, UseBefore } from "@tsed/common";
import { Required } from "@tsed/schema";
import { unlinkSync } from "fs";

import { FilePathMiddleware } from "../middlewares/filePathMiddleware";
import { ApiGoal } from "../models/apiGoal";
// import {
//   CheckCoqCommand,
//   PrintAllCoqCommand,
//   PrintCoqCommand,
//   SearchCoqCommand,
// } from "../services/coqCommandType";
import { CoqProjectObserverService } from "../services/coqProjectObserverService";
import { SessionManager } from "../services/sessionManager";
import { prepareProofToCheck } from "../utils/proofPreparationUtil";

interface ProofError {
    line?: number;
    message: string;
    location?: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    } | null;
}

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

    /** Retrieves theorem names from a specified file, optionally using a session's auxiliary file */
    @Get("/theorem-names")
    @UseBefore(FilePathMiddleware)
    async getTheoremNamesFromFile(
        @Required() @QueryParams("filePath") filePath: string,
        @QueryParams("sessionId") sessionId?: string
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

    /** Retrieves theorem information from a specific session and proof version */
    @Get("/session-theorem")
    // @UseBefore(FilePathMiddleware)
    async retrieveTheoremFromSession(
        @Required() @QueryParams("sessionId") sessionId: string,
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

    /** Retrieves complete theorem with proof from a source file */
    @Get("/theorem")
    @UseBefore(FilePathMiddleware)
    async retrieveCompleteTheoremFromFile(
        @Required() @QueryParams("filePath") filePath: string,
        @Required() @QueryParams("theoremName") theoremName: string
        // @Required() @QueryParams("sessionId") sessionId: string
    ): Promise<any> {
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

    /** Validates a proof in the context of a session and returns goals/errors */
    @Get("/check-proof")
    async checkProofInFile(
        @Required() @QueryParams("proof") proof: string,
        @Required() @QueryParams("sessionId") sessionId: string,
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
            const currentProof = currentProofVersion.proofContent;

            const auxFileContent = currentSession.filePrefixContent
                .concat(currentProof)
                .concat(preparedProofLines);

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

            // Case 1: Proof is complete and valid
            if (!result.err && result.val.length === 0) {
                return {
                    success: true,
                    message: "Proof complete and valid",
                    proof: preparedProof,
                    goals: [],
                    hash: updatedProofVersionHash,
                };
            }

            // Case 2: Proof has remaining goals (incomplete but valid so far)
            if (!result.err && result.val.length > 0) {
                const currentGoals = result.val;
                return {
                    success: true,
                    message: "Proof is incomplete but valid so far",
                    hash: updatedProofVersionHash,
                    proof: preparedProof,
                    goals: currentGoals,
                };
            }

            // // Case 3: Proof has errors
            // const error: ProofError = {
            //   message: typeof result.val === 'string' ? result.val : 'Unknown error'
            // };

            // // Try to extract line number from error message
            // const lineMatch = error.message.match(/line (\d+)/i);
            // if (lineMatch) {
            //   error.line = parseInt(lineMatch[1], 10);
            // }

            // // Log detailed debug information
            // console.log(`Proof check failed at position L${positionToCheckAt.line}:C${positionToCheckAt.character}`);
            // console.log(`Error message: ${error.message}`);
            // console.log(`Proof being checked: ${preparedProof}`);

            // await this.sessionManager.commitProofStep(sessionId, "reset", originalPrefix, originalVersion);

            // return {
            //   success: false,
            //   message: "Proof contains errors",
            //   error,
            //   validPrefix: originalPrefix.join("\n"),
            //   attemptedProof: preparedProof
            // };

            return {
                success: false,
                message: `Proof contains errors ${result.val}`,
                validPrefix: currentSession.filePrefixContent.join("\n"),
                attemptedProof: preparedProof,
            };
        } catch (error) {
            // Ensure we reset to original state in case of any error
            // if (currentSession) {
            //   await this.sessionManager.commitProofStep(
            //     sessionId,
            //     "reset",
            //     currentSession.proofState.typeCheckedAuxFilePrefix,
            //     currentSession.auxFileVersionNumber
            //   );
            // }
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

    // @Get("/get-objects")
    // @UseBefore(FilePathMiddleware)
    // async getObjectsInFile(
    //   @Required() @QueryParams("filePath") filePath: string,
    //   @Required() @QueryParams("sessionId") sessionId: string
    // ): Promise<any> {
    //   const session = await this.sessionManager.getSession(sessionId);
    //   if (!session) {
    //     return { message: "Session not found" };
    //   }

    //   try {
    //     // Pass the session's aux file URI and version to ensure proper context
    //     const execResult = await this.coqProjectObserverService.runCoqCommand(
    //       filePath,
    //       new PrintAllCoqCommand(),
    //       session.auxFileVersionNumber,
    //       session.auxFileUri
    //     );

    //     return {
    //       objects: execResult[0].split("\n").filter(line => line.trim() !== ""),
    //     };
    //   } catch (error) {
    //     return {
    //       message: "Failed to get objects",
    //       error: error instanceof Error ? error.message : String(error)
    //     };
    //   }
    // }

    // @Get("/search-pattern")
    // @UseBefore(FilePathMiddleware)
    // async runCommandInFile(
    //   @Required() @QueryParams("filePath") filePath: string,
    //   @Required() @QueryParams("pattern") pattern: string,
    //   @Required() @QueryParams("sessionId") sessionId: string
    // ): Promise<any> {
    //   try {
    //     const session = await this.sessionManager.getSession(sessionId);
    //     if (!session) {
    //       return { success: false, message: "Session not found" };
    //     }

    //     const execResult = await this.coqProjectObserverService.runCoqCommand(
    //       filePath,
    //       new SearchCoqCommand(pattern),
    //       session.auxFileVersionNumber,
    //       session.auxFileUri
    //     );

    //     return {
    //       pattern: pattern,
    //       result: execResult,
    //     };
    //   } catch (error) {
    //     return {
    //       message: "Failed to search pattern",
    //       error: error instanceof Error ? error.message : String(error)
    //     };
    //   }
    // }

    // @Get("/print-term")
    // @UseBefore(FilePathMiddleware)
    // async printTermInFile(
    //   @Required() @QueryParams("filePath") filePath: string,
    //   @Required() @QueryParams("term") term: string,
    //   @Required() @QueryParams("sessionId") sessionId: string
    // ): Promise<any> {
    //   try {
    //     const session = await this.sessionManager.getSession(sessionId);
    //     if (!session) {
    //       return { success: false, message: "Session not found" };
    //     }

    //     const execResult = await this.coqProjectObserverService.runCoqCommand(
    //       filePath,
    //       new PrintCoqCommand(term),
    //       session.auxFileVersionNumber,
    //       session.auxFileUri
    //     );

    //     return {
    //       term: term,
    //       result: execResult,
    //     };
    //   } catch (error) {
    //     return {
    //       message: "Failed to print term",
    //       error: error instanceof Error ? error.message : String(error)
    //     };
    //   }
    // }

    // @Get("/check-term")
    // @UseBefore(FilePathMiddleware)
    // async checkTermInFile(
    //   @Required() @QueryParams("filePath") filePath: string,
    //   @Required() @QueryParams("term") term: string,
    //   @Required() @QueryParams("sessionId") sessionId: string
    // ): Promise<any> {
    //   try {
    //     const session = await this.sessionManager.getSession(sessionId);
    //     if (!session) {
    //       return { success: false, message: "Session not found" };
    //     }

    //     const execResult = await this.coqProjectObserverService.runCoqCommand(
    //       filePath,
    //       new CheckCoqCommand(term),
    //       session.auxFileVersionNumber,
    //       session.auxFileUri
    //     );

    //     return {
    //       term: term,
    //       result: execResult,
    //     };
    //   } catch (error) {
    //     return {
    //       message: "Failed to check term",
    //       error: error instanceof Error ? error.message : String(error)
    //     };
    //   }
    // }

    /** Retrieves premises (dependencies) for a theorem from a file */
    @Get("/get-premises")
    @UseBefore(FilePathMiddleware)
    async getPremisesFromFile(
        @Required() @QueryParams("filePath") filePath: string,
        @Required() @QueryParams("theoremName") theoremName: string,
        @Required() @QueryParams("sessionId") sessionId: string,
        @QueryParams("maxNumberOfPremises") maxNumberOfPremises: number = 7
    ): Promise<any> {
        try {
            const session = await this.sessionManager.getSession(sessionId);
            if (!session) {
                return { success: false, message: "Session not found" };
            }

            const premises =
                await this.coqProjectObserverService.getPremisesFromFile(
                    filePath,
                    theoremName,
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

    /** Initializes a new proof session for a theorem */
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

    /** Retrieves information about a specific session */
    @Get("/get-session")
    async getSession(
        @Required() @QueryParams("sessionId") sessionId: string
    ): Promise<any> {
        const session = await this.sessionManager.getSession(sessionId);
        return {
            session: session,
        };
    }

    /** Closes a session and cleans up associated resources */
    @Get("/finish-session")
    async finishSession(
        @Required() @QueryParams("sessionId") sessionId: string
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

    /** Retrieves a specific proof version by its hash */
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

    /** Returns the complete proof history tree for a session */
    @Get("/proof-history")
    async getProofHistory(
        @Required() @QueryParams("sessionId") sessionId: string
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
