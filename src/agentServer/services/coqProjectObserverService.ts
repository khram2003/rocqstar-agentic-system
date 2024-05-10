import { Injectable } from "@tsed/di";
import { BadRequest } from "@tsed/exceptions";
import { lstatSync, readFileSync, readdirSync } from "fs";
import * as path from "path";
import { Err, Ok } from "ts-results";
import { Position } from "vscode-languageclient";

import { withTestCoqLspClient } from "../../coqLsp/coqLspBuilders";
import { ProofGoal } from "../../coqLsp/coqLspTypes";

import { parseCoqFile } from "../../coqParser/parseCoqFile";
import { Theorem } from "../../coqParser/parsedTypes";
import { Uri } from "../../utils/uri";
import { ApiGoal, CheckProofResult } from "../models/apiGoal";
import { CoqFile } from "../models/coqFile";

import { CoqCodeExecGoalResult, CoqCodeExecutor } from "./coqCommandExecutor";

@Injectable()
export class CoqProjectObserverService {
    private readonly projectRoot: string;

    constructor() {
        console.log("CoqProjectObserverService constructor");
        const projectRoot = process.env.SERVER_RUN_ROOT;
        if (!projectRoot) {
            throw new Error("Unable to find the project root");
        }
        this.projectRoot = projectRoot;
    }

    getProjectRoot(): string {
        return this.projectRoot;
    }

    async getTheoremNamesFromFile(filePath: string) {
        const document = await this.getDocumentWithCoqLsp(filePath);
        return document.map((t) => t.name);
    }

    async retrieveTheoremWithProofFromFile(
        filePath: string,
        theoremName: string
    ): Promise<Theorem> {
        const document = await this.getDocumentWithCoqLsp(filePath);

        const theorem = document.find((t) => t.name === theoremName);
        if (!theorem) {
            throw new BadRequest(
                `Theorem ${theoremName} not found in file ${filePath}`
            );
        }
        return theorem;
    }

    private async getDocumentWithCoqLsp(filePath: string): Promise<Theorem[]> {
        const absolutePath = path.join(this.projectRoot, filePath);
        const fileUri = Uri.fromPath(absolutePath);
        let document: Theorem[] = [];
        await withTestCoqLspClient(
            { workspaceRootPath: this.projectRoot },
            async (coqLspClient) => {
                await coqLspClient.withTextDocument(
                    { uri: fileUri },
                    async () => {
                        document = await parseCoqFile(
                            fileUri,
                            coqLspClient,
                            new AbortController().signal
                        );
                    }
                );
            }
        );
        return document;
    }

    async getGoalsAfterProofWithCoqLsp(
        filePath: string,
        theoremName: string,
        proof: string
    ): Promise<CheckProofResult> {
        const fileUri = Uri.fromPath(path.join(this.projectRoot, filePath));
        let result: CheckProofResult = Ok([]);
        await withTestCoqLspClient(
            { workspaceRootPath: this.projectRoot },
            async (coqLspClient) => {
                await coqLspClient.withTextDocument(
                    { uri: fileUri },
                    async () => {
                        const coqCodeExecutor = new CoqCodeExecutor(
                            coqLspClient
                        );
                        const positionToCheckAt =
                            await this.getPositionToCheckAt(
                                filePath,
                                theoremName,
                                proof
                            );

                        result = await this.executeCoqCode(
                            filePath,
                            proof,
                            positionToCheckAt,
                            coqCodeExecutor.getGoalAfterCoqCode.bind(
                                coqCodeExecutor
                            )
                        );
                    }
                );
            }
        );
        return result;
    }

    getCoqFilesInProject(): CoqFile[] {
        let coqFiles: CoqFile[] = [];

        function finder(startPath: string, rootPath: string): void {
            let files: string[] = readdirSync(startPath);
            for (let file of files) {
                let filename = path.join(startPath, file);
                let stats = lstatSync(filename);
                if (stats.isDirectory()) {
                    finder(filename, rootPath);
                } else if (filename.slice(-2) === ".v") {
                    coqFiles.push({
                        name: file,
                        pathFromRoot: path.relative(rootPath, filename),
                    });
                }
            }
        }

        finder(this.projectRoot, this.projectRoot);
        return coqFiles;
    }

    // async runCoqCommand(filePath: string, command: CoqCommandType): Promise<string[]> {
    //     const coqCodeExecutor = new CoqCodeExecutor(this.coqLspClient);
    //     const coqCommandAsString = command.get();
    //     if (coqCommandAsString.err) {
    //         throw new BadRequest(coqCommandAsString.val.message);
    //     }

    //     const result = await this.executeCoqCode(
    //         filePath,
    //         coqCommandAsString.val,
    //         coqCodeExecutor.executeCoqCommand.bind(coqCodeExecutor)
    //     );

    //     if (result.ok) {
    //         return result.val;
    //     } else {
    //         throw new BadRequest(result.val);
    //     }
    // }

    // async checkCoqProofForTheorem(filePath: string, theoremName: string, coqCode: string): Promise<CoqCodeExecGoalResult> {
    //     const coqCodeExecutor = new CoqCodeExecutor(coqLspClient);
    //     const positionToCheckAt = await this.getPositionToCheckAt(filePath, theoremName, coqCode);
    //     const result = await this.executeCoqCode(
    //         filePath,
    //         coqCode,
    //         positionToCheckAt,
    //         coqCodeExecutor.getGoalAfterCoqCode.bind(coqCodeExecutor)

    //     );

    //     if (result.err) {
    //         throw new BadRequest(result.val);
    //     } else {
    //         return Ok(result.val);
    //     }
    // }

    private async getPositionToCheckAt(
        filePath: string,
        theoremName: string,
        coqCode: string
    ): Promise<Position> {
        const theorem = await this.retrieveTheoremWithProofFromFile(
            filePath,
            theoremName
        );
        const theoremEndPosition = theorem.statement_range.end;
        console.log("theoremEndPosition", theoremEndPosition);
        console.log("coqCode", coqCode);
        const positionToCheckAt = {
            line: theoremEndPosition.line + 1,
            character: coqCode.length,
        };
        console.log("positionToCheckAt", positionToCheckAt);
        return positionToCheckAt;
    }

    private async executeCoqCode(
        filePath: string,
        coqCode: string,
        positionToCheckAt: Position,
        coqCodeExecutor: (
            fileUri: Uri,
            positionToExecuteAt: Position,
            coqCode: string
        ) => Promise<CoqCodeExecGoalResult>
    ): Promise<CheckProofResult> {
        const fileUri = Uri.fromPath(path.join(this.projectRoot, filePath));
        const result = await coqCodeExecutor(
            fileUri,
            positionToCheckAt,
            coqCode
        );
        if (result.err) {
            return Err(result.val);
        } else {
            const proofGoals: ProofGoal[] = result.val;
            const apiGoals: ApiGoal[] = proofGoals.map((goal) => {
                return {
                    conclusion: goal.ty.toString(),
                    hypothesis: goal.hyps.map((hyp) => hyp.names.join(", ")),
                };
            });
            return Ok(apiGoals);
        }
    }
}
