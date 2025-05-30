import {
    CompletionContext,
    SourceFileEnvironment,
} from "../../../../../core/completionGenerationContext";

import { throwError } from "../../../../../utils/throwErrors";
import { BenchmarkingLogger } from "../../../logging/benchmarkingLogger";
import { WorkspaceRoot } from "../../../structures/common/workspaceRoot";
import { checkGeneratedProofsInSubprocess } from "../../../subprocessCalls/checkGeneratedProofs/callChildProcess";
import { AsyncScheduler } from "../../../utils/asyncUtils/asyncScheduler";

import {
    AbstractProofsChecker,
    ProofsCheckResult,
} from "./abstractProofsChecker";
import { ProofsCheckerUtils } from "./implementation/proofsCheckerUtils";

export class SubprocessProofsChecker extends AbstractProofsChecker {
    constructor(
        private readonly subprocessesScheduler: AsyncScheduler,
        private readonly checkProofsSubprocessTimeoutMillis: number | undefined,
        private readonly enableSubprocessLifetimeDebugLogs: boolean
    ) {
        super();
    }

    async checkProofs(
        preparedProofs: string[],
        completionContext: CompletionContext,
        sourceFileEnvironment: SourceFileEnvironment,
        workspaceRoot: WorkspaceRoot,
        logger: BenchmarkingLogger
    ): Promise<ProofsCheckResult> {
        const proofsCheckExecutionResult =
            await checkGeneratedProofsInSubprocess(
                preparedProofs,
                completionContext,
                sourceFileEnvironment,
                workspaceRoot,
                this.checkProofsSubprocessTimeoutMillis,
                this.subprocessesScheduler,
                logger,
                this.enableSubprocessLifetimeDebugLogs
            );
        if (proofsCheckExecutionResult.isFailed()) {
            // TODO: this throw should be revised
            throwError(proofsCheckExecutionResult.errorMessage);
        }
        return ProofsCheckerUtils.unpackSuccessResultOrThrow(
            proofsCheckExecutionResult.maybeResult!
        );
    }
}
