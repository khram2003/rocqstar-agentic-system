import { Controller, Get, QueryParams, UseBefore } from "@tsed/common";
import { Required } from "@tsed/schema";

import { prepareProofToCheck } from "../../core/exposedCompletionGeneratorUtils";

import { FilePathMiddleware } from "../middlewares/filePathMiddleware";
import { CoqProjectObserverService } from "../services/coqProjectObserverService";

@Controller("/document")
export class CoqProjectController {
    constructor(
        private readonly coqProjectObserverService: CoqProjectObserverService
    ) {
        this.coqProjectObserverService = new CoqProjectObserverService();
    }

    @Get()
    async getProjectRoot(): Promise<any> {
        return {
            message:
                "Server is expecting the coq project to be with the same root as the server.",
            projectRoot: this.coqProjectObserverService.getProjectRoot(),
        };
    }

    @Get("/theorem-names")
    @UseBefore(FilePathMiddleware)
    async getTheoremNamesFromFile(
        @Required() @QueryParams("filePath") filePath: string
    ): Promise<any> {
        return {
            message: "Theorem names from the file",
            theoremNames:
                await this.coqProjectObserverService.getTheoremNamesFromFile(
                    filePath
                ),
        };
    }

    @Get("/all-coq-files")
    getAllCoqFiles(): any {
        return {
            coqFiles: this.coqProjectObserverService.getCoqFilesInProject(),
        };
    }

    @Get("/theorem")
    @UseBefore(FilePathMiddleware)
    async retrieveTheoremFromFile(
        @Required() @QueryParams("filePath") filePath: string,
        @Required() @QueryParams("theoremName") theoremName: string
    ): Promise<any> {
        const theorem =
            await this.coqProjectObserverService.retrieveTheoremWithProofFromFile(
                filePath,
                theoremName
            );

        return {
            theoremStatement: theorem.statement,
            theoremProof: theorem.proof?.onlyText(),
            isIncomplete: theorem.proof?.is_incomplete, // This proof is complete "Proof using.\ngg.\nQed.\n"
        };
    }

    // @Get("/get-objects")
    // @UseBefore(FilePathMiddleware)
    // async getObjectsInFile(
    //     @Required() @QueryParams("filePath") filePath: string
    // ): Promise<any> {
    //     const execResult = await this.coqProjectObserverService.runCoqCommand(
    //         filePath,
    //         new PrintAllCoqCommand()
    //     );

    //     // TODO: rename method
    //     // TODO: other "gets" form Coq

    //     return {
    //         objects: execResult[0].split("\n"),
    //     };
    // }

    // @Get("/search-pattern")
    // @UseBefore(FilePathMiddleware)
    // async runCommandInFile(
    //     @Required() @QueryParams("filePath") filePath: string,
    //     @Required() @QueryParams("pattern") pattern: string
    // ): Promise<any> {
    //     const execResult = await this.coqProjectObserverService.runCoqCommand(
    //         filePath,
    //         new SearchCoqCommand(pattern)
    //     );
    //     return {
    //         pattern: pattern,
    //         result: execResult,
    //     };
    // }

    // @Get("/print-term")
    // @UseBefore(FilePathMiddleware)
    // async printTermInFile(
    //     @Required() @QueryParams("filePath") filePath: string,
    //     @Required() @QueryParams("term") term: string
    // ): Promise<any> {
    //     const execResult = await this.coqProjectObserverService.runCoqCommand(
    //         filePath,
    //         new PrintCoqCommand(term)
    //     );
    //     return {
    //         term: term,
    //         result: execResult,
    //     };
    // }

    // @Get("/check-term")
    // @UseBefore(FilePathMiddleware)
    // async checkTermInFile(
    //     @Required() @QueryParams("filePath") filePath: string,
    //     @Required() @QueryParams("term") term: string
    // ): Promise<any> {
    //     // TODO: wtf is term?
    //     // TODO: rewrite using partialCoaProofChecker
    //     const execResult = await this.coqProjectObserverService.runCoqCommand(
    //         filePath,
    //         new CheckCoqCommand(term)
    //     );
    //     return {
    //         term: term,
    //         result: execResult,
    //     };
    // }

    @Get("/check-proof")
    @UseBefore(FilePathMiddleware)
    async checkProofInFile(
        @Required() @QueryParams("filePath") filePath: string,
        @Required() @QueryParams("theoremName") theoremName: string,
        @Required() @QueryParams("proof") proof: string
    ): Promise<any> {
        const preparedProof = prepareProofToCheck(proof);
        console.log("preparedProof", preparedProof);
        const result =
            await this.coqProjectObserverService.getGoalsAfterProofWithCoqLsp(
                filePath,
                theoremName,
                preparedProof
            );

        if (result.err) {
            return {
                message: result.val,
            };
        } else {
            return {
                message: "Proof checked",
                goals: result.val,
            };
        }
    }
}
