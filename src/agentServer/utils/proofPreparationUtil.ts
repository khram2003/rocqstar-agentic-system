import { existsSync } from "fs";

import { Uri } from "../../utils/uri";

export function prepareProofToCheck(proof: string): string {
    // Remove backticks
    let preparedProof = proof
        .replace(/`/g, "")
        .replace(/Proof using.*?\./gi, "")
        .replace(/Proof\./gi, "")
        .replace(/Qed\./gi, "")
        .replace(/Admitted\./gi, "")
        .replace(/Abort\./gi, "");

    preparedProof = `Proof. ${preparedProof.trim()} `;

    return preparedProof;
}

export function makeAuxFileName(
    coqProjectRootPath: string,
    sourceFilePath: string,
    unique: boolean = true
): Uri {
    const defaultAuxFileName = "agent_request_cp_aux.v";
    // path is undefined for some reasons here
    const sourceDirPath = sourceFilePath.substring(
        0,
        sourceFilePath.lastIndexOf("/")
    );
    let auxFilePath = `${sourceDirPath}/${defaultAuxFileName}`;
    console.log("auxFilePath", auxFilePath);
    console.log(
        "existsSync(auxFilePath)",
        existsSync(`${coqProjectRootPath}/${auxFilePath}`)
    );
    if (unique && existsSync(`${coqProjectRootPath}/${auxFilePath}`)) {
        console.log(
            "existsSync(auxFilePath)",
            existsSync(`${coqProjectRootPath}/${auxFilePath}`)
        );
        const randomSuffix = Math.floor(Math.random() * 1000000);
        auxFilePath = auxFilePath.replace(
            /\_cp_aux.v$/,
            `_${randomSuffix}_cp_aux.v`
        );
        console.log("auxFilePath", auxFilePath);
    }

    return Uri.fromPath(auxFilePath);
}
