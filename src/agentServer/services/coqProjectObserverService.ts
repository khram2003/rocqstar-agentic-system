import { Injectable } from "@tsed/di";
import { BadRequest } from "@tsed/exceptions";
import { lstatSync, readFileSync, readdirSync } from "fs";
import * as path from "path";
import { Err, Ok } from "ts-results";
import { window } from "vscode";
import { Position } from "vscode-languageclient";

import { CoqLspClientImpl } from "../../coqLsp/coqLspClient";
import { CoqLspConfig } from "../../coqLsp/coqLspConfig";
import { CoqLspConnector } from "../../coqLsp/coqLspConnector";
import { apiGoalToProofGoal } from "../../coqLsp/goalTransformer";

import { RocqStarContextTheoremsRanker } from "../../core/contextTheoremRanker/actualRankers/rocqStarContextTheoremsRanker";
import { goalAsTheoremString } from "../../core/contextTheoremRanker/utils/tokenUtils";
import { hypToString } from "../../core/exposedCompletionGeneratorUtils";

import { Theorem } from "../../coqParser/parsedTypes";
import { Uri } from "../../utils/uri";
import { ApiGoal, CheckProofResult } from "../models/apiGoal";
import { CoqFile } from "../models/coqFile";

import { CoqCodeExecutor } from "./coqCommandExecutor";
import { CoqCommandType } from "./coqCommandType";
import { parseCoqFile } from "../../coqParser/parseCoqFile";

@Injectable()
export class CoqProjectObserverService {
    private readonly projectRoot: string;
    private readonly coqLspClient: CoqLspClientImpl;
    private readonly coqCodeExecutor: CoqCodeExecutor;

    constructor() {
        console.log("CoqProjectObserverService initializing");

        const projectRoot = process.env.SERVER_RUN_ROOT;
        if (!projectRoot) {
            const error = "Unable to find the project root";
            console.error(`CoqProjectObserverService: ${error}`);
            throw new Error(error);
        }

        this.projectRoot = projectRoot;
        console.log(
            `CoqProjectObserverService: Using project root: ${this.projectRoot}`
        );

        // Initialize CoqLsp client
        const coqLspServerConfig = CoqLspConfig.createServerConfig();
        const coqLspPath = process.env.COQ_LSP_PATH || "coq-lsp";
        console.log(
            `CoqProjectObserverService: Using coq-lsp at: ${coqLspPath}`
        );

        const coqLspClientConfig = CoqLspConfig.createClientConfig(
            coqLspPath,
            this.projectRoot
        );

        const connector = new CoqLspConnector(
            coqLspServerConfig,
            coqLspClientConfig,
            window.createOutputChannel("CoqPilot: coq-lsp events")
        );
        connector.start();
        this.coqLspClient = new CoqLspClientImpl(connector);
        this.coqCodeExecutor = new CoqCodeExecutor(this.coqLspClient);
        console.log("CoqProjectObserverService: CoqLsp client initialized");
    }

    getProjectRoot(): string {
        return this.projectRoot;
    }

    async getTheoremNamesFromFile(
        filePath: string,
        auxFileUri?: Uri
    ): Promise<string[]> {
        console.log(
            `getTheoremNamesFromFile: Getting theorems from ${filePath}`
        );

        const fileUri = this.resolveFileUri(filePath, auxFileUri);
        console.log(`getTheoremNamesFromFile: Using URI ${fileUri.fsPath}`);

        const document = await this.getDocument(fileUri);

        const theoremNames = document.map((t) => t.name);
        console.log(
            `getTheoremNamesFromFile: Found ${theoremNames.length} theorems`
        );
        return theoremNames;
    }

    private resolveFileUri(filePath: string, auxFileUri?: Uri): Uri {
        if (auxFileUri) {
            return auxFileUri;
        }
        return Uri.fromPath(path.join(this.projectRoot, filePath));
    }

    private async getDocument(fileUri: Uri): Promise<Theorem[]> {
        let document: Theorem[] = [];
        await this.coqLspClient.withTextDocument({ uri: fileUri }, async () => {
            document = await parseCoqFile(
                fileUri,
                this.coqLspClient,
                new AbortController().signal
            );
        });


        console.log(`document: ${document.length}`);
        return document;
    }

    async retrieveTheoremWithProofFromFile(
        filePath: string,
        theoremName: string,
        auxFileUri?: Uri
    ): Promise<Theorem> {
        console.log(
            `retrieveTheoremWithProofFromFile: Getting theorem ${theoremName} from ${filePath}`
        );

        const fileUri = this.resolveFileUri(filePath, auxFileUri);

        const document = await this.getDocument(fileUri);

        const theorem = document.find((t) => t.name === theoremName);
        if (!theorem) {
            const errorMsg = `Theorem ${theoremName} not found in ${auxFileUri ? "auxiliary file" : `file ${filePath}`}`;
            console.error(`retrieveTheoremWithProofFromFile: ${errorMsg}`);
            throw new BadRequest(errorMsg);
        }

        console.log(
            `retrieveTheoremWithProofFromFile: Found theorem ${theoremName}`
        );
        return theorem;
    }

    /**
     * Get all Coq files in the project
     */
    getCoqFilesInProject(): CoqFile[] {
        console.log(
            `getCoqFilesInProject: Finding all .v files in ${this.projectRoot}`
        );

        let coqFiles: CoqFile[] = [];

        function finder(startPath: string, rootPath: string): void {
            let files: string[] = readdirSync(startPath);
            for (let file of files) {
                let filename = path.join(startPath, file);
                let stats = lstatSync(filename);
                if (stats.isDirectory()) {
                    finder(filename, rootPath);
                } else if (filename.endsWith(".v")) {
                    coqFiles.push({
                        name: file,
                        pathFromRoot: path.relative(rootPath, filename),
                    });
                }
            }
        }

        finder(this.projectRoot, this.projectRoot);
        console.log(
            `getCoqFilesInProject: Found ${coqFiles.length} Coq files in project`
        );
        return coqFiles;
    }

    /**
     * Runs a Coq command (e.g. Search, Print, Check) on a file.
     * An optional documentVersion parameter is passed to the underlying executor.
     */
    async runCoqCommand(
        filePrefixContent: string[],
        command: CoqCommandType,
        documentVersion: number = 1,
        sessionAuxFileUri: Uri,
        positionToCheckAt: Position
    ): Promise<string[]> {
        console.log(
            `runCoqCommand: Running command "${command.get().val}" on ${sessionAuxFileUri?.fsPath}`
        );

        const coqCommandAsString = command.get();
        if (coqCommandAsString.err) {
            const errorMsg = coqCommandAsString.val.message;
            console.error(`runCoqCommand: Invalid command: ${errorMsg}`);
            throw new BadRequest(errorMsg);
        }

        if (!sessionAuxFileUri) {
            const errorMsg = "Session auxiliary file URI is required";
            console.error(`runCoqCommand: ${errorMsg}`);
            throw new BadRequest(errorMsg);
        }

        try {
            console.log(
                `runCoqCommand: Executing command: ${coqCommandAsString.val}`
            );
            console.log(
                `runCoqCommand: Position to check at: Line ${positionToCheckAt.line}, Character ${positionToCheckAt.character}`
            );
            console.log(
                `runCoqCommand: File prefix content length: ${filePrefixContent.length}`
            );
            const result = await this.coqCodeExecutor.executeCoqCommand(
                sessionAuxFileUri,
                filePrefixContent,
                positionToCheckAt,
                coqCommandAsString.val,
                documentVersion
            );

            if (result.ok) {
                console.log(`runCoqCommand: Command executed successfully`);
                return result.val;
            } else {
                const errorMsg = result.val.message;
                console.error(
                    `runCoqCommand: Command execution failed: ${errorMsg}`
                );
                throw new BadRequest(errorMsg);
            }
        } catch (error) {
            const errorMsg =
                error instanceof Error ? error.message : String(error);
            console.error(`runCoqCommand: Error: ${errorMsg}`);
            throw new BadRequest(`Failed to run Coq command: ${errorMsg}`);
        }
    }

    async checkCoqProof(
        coqCode: string,
        auxFileUri: Uri,
        filePrefixContent: string[],
        documentVersion: number,
        positionToCheckAt: Position
    ): Promise<CheckProofResult> {
        console.log(
            `checkCoqProof: Checking proof at position (${positionToCheckAt.line}:${positionToCheckAt.character}), version ${documentVersion}`
        );
        console.log(
            `checkCoqProof: Proof code length: ${coqCode.length} characters`
        );

        if (!auxFileUri) {
            const errorMsg =
                "Auxiliary file URI is required for proof checking";
            console.error(`checkCoqProof: ${errorMsg}`);
            return Err({
                message: errorMsg,
                line: undefined,
            });
        }

        try {
            console.log(`checkCoqProof: Getting goals with coqCode directly`);
            const result = await this.coqCodeExecutor.getGoalAfterCoqCode(
                auxFileUri,
                filePrefixContent,
                positionToCheckAt,
                coqCode,
                documentVersion,
                150000
            );

            console.log(
                `checkCoqProof: Goal retrieval result: ${result.ok ? "success" : "error"}`
            );

            if (result.err) {
                if (result.val.name === "stack_subgoals") {
                    return Err({
                        message: result.val.message,
                        name: result.val.name,
                    });
                }
                return Err({
                    message: result.val.message,
                    location: {
                        start: {
                            line: result.val.location?.start.line ?? 0,
                            character:
                                result.val.location?.start.character ?? 0,
                        },
                        end: {
                            line: result.val.location?.end.line ?? 0,
                            character: result.val.location?.end.character ?? 0,
                        },
                    },
                });
            }

            const goals = result.val;

            if (goals.length === 0) {
                console.log(`checkCoqProof: No goals, proof is complete`);
                return Ok([]);
            }

            // Convert goals to API format
            const apiGoals = goals.map((goal) => ({
                conclusion: goal.ty.toString(),
                hypothesis: goal.hyps.map((hyp) => hypToString(hyp)),
            }));

            console.log(
                `checkCoqProof: Found ${apiGoals.length} remaining goals`
            );
            return Ok(apiGoals);
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            console.error(
                `checkCoqProof: Failed to check proof: ${errorMessage}`
            );
            return Err({
                message: errorMessage,
                line: undefined,
            });
        }
    }

    /**
     * Get premises (dependencies) for a theorem from a file
     */
    async getPremisesFromFile(
        filePath: string,
        targetFilePath: string,
        goal: ApiGoal,
        targetTheoremName: string,
        _auxFileUri?: Uri
    ): Promise<string[]> {
        console.log(
            `getPremisesFromFile: Getting premises for goal ${JSON.stringify(goal)}`
        );
        console.log(
            `getPremisesFromFile: Getting premises for goal ${goal} in ${filePath}`
        );

        const fileUri = this.resolveFileUri(filePath)

        const document: Theorem[] = await this.getDocument(fileUri);

        console.log(`document: ${document.length}`);

        let contextTheorems: Theorem[] = [];

        if (targetFilePath === filePath) {
            contextTheorems = document.filter(
                (t) => t.name !== targetTheoremName
            );
        } else {
            contextTheorems = document;
        }

        console.log(`contextTheorems: ${contextTheorems.length}`);

        // API goal to proof goal
        const proofGoal = apiGoalToProofGoal(goal);

        console.log(
            `Transforming goal to proof goal: ${JSON.stringify(proofGoal)}`
        );

        console.log(
            `Resulting theorem from goal: ${goalAsTheoremString(proofGoal)}`
        );

        const ranker = new RocqStarContextTheoremsRanker();
        const dummyCompletionContext = {
            proofGoal: proofGoal,
            admitRange: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
            },
        };

        const premises = await ranker.rankContextTheorems(
            contextTheorems,
            dummyCompletionContext
        );

        const premiseNames = premises.map((t) => t.name);
        console.log(
            `getPremisesFromFile: Found ${premiseNames.length} premises`
        );
        return premiseNames;
    }

    async getSourceFileContentPrefix(
        sourceFilePath: string,
        theoremName: string
    ): Promise<string[]> {
        console.log(
            `getSourceFileContentPrefix: Getting content before theorem ${theoremName} in ${sourceFilePath}`
        );

        const fileText = readFileSync(
            path.join(this.projectRoot, sourceFilePath)
        ).toString();
        const fileLines = fileText.split("\n");

        const theorem = await this.retrieveTheoremWithProofFromFile(
            sourceFilePath,
            theoremName
        );

        const theoremStartPosition = theorem.statement_range.start;
        const prefixLines = fileLines.slice(0, theoremStartPosition.line);

        console.log(
            `getSourceFileContentPrefix: Got ${prefixLines.length} lines before theorem ${theoremName}`
        );
        return prefixLines;
    }

    async getTheoremStatement(
        sourceFilePath: string,
        theoremName: string
    ): Promise<string> {
        console.log(
            `getTheoremStatement: Getting statement for theorem ${theoremName} from ${sourceFilePath}`
        );

        const theorem = await this.retrieveTheoremWithProofFromFile(
            sourceFilePath,
            theoremName
        );

        console.log(
            `getTheoremStatement: Retrieved statement for ${theoremName}`
        );
        return theorem.statement;
    }
}
