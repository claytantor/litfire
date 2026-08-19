import {createHash} from 'node:crypto';
import ivm from 'isolated-vm';

export type Formula = {
	readonly id: string;
	readonly source: string;
	/**
	 * The system whose page defined it; absent for the shared
	 * `system/formulas.md`.
	 *
	 * Scoping is not decoration. Every system's curve defaults to the id
	 * `xp-for-level`, so two systems in one vault collide on the obvious name
	 * immediately — and the collision would be silent, with one system levelling
	 * its characters by another's curve.
	 */
	readonly system?: string;
};

/** Storage key for a formula: scoped to its system, or bare when shared. */
export function formulaKey(id: string, system?: string): string {
	return system === undefined ? id : `${system}/${id}`;
}

export type FormulaError = {
	readonly id: string;
	readonly message: string;
};

const CPU_TIMEOUT_MS = 100;
const MEMORY_LIMIT_MB = 16;

/**
 * Globals that exist inside a fresh isolate but break deterministic replay.
 *
 * Verified empirically on isolated-vm 6.2.0 / Node 22: `fetch`, `process`,
 * `require`, and the module loaders are already absent, but the nondeterministic
 * intrinsics below are NOT — §6.4 requires they be removed, so a corpus always
 * replays identically.
 */
const NONDETERMINISTIC_PRELUDE = `
	(function () {
		const reject = (name) => function () {
			throw new Error(name + ' is unavailable: formulas must be deterministic');
		};
		Math.random = reject('Math.random');
		Date.now = reject('Date.now');
		Date.parse = reject('Date.parse');
		globalThis.Date = new Proxy(Date, {
			construct() { throw new Error('Date is unavailable: formulas must be deterministic'); },
			apply() { throw new Error('Date is unavailable: formulas must be deterministic'); },
		});
		for (const name of ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask']) {
			if (name in globalThis) { globalThis[name] = reject(name); }
		}
	})();
`;

export function hashFormulas(formulas: readonly Formula[]): string {
	const hash = createHash('sha256');
	const keyed = formulas.map(formula => ({
		key: formulaKey(formula.id, formula.system),
		source: formula.source,
	}));
	for (const formula of keyed.toSorted((a, b) => a.key.localeCompare(b.key))) {
		hash.update(`${formula.key}\0${formula.source}\0`);
	}
	return hash.digest('hex');
}

/**
 * Evaluates author-supplied formulas in an isolate.
 *
 * `node:vm` is explicitly not used — it shares a heap with the host and is not a
 * security boundary (§6.4). Each runner owns one isolate; call `dispose()` when
 * finished or the native memory leaks.
 */
export class FormulaRunner {
	readonly #isolate: ivm.Isolate;
	readonly #context: ivm.Context;
	readonly #refs = new Map<string, ivm.Reference>();
	readonly #errors: FormulaError[] = [];
	#disposed = false;

	private constructor(isolate: ivm.Isolate, context: ivm.Context) {
		this.#isolate = isolate;
		this.#context = context;
	}

	static async create(formulas: readonly Formula[]): Promise<FormulaRunner> {
		const isolate = new ivm.Isolate({memoryLimit: MEMORY_LIMIT_MB});
		const context = await isolate.createContext();
		await context.eval(NONDETERMINISTIC_PRELUDE, {timeout: CPU_TIMEOUT_MS});

		const runner = new FormulaRunner(isolate, context);

		for (const formula of formulas) {
			try {
				// Parenthesised so a bare arrow function is an expression. The
				// trailing semicolon authors naturally write (and that the spec's
				// own examples carry) would be a syntax error inside the parens.
				const expression = formula.source.trim().replace(/;+$/, '');
				const reference = await context.eval(`(${expression})`, {
					reference: true,
					timeout: CPU_TIMEOUT_MS,
				});
				runner.#refs.set(formulaKey(formula.id, formula.system), reference);
			} catch (caught) {
				runner.#errors.push({
					id: formula.id,
					message: caught instanceof Error ? caught.message : String(caught),
				});
			}
		}

		return runner;
	}

	/** Compile-time failures, surfaced as open questions rather than thrown. */
	get errors(): readonly FormulaError[] {
		return this.#errors;
	}

	/**
	 * The key a formula id resolves to from inside a system: that system's own
	 * definition first, then the shared file. Undefined when neither has it,
	 * which callers turn into an open question rather than a throw.
	 */
	resolve(id: string, system?: string): string | undefined {
		const scoped = formulaKey(id, system);
		if (system !== undefined && this.#refs.has(scoped)) {
			return scoped;
		}
		return this.#refs.has(id) ? id : undefined;
	}

	has(id: string, system?: string): boolean {
		return this.resolve(id, system) !== undefined;
	}

	/**
	 * Calls a formula with structured-cloneable arguments and returns a number.
	 * Throws on a missing id, a timeout, or a non-numeric result — callers turn
	 * that into an open question (§7.1 "formula evaluation error").
	 */
	async call(id: string, ...args: readonly unknown[]): Promise<number> {
		const reference = this.#refs.get(id);
		if (!reference) {
			throw new Error(`formula '${id}' is not defined`);
		}

		// `release: true` is load-bearing, not tidiness. An ExternalCopy allocates
		// outside the V8 heap, so the collector has no idea it is holding anything
		// and will not reclaim it under pressure. A replay calls formulas once per
		// candidate level per xp event; without the release those copies accumulate
		// until the process dies with the heap full of memory V8 cannot see.
		const copied = args.map(argument =>
			new ivm.ExternalCopy(argument).copyInto({release: true}),
		);
		const result: unknown = await reference.apply(undefined, copied, {
			timeout: CPU_TIMEOUT_MS,
		});

		if (typeof result !== 'number' || Number.isNaN(result)) {
			throw new Error(`formula '${id}' returned ${String(result)}, expected a number`);
		}
		return result;
	}

	dispose(): void {
		if (this.#disposed) {
			return;
		}
		this.#disposed = true;
		for (const reference of this.#refs.values()) {
			reference.release();
		}
		this.#refs.clear();
		this.#context.release();
		this.#isolate.dispose();
	}
}
