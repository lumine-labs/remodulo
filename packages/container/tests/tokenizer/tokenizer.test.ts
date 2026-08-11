import { describe, expect, it } from "vitest"

import { Container } from "../../src/container.js"
import { makeTokenizer } from "../../src/tokenizer.js"

// Tokens.
// ========================================
//
// A token is a symbol interned in the GLOBAL registry under `<namespace>:<name>`, so two copies of a package
// in one process still agree about what a token is. That is the whole mechanism, and the API is now honest
// about it: minting the same name twice hands back the same token rather than throwing, because
// `Symbol.for` was always going to return the same symbol either way.
//
// What keeps two unrelated libraries from colliding is the NAMESPACE, which every tokenizer must name. That
// is structural — a feature with its own tokenizer cannot collide with anyone else's — where the old
// duplicate guard was social, and it caught only same-name-through-the-same-factory while breaking under
// HMR, which re-runs the module and re-declares every token.

describe("minting", () => {
    it("returns a symbol interned under `<namespace>:<name>`", () => {
        const tokens = makeTokenizer("tests.tokenizer.interning")

        const token = tokens("service")

        expect(typeof token).toBe("symbol")
        expect((token as symbol).description).toBe("tests.tokenizer.interning:service")
        expect(token).toBe(Symbol.for("tests.tokenizer.interning:service"))
    })

    it("carries the value type through to the token", () => {
        const tokens = makeTokenizer("tests.tokenizer.typed")
        const GREETING = tokens<string>("greeting")

        const container = new Container()
        container.register({ provide: GREETING, useValue: "hello" })

        const greeting: string = container.resolve(GREETING)
        expect(greeting).toBe("hello")
    })
})

describe("idempotence", () => {
    it("hands back the SAME token for the same name, however many times it is minted", () => {
        // The duplicate guard is gone, and this is what replaces it: re-declaring is not an error, it is
        // the same declaration. A module re-evaluated by HMR mints the same tokens it minted before.
        const tokens = makeTokenizer("tests.tokenizer.idempotent")

        const first = tokens("repeated")
        const second = tokens("repeated")
        const third = tokens("repeated")

        expect(second).toBe(first)
        expect(third).toBe(first)
        expect(first).toBe(Symbol.for("tests.tokenizer.idempotent:repeated"))
    })

    it("agrees across two tokenizers over the same namespace", () => {
        // Identity lives in the global registry, not in the factory, so two factories over one namespace
        // are two doors to the same tokens.
        const first = makeTokenizer("tests.tokenizer.same-namespace")
        const second = makeTokenizer("tests.tokenizer.same-namespace")

        expect(second("shared")).toBe(first("shared"))
    })

    it("keeps the same name apart across DIFFERENT namespaces", () => {
        // The other half, and the reason the namespace is mandatory: this is what makes an accidental
        // collision between two libraries impossible rather than merely discouraged.
        const feature = makeTokenizer("tests.tokenizer.feature-a")
        const other = makeTokenizer("tests.tokenizer.feature-b")

        const fromFeature = feature("logger")
        const fromOther = other("logger")

        expect(fromFeature).not.toBe(fromOther)
        expect((fromFeature as symbol).description).toBe("tests.tokenizer.feature-a:logger")
        expect((fromOther as symbol).description).toBe("tests.tokenizer.feature-b:logger")

        // And they really are two different tokens as far as a container is concerned.
        const container = new Container()
        container.register([
            { provide: fromFeature, useValue: "a" },
            { provide: fromOther, useValue: "b" },
        ])
        expect(container.resolve(fromFeature)).toBe("a")
        expect(container.resolve(fromOther)).toBe("b")
    })
})

describe("name and namespace validation", () => {
    it("rejects an empty or whitespace-only name", () => {
        const tokens = makeTokenizer("tests.tokenizer.validation")

        expect(() => tokens("")).toThrow("Token: `name` must be a non-empty string.")
        expect(() => tokens("   \t\n ")).toThrow("Token: `name` must be a non-empty string.")
    })

    it("rejects an empty or whitespace-only namespace", () => {
        // There is no default namespace to fall back to any more — the namespace is the whole collision
        // story, so a tokenizer that names none is refused where it is built rather than where it is used.
        expect(() => makeTokenizer("")).toThrow("makeTokenizer: `namespace` must be a non-empty string.")
        expect(() => makeTokenizer("   ")).toThrow("makeTokenizer: `namespace` must be a non-empty string.")
    })

    it("trims both halves before interning", () => {
        const tokens = makeTokenizer("  tests.tokenizer.trimming  ")

        expect(tokens("  padded  ")).toBe(Symbol.for("tests.tokenizer.trimming:padded"))
        expect(tokens("padded")).toBe(tokens("  padded  "))
    })
})

describe("end to end", () => {
    it("registers and resolves through a token from `makeTokenizer`", () => {
        const tokens = makeTokenizer("tests.tokenizer.e2e")
        const GREETING = tokens<string>("greeting")

        const container = new Container()
        container.register({ provide: GREETING, useValue: "hello" })

        expect(container.resolve<string>(GREETING)).toBe("hello")
        expect(container.isRegistered(GREETING)).toBe(true)
    })

    it("names the token by its full key in container errors", () => {
        const tokens = makeTokenizer("tests.tokenizer.errors")
        const MISSING = tokens("missing")

        expect(() => new Container().resolve(MISSING)).toThrow(
            "Token tests.tokenizer.errors:missing is not registered in this container or any ancestor."
        )
    })
})

// The namespace is REQUIRED, and the options bag is gone. Checked by `typecheck:tests`, and again against
// the published declarations in the consumer fixtures. Never called.
function tokenizerGrammar(): void {
    // @ts-expect-error a tokenizer must name its namespace — there is no default to fall back to.
    makeTokenizer()

    const tokens = makeTokenizer("tests.tokenizer.grammar")

    // @ts-expect-error `allowDuplicate` went with the duplicate guard; minting takes a name and nothing else.
    tokens("named", { allowDuplicate: true })
}
void tokenizerGrammar
