import { Injectable } from "@tsed/di";
import { Mutex } from "async-mutex";
import * as crypto from "crypto";
import { unlinkSync, writeFileSync } from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";

import { Uri } from "../../utils/uri";
import { makeAuxFileName } from "../utils/proofPreparationUtil";

import { CoqProjectObserverService } from "./coqProjectObserverService";

interface Session {
    id: string;
    sourceFilePath: string;
    theoremName: string;
    theoremStatement: string;
    auxFileUri: Uri;
    auxFileVersionNumber: number;
    filePrefixContent: string[];
    proofVersions: Map<
        string,
        {
            proofContent: string[]; // lines of Coq code
            proofSteps: string[];
            parentHash: string | null;
            childrenHashes: string[];
        }
    >;
}

@Injectable()
export class SessionManager {
    private sessions: Map<string, Session> = new Map();
    private mutex = new Mutex();

    constructor() {
        console.log("SessionManager initialized");
    }

    /** Initializes a new proof session with auxiliary file and initial theorem state */
    async startSession(
        sourceFilePath: string,
        theoremName: string,
        coqProjectObserverService: CoqProjectObserverService
    ): Promise<{ sessionId: string; proofVersionHash: string }> {
        console.log(
            `SessionManager.startSession: Starting session for theorem ${theoremName} in ${sourceFilePath}`
        );

        return this.mutex.runExclusive(async () => {
            const projectRoot = coqProjectObserverService.getProjectRoot();
            const auxFileUri = makeAuxFileName(projectRoot, sourceFilePath);
            const absoluteAuxFileUri = Uri.fromPath(
                path.join(projectRoot, auxFileUri.fsPath)
            );

            console.log(
                `SessionManager.startSession: Using auxiliary file ${absoluteAuxFileUri.fsPath}`
            );

            const sourceFileContentPrefix =
                await coqProjectObserverService.getSourceFileContentPrefix(
                    sourceFilePath,
                    theoremName
                );
            console.log(
                `SessionManager.startSession: Retrieved ${sourceFileContentPrefix.length} lines of prefix content`
            );

            const theoremStatement =
                await coqProjectObserverService.getTheoremStatement(
                    sourceFilePath,
                    theoremName
                );
            console.log(
                `SessionManager.startSession: Retrieved theorem statement: ${theoremStatement.slice(0, 50)}${theoremStatement.length > 50 ? "..." : ""}`
            );

            const sourceFileContentPrefixWithTheorem =
                sourceFileContentPrefix.concat([theoremStatement]);
            writeFileSync(
                absoluteAuxFileUri.fsPath,
                sourceFileContentPrefixWithTheorem.join("\n")
            );
            console.log(
                `SessionManager.startSession: Created auxiliary file with ${sourceFileContentPrefixWithTheorem.length} lines`
            );

            const sessionId = uuidv4();
            this.sessions.set(sessionId, {
                id: sessionId,
                sourceFilePath,
                theoremName,
                theoremStatement,
                auxFileUri: absoluteAuxFileUri,
                auxFileVersionNumber: 1,
                filePrefixContent: sourceFileContentPrefixWithTheorem,
                proofVersions: new Map(),
            });

            const initialProofVersion = {
                proofContent: [],
                proofSteps: [],
                parentHash: null,
                childrenHashes: [],
            };
            const hash = crypto
                .createHash("sha256")
                .update(JSON.stringify(initialProofVersion.proofContent))
                .update(initialProofVersion.parentHash || "")
                .digest("hex");
            this.sessions
                .get(sessionId)
                ?.proofVersions.set(hash, initialProofVersion);

            console.log(
                `SessionManager.startSession: Created session with ID ${sessionId}`
            );
            return { sessionId, proofVersionHash: hash };
        });
    }

    /** Retrieves a session by its ID */
    async getSession(sessionId: string): Promise<Session | undefined> {
        console.log(`SessionManager.getSession: Getting session ${sessionId}`);
        return this.mutex.runExclusive(async () => {
            const session = this.sessions.get(sessionId);
            if (session) {
                console.log(
                    `SessionManager.getSession: Found session for theorem ${session.theoremName}`
                );
            } else {
                console.log(
                    `SessionManager.getSession: Session ${sessionId} not found`
                );
            }
            return session;
        });
    }

    /** Commits a new proof portion to the session's version history */
    async commitProofPortion(
        sessionId: string,
        proofPortion: string[],
        newVersion: number,
        parentHash: string
    ): Promise<string | undefined> {
        return this.mutex.runExclusive(async () => {
            proofPortion = proofPortion.map((line) =>
                line.replace("Proof.", "")
            );
            console.log(
                `SessionManager.commitProofStep: Committing portion for session ${sessionId}: ${proofPortion}`
            );

            const proofPortionSteps = proofPortion
                .map((line) => line.split("."))
                .flat()
                .map((step) => `${step}.`);

            const initialProofVersionHash = this.sessions
                .get(sessionId)
                ?.proofVersions.keys()
                .next().value;

            const findPrefixProofVersion = (
                session: Session,
                hash: string,
                proofPortionSteps: string[]
            ): string | undefined => {
                const proofVersion = session.proofVersions.get(hash);
                if (!proofVersion) {
                    return undefined;
                }

                const isPrefix = proofVersion.proofSteps.every(
                    (step, i) => proofPortionSteps[i] === step
                );

                if (
                    isPrefix &&
                    proofVersion.proofSteps.length <= proofPortionSteps.length
                ) {
                    return hash;
                }

                for (const childHash of proofVersion.childrenHashes) {
                    const result = findPrefixProofVersion(
                        session,
                        childHash,
                        proofPortionSteps
                    );
                    if (result) {
                        return result;
                    }
                }

                return initialProofVersionHash;
            };

            const session = this.sessions.get(sessionId);
            if (!session) {
                console.error(
                    `SessionManager.commitProofStep: Session ${sessionId} not found`
                );
                return undefined;
            }

            const foundPrefixVersionHash = findPrefixProofVersion(
                session,
                parentHash,
                proofPortionSteps
            );
            if (!foundPrefixVersionHash) {
                console.error(
                    `SessionManager.commitProofStep: No valid prefix version found`
                );
                return undefined;
            }

            const updatedProofVersion = {
                proofContent: proofPortion,
                proofSteps: proofPortionSteps,
                parentHash: foundPrefixVersionHash,
                childrenHashes: [],
            };

            const hash = crypto
                .createHash("sha256")
                .update(JSON.stringify(updatedProofVersion.proofContent))
                .update(updatedProofVersion.parentHash || "")
                .digest("hex");
            const foundPrefixVersion = session.proofVersions.get(
                foundPrefixVersionHash
            );
            if (!foundPrefixVersion) {
                console.error(
                    `SessionManager.commitProofStep: Found prefix version ${foundPrefixVersionHash} not found`
                );
                return undefined;
            }
            foundPrefixVersion.childrenHashes.push(hash);
            session.proofVersions.set(hash, updatedProofVersion);
            session.auxFileVersionNumber = newVersion;

            return hash;
        });
    }

    /** Closes a session and cleans up its auxiliary file */
    async closeSession(sessionId: string): Promise<void> {
        console.log(
            `SessionManager.closeSession: Closing session ${sessionId}`
        );

        await this.mutex.runExclusive(async () => {
            const session = this.sessions.get(sessionId);
            if (session) {
                const auxFilePath = session.auxFileUri.fsPath;
                try {
                    unlinkSync(auxFilePath);
                    console.log(
                        `SessionManager.closeSession: Deleted auxiliary file ${auxFilePath}`
                    );
                } catch (error) {
                    console.error(
                        `SessionManager.closeSession: Failed to delete auxiliary file: ${error}`
                    );
                }
                this.sessions.delete(sessionId);
                console.log(
                    `SessionManager.closeSession: Session ${sessionId} deleted`
                );
            } else {
                console.log(
                    `SessionManager.closeSession: Session ${sessionId} not found`
                );
            }
        });
    }
}
