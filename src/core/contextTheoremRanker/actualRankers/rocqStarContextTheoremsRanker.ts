import axios, { AxiosResponse } from "axios";

import { ProofGoal } from "../../../coqLsp/coqLspTypes";

import { Theorem } from "../../../coqParser/parsedTypes";
import { CompletionContext } from "../../completionGenerationContext";
import { hypToString } from "../../exposedCompletionGeneratorUtils";
import { ContextTheoremsRanker } from "../contextTheoremsRanker";

interface RankRequest {
    statement1: string;
    statement2: string;
}

interface RankResponse {
    distance: number;
}

export class RocqStarContextTheoremsRanker implements ContextTheoremsRanker {
    readonly type = "rocqStar";
    readonly needsUnwrappedNotations = true;
    static readonly host = "localhost";
    static readonly port = 9000;

    private goalAsRocqStarTheoremString(proofGoal: ProofGoal): string {
        const auxTheoremConcl = proofGoal?.ty;
        const theoremIndeces = proofGoal?.hyps
            .map((hyp) => `(${hypToString(hyp)})`)
            .join(" ");
        return `${theoremIndeces} : ${auxTheoremConcl}.`;
    }

    async rankContextTheorems(
        theorems: Theorem[],
        completionContext: CompletionContext
    ): Promise<Theorem[]> {
        const goal = completionContext.proofGoal;
        const anchorStatement = this.goalAsRocqStarTheoremString(goal);
        const candidates = theorems.map((th) => {
            if (th.initial_goal === null) {
                throw new Error(
                    `RocqStar ranker: theorem ${th.name} has no initial goal`
                );
            }

            return this.goalAsRocqStarTheoremString(th.initial_goal);
        });

        let distances: number[] = Array(candidates.length).fill(Infinity);
        try {
            for (const [i, candidate] of candidates.entries()) {
                const payload: RankRequest = {
                    statement1: anchorStatement,
                    statement2: candidate,
                };

                let resp: AxiosResponse<RankResponse, any>;
                try {
                    resp = await axios.post<RankResponse>(
                        `http://${RocqStarContextTheoremsRanker.host}:${RocqStarContextTheoremsRanker.port}/distance`,
                        payload,
                        /* eslint-disable @typescript-eslint/naming-convention */
                        { headers: { "Content-Type": "application/json" } }
                    );
                } catch (err: unknown) {
                    console.error(
                        `RocqStar ranker: error while calling RocqStar API`,
                        err
                    );
                    return theorems;
                }

                const distance = resp.data.distance;
                if (typeof distance !== "number") {
                    console.warn(
                        `RocqStar Ranker: expected a number, got ${distance}`
                    );
                    return theorems;
                }
                distances[i] = distance;
            }

            const zipped = theorems.map((th, i) => ({ th, d: distances[i] }));
            const sorted = zipped.sort((a, b) => a.d - b.d);

            return sorted.map((x) => x.th);
        } catch (err: any) {
            console.error(
                "RocqStar ranker error",
                err?.response?.data || err.message
            );
            return theorems;
        }
    }
}
