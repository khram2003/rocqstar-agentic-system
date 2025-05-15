import { Theorem } from "../../../coqParser/parsedTypes";
import { CompletionContext } from "../../completionGenerationContext";
import { ContextTheoremsRanker } from "../contextTheoremsRanker";
import { goalAsTheoremString } from "../utils/tokenUtils";

/**
 * Ranks theorems based on how similar their statements are to
 * the current goal context. Metric is calculated on the
 * concatenated hypothesis and conclusion.
 *
 * // TODO: metric description?
 */
export class WeightedJaccardIndexContextTheoremsRanker
    implements ContextTheoremsRanker
{
    readonly type = "weightedJaccardIndex";
    readonly needsUnwrappedNotations = true;

    async rankContextTheorems(
        theorems: Theorem[],
        completionContext: CompletionContext
    ): Promise<Theorem[]> {
        const goalTheorem = goalAsTheoremString(completionContext.proofGoal);
        const completionTokens = goalTheorem
            .split(" ")
            .filter((token) => token !== "#" && token !== ":" && token !== "")
            .map((token) => token.replace(/[\(\).\n]/g, ""));

        const theoremTokensList = theorems.map((theorem) => {
            return goalAsTheoremString(theorem.initial_goal!!)
                .split(" ")
                .filter(
                    (token) => token !== "#" && token !== ":" && token !== ""
                )
                .map((token) => token.replace(/[\(\).\n]/g, ""));
        });
        const allTokens = theoremTokensList.flat();

        const tokenFrequency = new Map<string, number>();
        allTokens.forEach((token) => {
            tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
        });
        const totalTokensCount = allTokens.length;
        // console.log(`Total tokens count: ${totalTokensCount}`);
        const tfidf = (token: string): number => {
            // console.log(`Token: ${token}, Frequency: ${tokenFrequency.get(token)!}`);
            if (!tokenFrequency.has(token)) {
                return 0;
            }
            return tokenFrequency.get(token)! / totalTokensCount;
        };

        const rankedTheorems = theorems.map((theorem, idx) => {
            const tokens = theoremTokensList[idx];
            const tokensMap = new Map<string, number>();
            tokens.forEach((token) => {
                tokensMap.set(token, (tokensMap.get(token) || 0) + 1);
            });

            const intersection = completionTokens.filter((token) =>
                tokensMap.has(token)
            );
            const union = new Set([...completionTokens, ...tokens]);
            // console.log(`Theorem: ${theorem.name}, Intersection: ${intersection}, Union: ${union}`);
            // console.log(`Theorem: ${theorem.name}, Union size: ${union.size}`);
            // console.log(`Theorem: ${theorem.name}, Random Elemnt form Union: ${tokens}`);
            const tfidfIntersection = intersection.reduce(
                (sum, token) => sum + tfidf(token),
                0
            );
            const tfidfUnion = Array.from(union).reduce(
                (sum, token) => sum + tfidf(token),
                0
            );
            // console.log(`Theorem: ${theorem.name}, TDIDF Intersection: ${tfidfIntersection}, TFIDF Union: ${tfidfUnion}`);
            const rank = tfidfIntersection / tfidfUnion;
            // console.log(`Theorem: ${theorem.name}, Rank: ${rank}`);
            return { theorem, rank };
        });

        rankedTheorems.sort((a, b) => b.rank - a.rank);

        // const dataToWrite = rankedTheorems.map(item => ({
        //     name: item.theorem.name,
        //     rank: item.rank
        // }));
        // const hash = crypto.createHash('md5').update(goalTheorem).digest('hex');
        // const fileName = `${hash}_new.json`;
        // fs.writeFileSync(fileName, JSON.stringify(dataToWrite, null, 2));
        return rankedTheorems.map((item) => item.theorem);
    }
}
