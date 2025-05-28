import { Mutex } from "async-mutex";
import { appendFileSync, writeFileSync } from "fs";
import { Err, Ok, Result } from "ts-results";
import { Position } from "vscode-languageclient";

import { CoqLspClient } from "../../coqLsp/coqLspClient";
import {
    CoqLspError,
    Message,
    PpString,
    ProofGoal,
} from "../../coqLsp/coqLspTypes";

import { Uri } from "../../utils/uri";

interface CoqCodeExecError {
    message: string;
    location?: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    } | null;
    name?: string;
}

export type CoqCodeExecGoalResult = Result<ProofGoal[], CoqCodeExecError>;
export type CoqCommandExecResult = Result<string[], CoqCodeExecError>;

export interface CoqCodeExecutorInterface {
    /**
     * Executes the given Coq code in the specified environment and returns either
     * the resulting proof goals or an error message.
     * @param fileUri URI of the file containing the code
     * @param sourceFileContentPrefix Content that should precede the code being checked
     * @param positionToCheckAt Position in the document where to check the code
     * @param coqCode Coq code to execute
     * @param documentVersion Version number of the document
     * @param coqLspTimeoutMillis Timeout in milliseconds for the LSP request
     * @returns Promise resolving to either proof goals or an error message
     */
    getGoalAfterCoqCode(
        fileUri: Uri,
        sourceFileContentPrefix: string[],
        positionToCheckAt: Position,
        coqCode: string,
        documentVersion: number,
        coqLspTimeoutMillis: number
    ): Promise<CoqCodeExecGoalResult>;

    /**
     * Executes the given Coq command in the specified environment
     * and returns the messages that were produced by the command.
     * @param sourceDirPath Parent directory of the source file
     * @param sourceFileContentPrefix Prefix with which to typecheck the code
     * @param prefixEndPosition The position after the prefix end
     * @param coqCommand Coq command to execute
     */
    executeCoqCommand(
        fileUri: Uri,
        sourceFileContentPrefix: string[],
        positionToCheckAt: Position,
        coqCode: string,
        documentVersion: number,
        coqLspTimeoutMillis: number
    ): Promise<CoqCommandExecResult>;
}

export class CoqCodeExecutor implements CoqCodeExecutorInterface {
    private mutex: Mutex = new Mutex();

    constructor(private coqLspClient: CoqLspClient) {}

    /** Executes Coq code and returns resulting goals or errors with timeout */
    async getGoalAfterCoqCode(
        fileUri: Uri,
        sourceFileContentPrefix: string[],
        positionToCheckAt: Position,
        coqCode: string,
        documentVersion: number,
        coqLspTimeoutMillis: number = 150000
    ): Promise<CoqCodeExecGoalResult> {
        return this.executeWithTimeout(
            this.getGoalAfterCoqCodeUnsafe(
                fileUri,
                sourceFileContentPrefix,
                positionToCheckAt,
                coqCode,
                documentVersion,
                coqLspTimeoutMillis
            ),
            coqLspTimeoutMillis
        );
    }

    async executeCoqCommand(
        fileUri: Uri,
        sourceFileContentPrefix: string[],
        positionToCheckAt: Position,
        coqCode: string,
        documentVersion: number,
        coqLspTimeoutMillis: number = 1500000
    ): Promise<CoqCommandExecResult> {
        return this.executeWithTimeout(
            this.executeCoqCommandUnsafe(
                fileUri,
                sourceFileContentPrefix,
                positionToCheckAt,
                coqCode,
                documentVersion,
                coqLspTimeoutMillis
            ),
            coqLspTimeoutMillis
        );
    }

    /** Executes a promise with a timeout */
    private async executeWithTimeout<T>(
        promise: Promise<T>,
        timeoutMillis: number
    ): Promise<T> {
        return await this.mutex.runExclusive(async () => {
            const timeoutPromise = new Promise<T>((_, reject) => {
                setTimeout(() => {
                    reject(
                        new Error(
                            `executeCoqCode timed out after ${timeoutMillis} milliseconds`
                        )
                    );
                }, timeoutMillis);
            });

            return Promise.race([promise, timeoutPromise]);
        });
    }

    /** Core implementation of Coq code execution and goal retrieval */
    private async getGoalAfterCoqCodeUnsafe(
        fileUri: Uri,
        sourceFileContentPrefix: string[],
        positionToCheckAt: Position,
        coqCode: string,
        documentVersion: number,
        _coqLspTimeoutMillis: number
    ): Promise<CoqCodeExecGoalResult> {
        console.log(
            `CoqCodeExecutor.getGoalAfterCoqCodeUnsafe: Writing source file content. Coq code: ${coqCode}`
        );
        const sourceFileContent = sourceFileContentPrefix.join("\n");
        // writeFileSync(fileUri.fsPath, sourceFileContent);
        await this.coqLspClient.openTextDocument(fileUri);

        console.log(
            `CoqCodeExecutor.getGoalAfterCoqCodeUnsafe: Appending suffix. Document version: ${documentVersion}`
        );

        const appendedSuffix = `\n\n${coqCode}`;
        appendFileSync(fileUri.fsPath, appendedSuffix);

        console.log(
            `CoqCodeExecutor.getGoalAfterCoqCodeUnsafe: Updating text document. Appended suffix: ${appendedSuffix}`
        );

        const diagnostic = await this.coqLspClient.updateTextDocument(
            sourceFileContentPrefix,
            appendedSuffix,
            fileUri,
            documentVersion + 1
        );

        if (diagnostic) {
            console.log(
                `CoqCodeExecutor.getGoalAfterCoqCodeUnsafe: Diagnostic: ${diagnostic}`
            );

            writeFileSync(fileUri.fsPath, sourceFileContent);

            console.log(
                `CoqCodeExecutor.executeCoqCommandUnsafe: Updating text document. Document version: ${documentVersion + 2}`
            );

            await this.coqLspClient.updateTextDocument(
                sourceFileContentPrefix,
                "",
                fileUri,
                documentVersion + 2
            );

            return Err({
                message: diagnostic.ppMessage,
                location: {
                    start: {
                        line: diagnostic.range.start.line,
                        character: diagnostic.range.start.character,
                    },
                    end: {
                        line: diagnostic.range.end.line,
                        character: diagnostic.range.end.character,
                    },
                },
            });
        }

        console.log(
            `CoqCodeExecutor.getGoalAfterCoqCodeUnsafe: Getting goals. Document version: ${documentVersion + 1}`
        );

        console.log(
            `Checking code at position L${positionToCheckAt.line}:C${positionToCheckAt.character}`
        )

        const goal = await this.coqLspClient.getGoalsAtPoint(
            positionToCheckAt,
            fileUri,
            documentVersion + 1
        );

        console.log(
            `CoqCodeExecutor.getGoalAfterCoqCodeUnsafe: Got goals. Document version: ${documentVersion + 1}`
        );

        writeFileSync(fileUri.fsPath, sourceFileContent);

        console.log(
            `CoqCodeExecutor.getGoalAfterCoqCodeUnsafe: Updating text document. Document version: ${documentVersion + 2}`
        );
        await this.coqLspClient.updateTextDocument(
            sourceFileContentPrefix,
            "",
            fileUri,
            documentVersion + 2
        );

        if (goal.ok) {
            console.log(`Returning goals: ${goal.val}`)
            return Ok(goal.val);
        } else {
            return Err({
                name: goal.val.name,
                message: goal.val.message,
                line: undefined,
            });
        }
    }

    private formatLspMessages(
        messages: PpString[] | Message<PpString>[]
    ): string[] {
        return messages.map((message) => {
            if (typeof message === "string") {
                return message;
            }

            return (message as Message<PpString>).text.toString();
        });
    }

    private async executeCoqCommandUnsafe(
        fileUri: Uri,
        sourceFileContentPrefix: string[],
        positionToCheckAt: Position,
        coqCode: string,
        documentVersion: number,
        _coqLspTimeoutMillis: number = 150000
    ): Promise<CoqCommandExecResult> {
        await this.coqLspClient.openTextDocument(fileUri);

        const appendedSuffix = `\n\n${coqCode}`;
        console.log(
            `CoqCodeExecutor.executeCoqCommandUnsafe: Appending suffix: ${appendedSuffix}`
        );
        appendFileSync(fileUri.fsPath, appendedSuffix);

        // update the text document with the coq code
        console.log(
            `CoqCodeExecutor.executeCoqCommandUnsafe: Updating text document. Document version: ${documentVersion + 1}`
        );
        const diagnostic = await this.coqLspClient.updateTextDocument(
            sourceFileContentPrefix,
            appendedSuffix,
            fileUri,
            documentVersion + 1
        );

        console.log(
            `CoqCodeExecutor.executeCoqCommandUnsafe: Diagnostic: ${diagnostic}`
        );

        if (diagnostic) {
            // TODO: Create a new function for this hack
            const sourceFileContent = sourceFileContentPrefix.join("\n");

            writeFileSync(fileUri.fsPath, sourceFileContent);

            console.log(
                `CoqCodeExecutor.executeCoqCommandUnsafe: Updating text document. Document version: ${documentVersion + 2}`
            );

            await this.coqLspClient.updateTextDocument(
                sourceFileContentPrefix,
                "",
                fileUri,
                documentVersion + 2
            );
            return Err({
                message: diagnostic.ppMessage,
                location: {
                    start: {
                        line: diagnostic.range.start.line,
                        character: diagnostic.range.start.character,
                    },
                    end: {
                        line: diagnostic.range.end.line,
                        character: diagnostic.range.end.character,
                    },
                },
            });
        }

        console.log(
            `CoqCodeExecutor.executeCoqCommandUnsafe: Getting message at point. Document version: ${documentVersion + 1}`
        );
        const message = await this.coqLspClient.getMessageAtPoint(
            positionToCheckAt,
            fileUri,
            documentVersion + 1
        );

        console.log(
            `CoqCodeExecutor.executeCoqCommandUnsafe: Got message at point. Document version: ${documentVersion + 1}`
        );

        console.log(
            `CoqCodeExecutor.executeCoqCommandUnsafe: Message: ${message}`
        );

        const sourceFileContent = sourceFileContentPrefix.join("\n");

        writeFileSync(fileUri.fsPath, sourceFileContent);

        console.log(
            `CoqCodeExecutor.executeCoqCommandUnsafe: Updating text document. Document version: ${documentVersion + 2}`
        );

        await this.coqLspClient.updateTextDocument(
            sourceFileContentPrefix,
            "",
            fileUri,
            documentVersion + 2
        );

        console.log(
            `CoqCodeExecutor.executeCoqCommandUnsafe: Updated text document. Document version: ${documentVersion + 2}`
        );

        if (message instanceof CoqLspError) {
            return Err({
                message: message.toString(),
            });
        }

        return Ok(this.formatLspMessages(message));
    }
}
