const revealRedacted = Symbol("cfpaste.reveal-redacted");
const inspectCustom = Symbol.for("nodejs.util.inspect.custom");

export interface Redacted<Value> {
	readonly [revealRedacted]: () => Value;
	toString(): string;
	toJSON(): string;
}

class RedactedBox<Value> implements Redacted<Value> {
	readonly #value: Value;

	constructor(value: Value) {
		this.#value = value;
		Object.freeze(this);
	}

	readonly [revealRedacted] = (): Value => this.#value;
	readonly [inspectCustom] = (): string => "<redacted>";

	toString(): string {
		return "<redacted>";
	}

	toJSON(): string {
		return "<redacted>";
	}
}

function make<Value>(value: Value): Redacted<Value> {
	return new RedactedBox(value);
}

function value<Value>(wrapped: Redacted<Value>): Value {
	if (!(wrapped instanceof RedactedBox)) {
		throw new Error("Redacted value was not created by this module");
	}
	return wrapped[revealRedacted]();
}

export const Redacted = { make, value } as const;
