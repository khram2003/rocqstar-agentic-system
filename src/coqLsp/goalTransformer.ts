import { ApiGoal } from "../agentServer/models/apiGoal";

import { Goal, PpString, convertToString } from "./coqLspTypes";

/**
 * Transforms an API goal to a proof goal
 * @param apiGoal The API goal to transform
 * @returns The transformed proof goal
 */
export function apiGoalToProofGoal(apiGoal: ApiGoal): Goal<PpString> {
    return {
        ty: apiGoal.conclusion,
        hyps: apiGoal.hypothesis.map((hyp) => ({
            names: [hyp],
            ty: hyp,
        })),
    };
}

/**
 * Transforms a proof goal to an API goal
 * @param proofGoal The proof goal to transform
 * @returns The transformed API goal
 */
export function proofGoalToApiGoal(proofGoal: Goal<PpString>): ApiGoal {
    return {
        conclusion: convertToString(proofGoal.ty),
        hypothesis: proofGoal.hyps.map((hyp) => convertToString(hyp.ty)),
    };
}
