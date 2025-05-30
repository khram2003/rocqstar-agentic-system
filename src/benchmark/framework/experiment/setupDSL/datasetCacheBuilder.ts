import { BenchmarkingLogger } from "../../logging/benchmarkingLogger";
import { rewriteDatasetCache } from "../../parseDataset/cacheHandlers/cacheWriter";
import { DatasetCacheHolder } from "../../parseDataset/cacheStructures/cacheHolders";
import { AbstractCoqProjectParser } from "../../parseDataset/coqProjectParser/abstractCoqProjectParser";
import { CompleteInputTargetsUtils } from "../../parseDataset/core/filterTargetsMissingInCache";
import { parseMissingTargetsAndUpdateCache } from "../../parseDataset/core/parseMissingTargets";
import { createEmptyCache } from "../../parseDataset/utils/cacheHoldersUtils";
import {
    DatasetInputTargets,
    WorkspaceInputTargets,
    mergeInputTargets,
} from "../../structures/common/inputTargets";
import {
    WorkspaceRoot,
    standaloneFilesRoot,
} from "../../structures/common/workspaceRoot";
import { ExperimentRunOptions } from "../../structures/inputParameters/experimentRunOptions";
import {
    clearDirectory,
    isDirectory,
    listCoqSourceFiles,
} from "../../utils/fileUtils/fs";
import { throwBenchmarkingError } from "../../utils/throwErrors";

import { EnvironmentStringType, TargetsBuilderUtils } from "./targetsBuilder";

export namespace DatasetCacheBuildingImpl {
    export async function buildDatasetCache(
        cacheTargets: DatasetInputTargets,
        runOptions: ExperimentRunOptions,
        logger: BenchmarkingLogger,
        coqProjectParser: AbstractCoqProjectParser
    ): Promise<DatasetCacheHolder> {
        const datasetCache = await parseDataset(
            cacheTargets,
            logger,
            coqProjectParser
        );
        logger
            .asOneRecord()
            .info("All requested dataset targets were successfully parsed")
            .info(
                `Built cache will be saved into ${runOptions.datasetCacheDirectoryPath}`
            );

        saveCacheOrThrow(datasetCache, runOptions, logger);
        return datasetCache;
    }

    async function parseDataset(
        cacheTargets: DatasetInputTargets,
        logger: BenchmarkingLogger,
        coqProjectParser: AbstractCoqProjectParser
    ): Promise<DatasetCacheHolder> {
        const datasetCache = new DatasetCacheHolder();
        for (const [
            workspaceRoot,
            workspaceTargets,
        ] of cacheTargets.entries()) {
            const workspaceCache = createEmptyCache(workspaceRoot);
            await parseMissingTargetsAndUpdateCache(
                workspaceTargets,
                workspaceCache,
                workspaceRoot,
                logger,
                coqProjectParser
            );
            datasetCache.addWorkspaceCache(
                workspaceRoot.directoryPath,
                workspaceCache
            );
        }
        return datasetCache;
    }

    function saveCacheOrThrow(
        datasetCache: DatasetCacheHolder,
        runOptions: ExperimentRunOptions,
        logger: BenchmarkingLogger
    ) {
        logger.debug(
            `But firstly, cache directory will be cleared: ${runOptions.datasetCacheDirectoryPath}`
        );
        clearDirectory(runOptions.datasetCacheDirectoryPath);

        const cacheWasSuccessfullySaved = rewriteDatasetCache(
            datasetCache,
            runOptions.datasetCacheDirectoryPath,
            false,
            logger
        );
        if (!cacheWasSuccessfullySaved) {
            throwBenchmarkingError("Failed to save built cache");
        }
    }
}

export namespace CacheTargets {
    /**
     * Specifies a dataset workspace to parse and cache.
     * If `workspace(...)` is followed by `files(...)` or `directories(...)` calls,
     * only specified files will be cached. Otherwise, all source files inside the workspace will be cached.
     *
     * @param directoryPath path relative to the `dataset` directory.
     */
    export function workspace(
        directoryPath: string,
        environment: EnvironmentStringType
    ): CacheTargetsImpl.CacheTargetsBuilder {
        return new CacheTargetsImpl.CacheTargetsBuilder(
            TargetsBuilderUtils.buildWorkspaceRoot(directoryPath, environment)
        );
    }

    /**
     * Specifies a standalone dataset files root (`dataset/standalone-source-files`) to parse and cache.
     * If `standaloneFiles(...)` is followed by `files(...)` or `directories(...)` calls,
     * only specified files will be cached. Otherwise, all standalone dataset source files will be cached.
     */
    export function standaloneFiles(): CacheTargetsImpl.CacheTargetsBuilder {
        return new CacheTargetsImpl.CacheTargetsBuilder(standaloneFilesRoot);
    }
}

export namespace CacheTargetsImpl {
    export function buildCacheTargets(
        cacheTargetsBuilders: CacheTargetsImpl.CacheTargetsBuilder[],
        logger: BenchmarkingLogger
    ): DatasetInputTargets {
        const cacheTargets = mergeInputTargets(
            cacheTargetsBuilders.map((builder) => builder.buildCacheTargets())
        ).resolveRequests();
        if (cacheTargets.isEmpty()) {
            throwBenchmarkingError(
                "No targets for building dataset cache were selected. Configure some and try again."
            );
        }
        logger.debug(
            `Targets to parse from sources and cache:\n${cacheTargets.toString()}`
        );
        return cacheTargets;
    }

    /**
     * A builder for the workspace targets to be parsed and cached.
     *
     * `files(...)` or `directories(...)` calls can be used to select specific files to cache.
     * If no such calls are made, the final `buildCacheTargets()` method
     * will request all source files inside the workspace to be cached.
     */
    export class CacheTargetsBuilder {
        private readonly workspaceTargets = new WorkspaceInputTargets();

        constructor(private readonly workspaceRoot: WorkspaceRoot) {}

        /**
         * @param filePaths Coq source file paths relative to the workspace directory (or to the `dataset/standalone-source-files` directory for standalone files).
         */
        files(...filePaths: string[]): CacheTargetsBuilder {
            const resolvedFilePaths = filePaths.map((filePath) =>
                TargetsBuilderUtils.resolveWorkspacePath(
                    this.workspaceRoot,
                    filePath
                )
            );
            this.completeWithAllFileTargets(resolvedFilePaths);
            return this;
        }

        /**
         * @param directoryPaths directory paths relative to the workspace directory (or to the `dataset/standalone-source-files` directory for standalone files).
         */
        directories(...directoryPaths: string[]): CacheTargetsBuilder {
            const resolvedDirectoryPaths = directoryPaths.map((directoryPath) =>
                TargetsBuilderUtils.resolveWorkspacePath(
                    this.workspaceRoot,
                    directoryPath
                )
            );
            const resolvedFilePaths = resolvedDirectoryPaths.flatMap(
                (resolvedDirectoryPath) => {
                    if (!isDirectory(resolvedDirectoryPath)) {
                        throwBenchmarkingError(
                            `Building dataset cache target is invalid: resolved path "${resolvedDirectoryPath}" should be a directory`
                        );
                    }
                    return listCoqSourceFiles(resolvedDirectoryPath);
                }
            );
            this.completeWithAllFileTargets(resolvedFilePaths);
            return this;
        }

        buildCacheTargets(): DatasetInputTargets {
            if (this.workspaceTargets.isEmpty()) {
                // if neither `files(...)` nor `directories(...)` were called, all workspace sources should be added
                this.completeWithAllFileTargets(
                    listCoqSourceFiles(this.workspaceRoot.directoryPath)
                );
            }
            /**
             * Note: `this.workspaceTargets.resolveRequests()` is not needed here,
             * since all `DatasetInputTargets` produced by all `CacheTargetsBuilder` requested
             * will be resolved all together later.
             */
            return new DatasetInputTargets().addWorkspaceTargets(
                this.workspaceRoot,
                this.workspaceTargets
            );
        }

        private completeWithAllFileTargets(resolvedFilePaths: string[]) {
            // Note: explicit duplicates filtering is not needed here, since `WorkspaceInputTargets` handles them by itself
            CompleteInputTargetsUtils.completeWithAllFileTargets(
                this.workspaceTargets,
                resolvedFilePaths
            );
        }
    }
}
