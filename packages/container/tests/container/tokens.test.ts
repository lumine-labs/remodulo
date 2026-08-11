import { describe, expect, it } from "vitest"

import { Container } from "../../src/container.js"
import { Resolver } from "../../src/resolver.js"
import { inject } from "../../src/injector.js"
import { describeToken } from "../../src/utils/describeToken.js"

// What may be a token.
// ========================================
//
// A token is an IDENTITY, and the container never does anything with a `provide` key but compare it. So the
// grammar admits three class shapes — constructible, abstract, and neither — and the last two are not an
// oversight: `AbstractConstructor` has always been a legal token, which already said that a token-class
// need not be buildable. `ClassKey` finishes the thought for the class that cannot be `new`ed at all.
//
// The line the widening does NOT cross is the other half of the grammar: everything the container actually
// BUILDS from still demands `Constructor`. That boundary is pinned at the bottom of this file, at compile
// time, because no `it` can reach it.

abstract class Policy {
    abstract readonly name: string
}

class Sealed {
    readonly kind = "sealed"
    private constructor() {}
    static make(): Sealed {
        return new Sealed()
    }
}

describe("a class used as a key", () => {
    it("registers and resolves under an abstract class", () => {
        const container = new Container()
        const policy: Policy = { name: "strict" }
        container.register({ provide: Policy, useValue: policy })

        expect(container.resolve(Policy)).toBe(policy)
        expect(container.isRegistered(Policy)).toBe(true)
        expect(container.entry(Policy)?.token).toBe(Policy)
    })

    it("registers and resolves under a class whose constructor is private", () => {
        // The case the widening exists for: `Resolver` is registered by the layer above under its own class,
        // and that class cannot be constructed from outside itself.
        const container = new Container()
        const sealed = Sealed.make()
        container.register({ provide: Sealed, useValue: sealed })

        expect(container.resolve(Sealed)).toBe(sealed)
        expect(container.resolve(Sealed).kind).toBe("sealed")
    })

    it("is the same identity comparison every other token gets", () => {
        // Nothing about the runtime changed: a class key is a Map key like any other, so a second class with
        // the same shape is a different token and shadowing works the ordinary way.
        class Other {
            readonly kind = "sealed"
        }

        const parent = new Container()
        parent.register({ provide: Sealed, useValue: Sealed.make() })
        const child = parent.fork()
        const shadow = Sealed.make()
        child.register({ provide: Sealed, useValue: shadow })

        expect(child.resolve(Sealed)).toBe(shadow)
        expect(child.resolve(Sealed)).not.toBe(parent.resolve(Sealed))
        expect(parent.isRegistered(Other)).toBe(false)
    })

    it("names itself in an error the way any class token does", () => {
        expect(describeToken(Sealed)).toBe("Sealed")
        expect(describeToken(Policy)).toBe("Policy")
        expect(() => new Container().resolve(Sealed)).toThrow(
            "Token Sealed is not registered in this container or any ancestor."
        )
    })

    it("reaches the canonical Resolver through its own class, end to end", () => {
        class Consumer {
            readonly resolver = inject(Resolver)
        }

        const container = new Container()
        container.register([{ provide: Resolver, useValue: Resolver.for(container) }, Consumer])

        expect(container.resolve(Consumer).resolver).toBe(Resolver.for(container))
    })
})

// The half of the grammar no `it` can reach. Checked by `pnpm run typecheck:tests` against src; the emitted
// declarations carry these very shapes, so the same pins are what a consumer gets. Never called.
// ========================================

// Inference, which is the whole point of the arm carrying `T`. A widening that admitted the class but lost
// its type would hand every read back as `unknown`, and one that reached for `any` would lose the refusals
// below with it. Both are excluded here: `unknown` fails the annotated line, and `any` would make the
// `@ts-expect-error` beneath it unused — which `typecheck:tests` reports as an error of its own.
function classKeysInferTheirInstance(container: Container): void {
    const sealed: Sealed = container.resolve(Sealed)
    void sealed.kind

    // @ts-expect-error `resolve(Sealed)` is a `Sealed`, not a string — the arm carries the type through.
    const notAString: string = container.resolve(Sealed)
    void notAString

    const policy: Policy = container.resolve(Policy)
    void policy.name

    // @ts-expect-error and an abstract class token infers its INSTANCE type, not the class object.
    const notTheClass: typeof Policy = container.resolve(Policy)
    void notTheClass

    const optional: Sealed | undefined = container.resolveOptional(Sealed)
    void optional

    const all: Sealed[] = container.resolveAll(Sealed)
    void all
}
void classKeysInferTheirInstance

// The arm is a FALLBACK, and this is the pin that says so. A structural `{ prototype: T }` reads a generic
// class's prototype as `Box<any>`, so an eagerly-inferring arm would quietly widen every generic class
// token from `Box<unknown>` to `Box<any>` — measured, not theoretical: it is what `NoInfer` was added to
// stop, and `@remodulo/react`'s `inject(PropsRef)` is the call site that caught it.
class Box<T> {
    current!: T
}

function genericClassTokensDoNotDecayToAny(container: Container): void {
    const box: Box<unknown> = container.resolve(Box)

    // @ts-expect-error `Box<unknown>`, so `.current` is unknown and nothing may be assumed of it.
    const current: string = box.current
    void current
}
void genericClassTokensDoNotDecayToAny

function injectionInfersTheSame(): void {
    class Consumer {
        readonly sealed: Sealed = inject(Sealed)
        readonly policy: Policy = inject(Policy)
    }
    void Consumer
}
void injectionInfersTheSame

// The boundary. `InjectionToken` widened; `Constructor` did not, and every door that BUILDS is spelled with
// `Constructor`: the bare-class shorthand, both class providers' `useClass`, and `construct`. A class that
// cannot be `new`ed is therefore a legal key and an illegal implementation, which is exactly the split.
function buildingStillDemandsAConstructor(container: Container): void {
    // @ts-expect-error the bare shorthand registers a class under itself AND builds it.
    container.register(Sealed)

    // @ts-expect-error the self form is the same registration with options on it.
    container.register({ useClass: Sealed })

    // @ts-expect-error and naming a token beside it changes nothing: `useClass` is the implementation.
    container.register({ provide: Sealed, useClass: Sealed })

    // @ts-expect-error an abstract class is refused there for the same reason it always was.
    container.register({ provide: Policy, useClass: Policy })

    // @ts-expect-error `construct` builds without registering, so it is a `Constructor` door too.
    container.construct(Sealed)
}
void buildingStillDemandsAConstructor

// The measured cost of a STRUCTURAL arm, pinned rather than assumed: `Function` declares `prototype: any`
// in lib.d.ts, so every function type satisfies `ClassKey` — an arrow included, even though an arrow has no
// `prototype` at runtime, and its `T` lands on `any`. The widening therefore reaches every callable, not
// only classes. What still holds is that a token is a string, a symbol or a function object, and the
// refusals below are what the union is still worth.
function aTokenIsStillAToken(container: Container): void {
    // @ts-expect-error a number is not a token.
    container.resolve(42)

    // @ts-expect-error nor is a plain object.
    container.resolve({ named: "token" })

    // @ts-expect-error nor is null, which is what an unresolved import reads as.
    container.resolve(null)
}
void aTokenIsStillAToken
