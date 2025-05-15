import { Err, Ok, Result } from "ts-results";

export class CoqCommandParsingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CoqCommandParsingError";
    }
}

export type Validator<InputType> = (
    inputParams: InputType
) => [boolean, string];

export namespace ValidationRules {
    export const beNonEmptyString: Validator<string> = (value: string) => [
        value.length > 0,
        "Value must not be empty.",
    ];

    export const haveNoNewLines: Validator<string> = (value: string) => [
        !value.includes("\n"),
        "Value must not contain new lines.",
    ];

    export const haveNoQuotes: Validator<string> = (value: string) => [
        !value.includes('"'),
        "Value must not contain quotes.",
    ];

    export const containNoDots: Validator<string> = (value: string) => [
        !value.includes("."),
        "Value must not contain dots.",
    ];
}

export abstract class CoqCommandType {
    constructor() {}
    protected abstract toString(): string;
    protected argRules: [boolean, string][] = [];

    protected validateArgs(): Result<void, string> {
        for (const [validator, errorMessage] of this.argRules) {
            if (!validator) {
                return Err(errorMessage);
            }
        }
        return Ok(undefined);
    }

    get(): Result<string, CoqCommandParsingError> {
        const validationResult = this.validateArgs();
        if (validationResult.ok) {
            return Ok(this.toString());
        } else {
            return Err(
                new CoqCommandParsingError(
                    `Command received invalid arguments: ${validationResult.val}`
                )
            );
        }
    }
}

export class SearchCoqCommand extends CoqCommandType {
    constructor(private pattern: string) {
        super();
    }

    argRules: [boolean, string][] = [
        ValidationRules.beNonEmptyString(this.pattern),
        ValidationRules.haveNoNewLines(this.pattern),
        ValidationRules.haveNoQuotes(this.pattern),
    ];

    public toString(): string {
        return `Proof.\nSearch (${this.pattern}).`;
    }
}

export class AboutCoqCommand extends CoqCommandType {
    constructor(private term: string) {
        super();
    }

    argRules: [boolean, string][] = [
        ValidationRules.beNonEmptyString(this.term),
        ValidationRules.haveNoNewLines(this.term),
        ValidationRules.containNoDots(this.term),
    ];

    public toString(): string {
        return `Proof.\nAbout ${this.term}.`;
    }
}

export class PrintAllCoqCommand extends CoqCommandType {
    constructor() {
        super();
    }

    public toString(): string {
        return "Proof.\nPrint All.";
    }
}

export class PrintCoqCommand extends CoqCommandType {
    constructor(private term: string) {
        super();
    }

    argRules: [boolean, string][] = [
        ValidationRules.beNonEmptyString(this.term),
        ValidationRules.haveNoNewLines(this.term),
        ValidationRules.containNoDots(this.term),
    ];

    public toString(): string {
        return `Proof.\nPrint ${this.term}.`;
    }
}

export class CheckCoqCommand extends CoqCommandType {
    constructor(private term: string) {
        super();
    }

    argRules: [boolean, string][] = [
        ValidationRules.beNonEmptyString(this.term),
        ValidationRules.haveNoNewLines(this.term),
        ValidationRules.containNoDots(this.term),
    ];

    public toString(): string {
        return `Proof.\nCheck ${this.term}.`;
    }
}
