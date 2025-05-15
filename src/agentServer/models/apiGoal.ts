import { Result } from "ts-results";

export interface ProofError {
    message: string;
    location?: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    } | null;
}

export interface ApiGoal {
    hypothesis: string[];
    conclusion: string;
}

export type CheckProofResult = Result<ApiGoal[], ProofError>;
