import { describe, expect, it } from "vitest"

import { Container } from "../../src/container.js"
import {
    CYCLE_ERROR_CODE,
    CycleError,
    REGISTRATION_ERROR_CODE,
    RESOLUTION_ERROR_CODE,
    RegistrationError,
    ResolutionError,
} from "../../src/container.errors.js"
import { INJECTION_CONTEXT_ERROR_CODE, InjectionContextError } from "../../src/injector.errors.js"
import { inject, injectAll, injectContainer } from "../../src/injector.js"

// The named error hierarchy.
// ========================================
//
// Four classes over one message catalog. The MESSAGES did not move — every builder in
// `container.errors.ts` / `injector.errors.ts` still produces the same bytes, and the rest of this suite
// (plus `@remodulo/react`, which substring-matches them) is what pins that. What is new is everything a
// caller could previously only get by parsing those bytes:
//
//   - a class, so `catch` can branch on WHAT failed rather than on a phrase;
//   - structured fields, so the token / mode / cycle chain arrive as data instead of as text;
//   - a `code` string, because `instanceof` is the one discriminant that does NOT survive two copies of
//     the package in one process — the same hazard `notInInjectionContext` already warns about for the
//     frame. Two copies means two class identities; the code is just a string and compares equal across
//     them, so a layer above should read `code` and keep `instanceof` for the single-copy case.
//
// `CycleError extends ResolutionError` because a cycle IS a failed read, and a consumer that wants "any
// resolution failure" should not have to name it twice.

/** The thrown value itself — `toThrow` proves the message, this proves the shape behind it. */
function capture(run: () => unknown): unknown {
    try {
        run()
        return null
    } catch (error) {
        return error
    }
}

/** Alpha -> Beta -> Alpha, with the two classes handed back so the chain can be compared by identity. */
function cycle(): { container: Container; Alpha: new () => unknown; Beta: new () => unknown } {
    class Alpha {
        readonly beta = inject(Beta)
    }
    class Beta {
        readonly alpha = inject(Alpha)
    }

    const container = new Container()
    container.register([Alpha, Beta])
    return { container, Alpha, Beta }
}

describe("the hierarchy", () => {
    it("puts every class under Error", () => {
        const container = new Container()
        const TOKEN = Symbol("MISSING")

        expect(capture(() => container.resolve(TOKEN))).toBeInstanceOf(Error)
        expect(capture(() => container.register(null as never))).toBeInstanceOf(Error)
        expect(capture(() => inject(TOKEN))).toBeInstanceOf(Error)
    })

    it("throws a RegistrationError from the registration guards", () => {
        const container = new Container()

        expect(capture(() => container.register(null as never))).toBeInstanceOf(RegistrationError)
        expect(capture(() => container.register({ useValue: 1 } as never))).toBeInstanceOf(RegistrationError)
    })

    it("throws a ResolutionError from the read guards", () => {
        const container = new Container()
        const TOKEN = Symbol("MISSING")

        expect(capture(() => container.resolve(TOKEN))).toBeInstanceOf(ResolutionError)
    })

    it("throws an InjectionContextError outside a construction frame", () => {
        expect(capture(() => injectContainer())).toBeInstanceOf(InjectionContextError)
    })

    it("makes a CycleError a ResolutionError and an Error, in that order", () => {
        const { container, Alpha } = cycle()
        const thrown = capture(() => container.resolve(Alpha))

        expect(thrown).toBeInstanceOf(CycleError)
        expect(thrown).toBeInstanceOf(ResolutionError)
        expect(thrown).toBeInstanceOf(Error)
    })

    it("keeps registration and resolution on separate branches", () => {
        const container = new Container()
        const TOKEN = Symbol("MISSING")

        // Neither is a subtype of the other: a caller catching one must not silently swallow the other.
        expect(capture(() => container.register(null as never))).not.toBeInstanceOf(ResolutionError)
        expect(capture(() => container.resolve(TOKEN))).not.toBeInstanceOf(RegistrationError)
        expect(capture(() => inject(TOKEN))).not.toBeInstanceOf(ResolutionError)
    })

    it("names each class on the instance, so a bare log line still says what failed", () => {
        const container = new Container()
        const TOKEN = Symbol("MISSING")

        expect((capture(() => container.register(null as never)) as Error).name).toBe("RegistrationError")
        expect((capture(() => container.resolve(TOKEN)) as Error).name).toBe("ResolutionError")
        expect((capture(() => inject(TOKEN)) as Error).name).toBe("InjectionContextError")
        expect((capture(() => cycle().container.resolve(cycle().Alpha)) as Error).name).toBe("ResolutionError")
    })

    it("names CycleError itself, not the branch it hangs from", () => {
        const { container, Alpha } = cycle()

        expect((capture(() => container.resolve(Alpha)) as Error).name).toBe("CycleError")
    })
})

describe("codes", () => {
    it("stamps each class with its own code", () => {
        const container = new Container()
        const TOKEN = Symbol("MISSING")
        const { container: cyclic, Alpha } = cycle()

        expect((capture(() => container.register(null as never)) as RegistrationError).code).toBe(
            "REMODULO/REGISTRATION"
        )
        expect((capture(() => container.resolve(TOKEN)) as ResolutionError).code).toBe("REMODULO/RESOLUTION")
        expect((capture(() => cyclic.resolve(Alpha)) as CycleError).code).toBe("REMODULO/CYCLE")
        expect((capture(() => inject(TOKEN)) as InjectionContextError).code).toBe("REMODULO/INJECTION_CONTEXT")
    })

    it("publishes the same four strings as constants", () => {
        expect(REGISTRATION_ERROR_CODE).toBe("REMODULO/REGISTRATION")
        expect(RESOLUTION_ERROR_CODE).toBe("REMODULO/RESOLUTION")
        expect(CYCLE_ERROR_CODE).toBe("REMODULO/CYCLE")
        expect(INJECTION_CONTEXT_ERROR_CODE).toBe("REMODULO/INJECTION_CONTEXT")
    })

    it("keeps the four codes distinct", () => {
        const codes = [REGISTRATION_ERROR_CODE, RESOLUTION_ERROR_CODE, CYCLE_ERROR_CODE, INJECTION_CONTEXT_ERROR_CODE]

        expect(new Set(codes).size).toBe(codes.length)
    })

    it("overrides the code on the subclass rather than inheriting the branch's", () => {
        // The point of the code: this is the comparison that still works when `instanceof` cannot, because
        // the CycleError that was thrown came from a different copy of the package than the one catching.
        const { container, Alpha } = cycle()
        const thrown = capture(() => container.resolve(Alpha)) as ResolutionError

        expect(thrown.code).toBe(CYCLE_ERROR_CODE)
        expect(thrown.code).not.toBe(RESOLUTION_ERROR_CODE)
    })
})

describe("ResolutionError fields", () => {
    it("carries the token and the width for a miss under `self`", () => {
        const TOKEN = Symbol("INHERITED")
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "value" })
        const child = parent.fork()

        const thrown = capture(() => child.resolve(TOKEN, "self")) as ResolutionError

        expect(thrown.token).toBe(TOKEN)
        expect(thrown.mode).toBe("self")
    })

    it("carries `nearest` for the default single read", () => {
        const TOKEN = Symbol("MISSING")

        const thrown = capture(() => new Container().resolve(TOKEN)) as ResolutionError

        expect(thrown.token).toBe(TOKEN)
        expect(thrown.mode).toBe("nearest")
    })

    it("carries the token and the collection width when `resolveAll` refuses a single registration", () => {
        const TOKEN = Symbol("SINGLE")
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "only" })

        const chained = capture(() => container.resolveAll(TOKEN)) as ResolutionError
        const self = capture(() => container.resolveAll(TOKEN, "self")) as ResolutionError

        expect(chained.token).toBe(TOKEN)
        expect(chained.mode).toBe("chained")
        expect(self.mode).toBe("self")
    })

    it("carries the token and the width when `resolve` refuses a collection", () => {
        const TOKEN = Symbol("PLUGINS")
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "a", multi: true })

        const nearest = capture(() => container.resolve(TOKEN)) as ResolutionError
        const self = capture(() => container.resolve(TOKEN, "self")) as ResolutionError

        expect(nearest.token).toBe(TOKEN)
        expect(nearest.mode).toBe("nearest")
        expect(self.mode).toBe("self")
    })

    it("leaves `mode` undefined on the readers that take no width", () => {
        // `entry` and `entries` read this container's own registrations and take no mode, so there is no
        // width to report — as opposed to one defaulted in for the field's sake.
        const TOKEN = Symbol("PLUGINS")
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "a", multi: true })

        const thrown = capture(() => container.entry(TOKEN)) as ResolutionError

        expect(thrown.token).toBe(TOKEN)
        expect(thrown.mode).toBeUndefined()
    })
})

describe("CycleError.chain", () => {
    it("is the measured cycle, as tokens", () => {
        const { container, Alpha, Beta } = cycle()

        const thrown = capture(() => container.resolve(Alpha)) as CycleError

        // Identity, not rendering: the whole point of the field is that a caller never has to parse
        // "Alpha -> Beta -> Alpha" back into the classes it names.
        expect(thrown.chain).toEqual([Alpha, Beta, Alpha])
        expect(thrown.message).toBe("Circular dependency found: Alpha -> Beta -> Alpha")
    })

    it("starts where the cycle closes, whichever end asked", () => {
        const { container, Alpha, Beta } = cycle()

        expect((capture(() => container.resolve(Beta)) as CycleError).chain).toEqual([Beta, Alpha, Beta])
    })

    it("puts the repeated token at both ends, and reports it as the error's token", () => {
        const { container, Alpha } = cycle()
        const thrown = capture(() => container.resolve(Alpha)) as CycleError

        expect(thrown.chain[0]).toBe(Alpha)
        expect(thrown.chain[thrown.chain.length - 1]).toBe(Alpha)
        expect(thrown.token).toBe(Alpha)
    })

    it("hands out a frozen chain", () => {
        const { container, Alpha } = cycle()
        const thrown = capture(() => container.resolve(Alpha)) as CycleError

        expect(Object.isFrozen(thrown.chain)).toBe(true)
    })
})

describe("InjectionContextError.caller", () => {
    it("names the reader that was called, not the frame it wanted", () => {
        const TOKEN = Symbol("ANYTHING")

        expect((capture(() => inject(TOKEN)) as InjectionContextError).caller).toBe("inject")
        expect((capture(() => injectAll(TOKEN)) as InjectionContextError).caller).toBe("injectAll")
        expect((capture(() => injectContainer()) as InjectionContextError).caller).toBe("injectContainer")
    })

    it("agrees with the name the message opens on", () => {
        const thrown = capture(() => injectContainer()) as InjectionContextError

        expect(thrown.message.startsWith(`${thrown.caller}(`)).toBe(true)
    })
})

describe("RegistrationError.token", () => {
    it("names the token whose mode conflicts", () => {
        const TOKEN = Symbol("PLUGINS")
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "a" })

        const thrown = capture(() => container.register({ provide: TOKEN, useValue: "b", multi: true }))

        expect((thrown as RegistrationError).token).toBe(TOKEN)
    })

    it("names it for a conflict inherited from an ancestor too", () => {
        const TOKEN = Symbol("PLUGINS")
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })

        const thrown = capture(() => parent.fork().register({ provide: TOKEN, useValue: "child", multi: true }))

        expect((thrown as RegistrationError).token).toBe(TOKEN)
    })

    it("names the token being registered, on both ends of the alias-targets-multi refusal", () => {
        const TOKEN = Symbol("PLUGINS")
        const ALIAS = Symbol("ALIAS")

        // Alias arrives second: the provider being refused registers ALIAS.
        const aliasLast = new Container()
        aliasLast.register({ provide: TOKEN, useValue: "a", multi: true })
        const onAlias = capture(() => aliasLast.register({ provide: ALIAS, useExisting: TOKEN }))

        // Collection arrives second: the provider being refused registers TOKEN.
        const aliasFirst = new Container()
        aliasFirst.register({ provide: TOKEN, useValue: "a" })
        aliasFirst.register({ provide: ALIAS, useExisting: TOKEN })
        const onTarget = capture(() => aliasFirst.register({ provide: TOKEN, useValue: "b", multi: true }))

        expect((onAlias as RegistrationError).token).toBe(ALIAS)
        expect((onTarget as RegistrationError).token).toBe(TOKEN)
    })

    it("names the token a duplicate registration claims", () => {
        const TOKEN = Symbol("ONCE")
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "a" })

        const thrown = capture(() => container.register({ provide: TOKEN, useValue: "b" }))

        expect((thrown as RegistrationError).token).toBe(TOKEN)
    })

    it("is undefined when the failing provider names no token at all", () => {
        // `missingProvide` IS the absence of a token, and a malformed non-object carries nowhere to look.
        const container = new Container()

        expect((capture(() => container.register({ useValue: 1 } as never)) as RegistrationError).token).toBeUndefined()
        expect((capture(() => container.register(null as never)) as RegistrationError).token).toBeUndefined()
    })

    it("renders a non-object provider as its own value, not as its absent token", () => {
        // Not a field pin — a MESSAGE pin, and it is here because this refactor is what made it needed.
        // Extracting `providerToken` out of `providerLabel` (so a throw site can populate `token` from the
        // same shape the label reads) left one branch printing `provider` where the other prints its token,
        // and the two are one keystroke apart. Nothing else in the suite reaches this branch.
        const container = new Container()

        expect(() => container.register(null as never)).toThrow(
            "Provider null has no recognised form — expected a class, or an object with one of useClass, useValue, useFactory or useExisting."
        )
        expect(() => container.register(42 as never)).toThrow("Provider 42 has no recognised form")
    })

    it("still names it when a malformed provider declared `provide`", () => {
        const TOKEN = Symbol("BROKEN")
        const container = new Container()

        const thrown = capture(() => container.register({ provide: TOKEN, useClass: "nope" } as never))

        expect((thrown as RegistrationError).token).toBe(TOKEN)
    })
})
