declare const redactedBrand: unique symbol;

export interface Redacted<Value> {
	readonly [redactedBrand]?: Value;
	toString(): string;
	toJSON(): string;
}

const values = new WeakMap<object, unknown>();
const prototype = {
	toString: () => "<redacted>",
	toJSON: () => "<redacted>",
	[Symbol.for("nodejs.util.inspect.custom")]: () => "<redacted>",
};

function make<Value>(value: Value): Redacted<Value> {
	// SAFETY: the frozen prototype supplies the complete public surface; the secret remains in a WeakMap.
	const wrapped = Object.create(prototype) as Redacted<Value>;
	values.set(wrapped, value);
	return wrapped;
}

function value<Value>(wrapped: Redacted<Value>): Value {
	if (typeof wrapped !== "object" || wrapped === null || !values.has(wrapped)) {
		throw new Error("Redacted value was not created by this module");
	}
	return values.get(wrapped) as Value;
}

export const Redacted = { make, value } as const;
