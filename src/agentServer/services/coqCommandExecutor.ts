import { Mutex } from "async-mutex";
import { appendFileSync, writeFileSync } from "fs";
// import * as path from "path";
import { Err, Ok, Result } from "ts-results";
import { Position } from "vscode-languageclient";

import { CoqLspClient } from "../../coqLsp/coqLspClient";
import { ProofGoal } from "../../coqLsp/coqLspTypes";

import { Uri } from "../../utils/uri";

export type CoqCodeExecError = string;
export type CoqCodeExecGoalResult = Result<ProofGoal[], CoqCodeExecError>;
export type CoqCommandExecResult = Result<ProofGoal[], CoqCodeExecError>;

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
    // executeCoqCommand(
    //     sourceDirPath: string,
    //     sourceFileContentPrefix: string[],
    //     prefixEndPosition: Position,
    //     coqCommand: string
    // ): Promise<CoqCommandExecResult>;
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

    // async executeCoqCommand(
    //     sourceDirPath: string,
    //     sourceFileContentPrefix: string[],
    //     prefixEndPosition: Position,
    //     coqCode: string,
    //     coqLspTimeoutMillis: number = 150000
    // ): Promise<CoqCommandExecResult> {
    //     return this.executeWithTimeout(
    //         this.executeCoqCommandUnsafe(
    //             sourceDirPath,
    //             sourceFileContentPrefix,
    //             prefixEndPosition,
    //             coqCode
    //         ),
    //         coqLspTimeoutMillis
    //     );
    // }

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
        const sourceFileContent = sourceFileContentPrefix.join("\n");
        writeFileSync(fileUri.fsPath, sourceFileContent);
        await this.coqLspClient.openTextDocument(fileUri);

        console.log(
            `CoqCodeExecutor.getGoalAfterCoqCodeUnsafe: Appending suffix. Document version: ${documentVersion}`
        );

        const appendedSuffix = `\n\n${coqCode}`;
        appendFileSync(fileUri.fsPath, appendedSuffix);

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

            return Err(diagnostic.ppMessage);
        }

        console.log(
            `CoqCodeExecutor.getGoalAfterCoqCodeUnsafe: Getting goals. Document version: ${documentVersion + 1}`
        );

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
            return Ok(goal.val);
        } else {
            return Err(goal.val.message);
        }
    }

    // private formatLspMessages(
    //     messages: PpString[] | Message<PpString>[]
    // ): string[] {
    //     return messages.map((message) => {
    //         if (typeof message === "string") {
    //             return message;
    //         }

    //         return (message as Message<PpString>).text.toString();
    //     });
    // }

    // private async executeCoqCommandUnsafe(
    //     sourceDirPath: string,
    //     sourceFileContentPrefix: string[],
    //     prefixEndPosition: Position,
    //     coqCommand: string
    // ): Promise<CoqCommandExecResult> {
    //     if (coqCommand.includes("\n")) {
    //         return Err("Coq command must be a single line");
    //     }

    //     const auxFileUri = this.makeAuxFileName(sourceDirPath);
    //     const diagnostic = await this.getDiagnosticAfterExec(
    //         auxFileUri,
    //         sourceFileContentPrefix,
    //         coqCommand
    //     );

    //     if (diagnostic) {
    //         unlinkSync(auxFileUri.fsPath);
    //         return Err(diagnostic);
    //     }

    //     const commandMessagePos = {
    //         line: prefixEndPosition.line + 2,
    //         character: coqCommand.length - 1,
    //     };

    //     const message = await this.coqLspClient.getMessageAtPoint(
    //         commandMessagePos,
    //         auxFileUri,
    //         2
    //     );

    //     unlinkSync(auxFileUri.fsPath);

    //     if (message.ok) {
    //         return Ok(this.formatLspMessages(message.val));
    //     } else {
    //         return Err(message.val.message);
    //     }
    // }

    // private async getDiagnosticAfterExec(
    //     auxFileUri: Uri,
    //     sourceFileContentPrefix: string[],
    //     coqCode: string
    // ): Promise<DiagnosticMessage> {
    //     const sourceFileContent = sourceFileContentPrefix.join("\n");
    //     writeFileSync(auxFileUri.fsPath, sourceFileContent);
    //     await this.coqLspClient.openTextDocument(auxFileUri);

    //     const appendedSuffix = `\n\n${coqCode}`;
    //     appendFileSync(auxFileUri.fsPath, appendedSuffix);

    //     const diagnostic = await this.coqLspClient.updateTextDocument(
    //         sourceFileContentPrefix,
    //         appendedSuffix,
    //         auxFileUri,
    //         2
    //     );

    //     return diagnostic;
    // }
}
