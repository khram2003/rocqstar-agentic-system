import { Theorem } from "../../coqParser/parsedTypes";
import { CompletionContext } from "../completionGenerationContext";

export interface ContextTheoremsRanker {
    rankContextTheorems(
        theorems: Theorem[],
        completionContext: CompletionContext
    ): Promise<Theorem[]>;

    readonly type: RankerType;

    /**
     * _Note:_ so far it only triggers initial goals of all parsed theorems
     * being extracted at the parsing stage too.
     */
    readonly needsUnwrappedNotations: boolean;
}

export type RankerType =
    | "distance"
    | "euclid"
    | "jaccardIndex"
    | "random"
    | "weightedJaccardIndex"
    | "rocqStar"
    | "cosine";
