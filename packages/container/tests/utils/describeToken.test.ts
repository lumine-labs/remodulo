import { describe, expect, it } from "vitest"

import { Container } from "../../src/container.js"
import { Token } from "../../src/tokenizer.js"
import { describeToken } from "../../src/utils/describeToken.js"

// describeToken, now public.
// ========================================
//
// It was already the thing every error message names a token with; it is exported because the layer above
// needs the SAME rendering for its own diagnostics, and a copy of it there drifts the moment either side
// changes. So the claim worth pinning is not "it returns these strings" — that would be the copy again,
// written as an assertion — but "what it returns is what an error message shows". The expected value is
// therefore CAPTURED out of a real throw rather than typed in beside it.

/** The token as the `notRegistered` message renders it, cut back out of the message. */
function renderedByAnError(token: Parameters<typeof describeToken>[0]): string {
    try {
        new Container().resolve(token)
    } catch (error) {
        const { message } = error as Error
        return message.slice("Token ".length, message.indexOf(" is not registered"))
    }
    throw new Error("resolve was supposed to throw")
}

describe("describeToken", () => {
    it("renders every token kind the way an error message shows it", () => {
        class Service {}
        const symbolToken = Symbol("PLUGINS")
        const tokenizerToken = Token("describe-token.probe")
        const stringToken = "describe-token.string"
        const namelessSymbol = Symbol()

        for (const token of [Service, symbolToken, tokenizerToken, stringToken, namelessSymbol]) {
            expect(describeToken(token)).toBe(renderedByAnError(token))
        }

        // The captures above are only worth something if the kinds render differently, so the rendering
        // itself is stated once — and it is the tokenizer's namespaced key, not the bare name. A symbol
        // with no description falls back to its own `toString`, which is the only thing left to say.
        expect([
            describeToken(Service),
            describeToken(symbolToken),
            describeToken(tokenizerToken),
            describeToken(stringToken),
            describeToken(namelessSymbol),
        ]).toEqual([
            "Service",
            "PLUGINS",
            "@remodulo/container:describe-token.probe",
            "describe-token.string",
            "Symbol()",
        ])
    })

    it("names an anonymous class rather than rendering an empty string", () => {
        // A class expression passed straight in gets no inferred name, so `.name` is `""` — falsy, and an
        // error reading `Token  is not registered` would name nothing at all.
        expect(describeToken(class {})).toBe("(anonymous)")

        // The contrast: the same expression bound to a name inherits it, which is why this arm is easy to
        // believe unreachable and is not.
        const Named = class {}
        expect(describeToken(Named)).toBe("Named")
    })

    it("falls back to String() for a non-token, and to a fixed label when even that throws", () => {
        // `describeToken` is a published function taking a published union, so what it does with a value
        // from outside that union is surface too — it renders rather than throwing, whatever it is handed.
        expect(describeToken({} as never)).toBe("[object Object]")
        expect(describeToken(42 as never)).toBe("42")
        expect(describeToken(null as never)).toBe("null")

        // The tail: a null-prototype object cannot be converted to a primitive at all, so `String` throws
        // and the catch is what answers.
        expect(describeToken(Object.create(null) as never)).toBe("(unknown token)")
    })
})
