import { Mutex } from "async-mutex";
import { Err, Ok, Result } from "ts-results";
import { Position } from "vscode-languageclient";

import { CoqLspClient } from "../../coqLsp/coqLspClient";
import { CoqLspTimeoutError, ProofGoal } from "../../coqLsp/coqLspTypes";

import { Uri } from "../../utils/uri";

export type CoqCodeExecError = string; // is it diagnistic message?
export type CoqCodeExecGoalResult = Result<ProofGoal[], CoqCodeExecError>;
export type CoqCommandExecResult = Result<string[], CoqCodeExecError>;

/**
 * Logic is similar to CoqProofChecker, yet, they
 * are not being mixed together yet,
 * as the server project is experimental
 * for now.
 */
export interface CoqCodeExecutorInterface {
    /**
     * Works similar to CoqProofChecker.checkProofs but
     * with slightly different semantics. This function
     * executes the given Coq code in specified environment
     * and returns either the goal after the execution or
     * an error message occured in the provided code.
     * @param fileUri Uri of the file to check the proof in
     * @param positionToCheckAt Position to check the proof at
     * @param coqCode Coq code to execute
     *
     * To Nikita from Nikita: you should read it at paste the code after this position and get the proof state right after it
     * It does not matter whether the code is a full proof or just a part of it
     */
    getGoalAfterCoqCode(
        fileUri: Uri,
        positionToCheckAt: Position,
        coqCode: string,
        coqLspTimeoutMillis: number
    ): Promise<CoqCodeExecGoalResult>;

    /**
     * Executes the given Coq command in the specified environment
     * and returns the messages that were produced by the command.
     * @param fileUri Uri of the file to execute the command in
     * @param positionToExecuteAt Position to execute the command at
     * @param coqCommand Coq command to execute
     */
    // executeCoqCommand(
    //     fileUri: Uri,
    //     positionToExecuteAt: Position,
    //     coqCommand: string,
    //     coqLspTimeoutMillis: number //some commands take time (e.g. Print All.)
    // ): Promise<CoqCommandExecResult>;
}

export class CoqCodeExecutor implements CoqCodeExecutorInterface {
    private mutex: Mutex = new Mutex();

    constructor(private coqLspClient: CoqLspClient) {}

    async getGoalAfterCoqCode(
        fileUri: Uri,
        positionToCheckAt: Position,
        coqCode: string,
        coqLspTimeoutMillis: number = 150000
    ): Promise<CoqCodeExecGoalResult> {
        return await this.mutex.runExclusive(async () => {
            const timeoutPromise = new Promise<CoqCodeExecGoalResult>(
                (_, reject) => {
                    setTimeout(() => {
                        reject(
                            new CoqLspTimeoutError(
                                `getGoalAfterCoqCode timed out after ${coqLspTimeoutMillis} milliseconds`
                            )
                        );
                    }, coqLspTimeoutMillis);
                }
            );

            return Promise.race([
                this.getGoalAfterCoqCodeUnsafe(
                    fileUri,
                    positionToCheckAt,
                    coqCode
                ),
                timeoutPromise,
            ]);
        });
    }

    // async executeCoqCommand(
    //     fileUri: Uri,
    //     positionToExecuteAt: Position,
    //     coqCommand: string,
    //     coqLspTimeoutMillis: number = 300000
    // ): Promise<CoqCommandExecResult> {
    //     return this.mutex.runExclusive(async () => {
    //         const timeoutPromise = new Promise<CoqCommandExecResult>(
    //             (_, reject) => {
    //                 setTimeout(() => {
    //                     reject(
    //                         new CoqLspTimeoutError(
    //                             `executeCoqCommand timed out after ${coqLspTimeoutMillis} milliseconds`
    //                         )
    //                     );
    //                 }, coqLspTimeoutMillis);
    //             }
    //         );
    //         return Promise.race(
    //             [
    //                 this.executeCoqCommandUnsafe(
    //                     fileUri,
    //                     positionToExecuteAt,
    //                     coqCommand
    //                 ),
    //                 timeoutPromise,
    //             ]
    //         );

    //     });

    // }

    private async getGoalAfterCoqCodeUnsafe(
        fileUri: Uri,
        positionToCheckAt: Position,
        coqCode: string
    ): Promise<CoqCodeExecGoalResult> {
        const documentVersion = 1;
        const goalsResult = await this.coqLspClient.withTextDocument(
            {
                uri: fileUri,
            },
            async () => {
                console.log("positionToCheckAt", positionToCheckAt);

                return await this.coqLspClient.getGoalsAtPoint(
                    positionToCheckAt,
                    fileUri,
                    documentVersion,
                    coqCode
                );

                //TODO: eventLoggers
            }
        );

        if (goalsResult.err) {
            return Err(goalsResult.val.message);
        } else {
            return Ok(goalsResult.val);
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
    //     fileUri: Uri,
    //     positionToExecuteAt: Position,
    //     coqCommand: string

    // ): Promise<CoqCommandExecResult> {
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

    //     if (!(message instanceof Error)) {
    //         return Ok(this.formatLspMessages(message));
    //     } else {
    //         return Err(message.message);
    //     }
    // }

    // private async getDiagnosticsAfterExec(
    //     fileUri: Uri,
    //     positionToExecuteAt: Position,
    //     coqCode: string
    // ): Promise<CoqCodeExecGoalResult> {
    //     const executionResult = await this.coqLspClient.withTextDocument(
    //         {
    //             uri: fileUri,
    //         },
    //         async () => {
    //             return await this.coqLspClient.getGoalsAtPoint(
    //                 Position.create(positionToExecuteAt.line, positionToExecuteAt.character-1),
    //                 fileUri,
    //                 1,
    //                 coqCode
    //             );
    //         }
    //     );
    //     if (executionResult.err) {
    //         return
    //     }
    // }
}
