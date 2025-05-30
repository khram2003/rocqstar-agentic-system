import { Theorem } from "../../../coqParser/parsedTypes";
import { CompletionContext } from "../../completionGenerationContext";
import { ContextTheoremsRanker } from "../contextTheoremsRanker";
import { goalAsTheoremString } from "../utils/tokenUtils";

/**
 * Ranks theorems based on how similar their statements are to
 * the current goal context. Metric is calculated on the
 * concatenated hypothesis and conclusion.
 *
 * ```cosine(A, B) = |A ∩ B| / sqrt(|A| * |B|)```
 */
export class CosineContextTheoremsRanker implements ContextTheoremsRanker {
    readonly type = "cosine";
    readonly needsUnwrappedNotations = true;

    async rankContextTheorems(
        theorems: Theorem[],
        completionContext: CompletionContext
    ): Promise<Theorem[]> {
        const goal = completionContext.proofGoal;
        const goalTheorem = goalAsTheoremString(goal);

        const cosine = (theorem: Theorem): number => {
            const completionTokens = goalTheorem
                .split(" ")
                .filter(
                    (token) => token !== "#" && token !== ":" && token !== ""
                )
                .map((token) => token.replace(/[\(\).\n]/g, ""));
            const theoremTokens = goalAsTheoremString(theorem.initial_goal!!)
                .split(" ")
                .filter(
                    (token) => token !== "#" && token !== ":" && token !== ""
                )
                .map((token) => token.replace(/[\(\).\n]/g, ""));

            const intersection = completionTokens.filter((token) =>
                theoremTokens.includes(token)
            );

            return (
                intersection.length /
                Math.sqrt(completionTokens.length * theoremTokens.length)
            );
        };

        return theorems.sort((a, b) => cosine(b) - cosine(a));
    }
}
