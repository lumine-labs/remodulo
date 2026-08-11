import { describe, expect, it } from "vitest"

import { Container } from "../../src/container.js"
import { Scope } from "../../src/container.types.js"
import type { Constructor, InjectionToken } from "../../src/container.types.js"
import type { CycleError } from "../../src/container.errors.js"
import { inject } from "../../src/injector.js"

// Provider semantics under pressure.
// ========================================
//
// The headline is the first block: a singleton is per-CONTAINER, never global. After it, the two things a
// container has to get right about construction — deep dependency chains and the diamond that shares a leaf
// — and the two hard failure modes: a circular dependency, and a constructor that throws.
//
// No decorators: every dependency below is a bare `inject()` evaluated at construction time.

// Helpers
// ========================================

type Instance = {
    readonly label: string
    readonly serial: number
    /** Whatever was injected, positionally — the chain tests assert identity through it. */
    readonly deps: readonly unknown[]
}

type Instrumented = Constructor<Instance> & { readonly instances: readonly Instance[] }

/**
 * A class that keeps every instance it ever builds and records its own construction in `log`. `dependencies`
 * are injected in the constructor BODY, so the entry lands in `log` only once everything below it is built —
 * which is what makes the log a construction ORDER, innermost first.
 */
function instrumented(label: string, log: string[], dependencies: InjectionToken[] = []): Instrumented {
    const instances: Instance[] = []

    const Service = class {
        static readonly instances = instances

        readonly label = label
        readonly serial: number
        readonly deps: readonly unknown[]

        constructor() {
            this.deps = dependencies.map((token) => inject(token))
            this.serial = instances.length + 1
            instances.push(this as unknown as Instance)
            log.push(`${label}#${this.serial}:ctor`)
        }
    }

    return Service as unknown as Instrumented
}

// Singleton is per-container, never global
// ========================================
//
// "Singleton" in this library means one instance per container that DECLARES the provider — it is a
// property of the binding's owner, not of the class. The same class registered twice is two singletons;
// registered once and reached from ten descendants is one. Nothing is memoized on the class itself.

describe("singleton scope is per-container", () => {
    it("gives two sibling forks of one container an instance each for the same class", () => {
        const log: string[] = []
        const Service = instrumented("S", log)

        const root = new Container()
        const left = root.fork()
        const right = root.fork()
        left.register(Service)
        right.register(Service)

        const fromLeft = left.resolve(Service)
        const fromRight = right.resolve(Service)

        expect(fromLeft).toBeInstanceOf(Service)
        expect(fromRight).toBeInstanceOf(Service)
        expect(fromRight).not.toBe(fromLeft)
        expect(Service.instances).toEqual([fromLeft, fromRight])
        // The root declared nothing, so it owns neither of them.
        expect(root.isRegistered(Service)).toBe(false)
    })
})

// Constructor dependency chains
// ========================================

describe("constructor dependency chains", () => {
    const A = Symbol.for("tests.semantics.chain.a")
    const B = Symbol.for("tests.semantics.chain.b")
    const C = Symbol.for("tests.semantics.chain.c")
    const D = Symbol.for("tests.semantics.chain.d")

    it("builds a four-deep chain once each, innermost first", () => {
        const log: string[] = []
        // A -> B -> C -> D. Deliberately DECLARED dependent-first, so declaration order and construction
        // order disagree and the assertions below are about construction, not about the provider list.
        const Alpha = instrumented("A", log, [B])
        const Beta = instrumented("B", log, [C])
        const Gamma = instrumented("C", log, [D])
        const Delta = instrumented("D", log)

        const container = new Container()
        container.register([
            { provide: A, useClass: Alpha },
            { provide: B, useClass: Beta },
            { provide: C, useClass: Gamma },
            { provide: D, useClass: Delta },
        ])

        const alpha = container.resolve<Instance>(A)

        // Every link built exactly once, and the chain is wired to those same instances.
        for (const link of [Alpha, Beta, Gamma, Delta]) expect(link.instances).toHaveLength(1)
        expect(alpha).toBe(Alpha.instances[0])
        expect(Alpha.instances[0]?.deps[0]).toBe(Beta.instances[0])
        expect(Beta.instances[0]?.deps[0]).toBe(Gamma.instances[0])
        expect(Gamma.instances[0]?.deps[0]).toBe(Delta.instances[0])

        // Construction runs innermost-first, whatever order the providers were declared in.
        expect(log).toEqual(["D#1:ctor", "C#1:ctor", "B#1:ctor", "A#1:ctor"])
    })

    it("builds a shared leaf of a diamond once and hands both arms the same instance", () => {
        const log: string[] = []
        const Top = instrumented("Top", log, [B, C])
        const Left = instrumented("L", log, [D])
        const Right = instrumented("R", log, [D])
        const Leaf = instrumented("Leaf", log)

        const container = new Container()
        container.register([
            { provide: A, useClass: Top },
            { provide: B, useClass: Left },
            { provide: C, useClass: Right },
            { provide: D, useClass: Leaf },
        ])

        container.resolve<Instance>(A)

        expect(Leaf.instances).toHaveLength(1)
        expect(Top.instances[0]?.deps).toEqual([Left.instances[0], Right.instances[0]])
        expect(Left.instances[0]?.deps[0]).toBe(Leaf.instances[0])
        expect(Right.instances[0]?.deps[0]).toBe(Leaf.instances[0])

        // The shared leaf is built once, even though two dependents pulled it in.
        expect(log).toEqual(["Leaf#1:ctor", "L#1:ctor", "R#1:ctor", "Top#1:ctor"])
    })
})

// Circular dependencies
// ========================================
//
// UNSUPPORTED BY DESIGN, permanently. A constructor cycle is a structural mistake in the consuming app, not
// a case the container is expected to absorb, and no Delay-style escape hatch will be built. Throwing
// loudly IS the contract, so the tests below pin the exact text from either end. What changed with the move
// off inversify is only the provenance: `#assertAcyclic` walks the frame's own chain and throws a plain
// `Error` from this package's error catalog, so there is no vendor error class to match on any more.
//
// `LazyToken` is gone with the decorators. It wrapped inversify's `LazyServiceIdentifier` to defer
// evaluation of an IDENTIFIER named in a decorator, which ran at class-definition time; `inject()` sits in
// a field initializer that runs at CONSTRUCTION time, so the TDZ problem it existed for cannot occur —
// pinned by the last test in this block.

describe("circular dependencies", () => {
    /** Alpha <-> Beta, each reaching for the other from a field initializer. */
    function cycle(): { container: Container; Alpha: Constructor; Beta: Constructor } {
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

    it("throws the circular-dependency error, naming the whole path", () => {
        const { container, Alpha } = cycle()

        // The message walks the cycle back to its start rather than just naming the pair.
        expect(() => container.resolve(Alpha)).toThrowError("Circular dependency found: Alpha -> Beta -> Alpha")

        const thrown = (() => {
            try {
                container.resolve(Alpha)
                return null
            } catch (error) {
                return error as Error
            }
        })()
        // Ours, not a vendor's — and named now rather than anonymous: `CycleError` carries a message from
        // `container.errors.ts`. The full hierarchy is pinned in `tests/container/errors.test.ts`.
        expect(thrown).toBeInstanceOf(Error)
        expect(thrown?.constructor.name).toBe("CycleError")
    })

    it("reports the cycle from whichever end asked for it", () => {
        const { container, Beta } = cycle()

        expect(() => container.resolve(Beta)).toThrowError("Circular dependency found: Beta -> Alpha -> Beta")
    })

    it("needs no lazy wrapper for a token whose class is declared later", () => {
        class Consumer {
            // Under decorators this was the TDZ case: `@Inject(Later)` evaluated `Later` while the class
            // was still in its temporal dead zone. A field initializer runs at construction, long after.
            readonly later = inject(Later)
        }

        class Later {
            readonly kind = "later"
        }

        const container = new Container()
        container.register([Consumer, Later])

        expect(container.resolve(Consumer).later).toBeInstanceOf(Later)
    })
})

// Aliases join the SAME cycle chain
// ========================================
//
// There is one cycle mechanism, not two. An alias is a read like any other, so the token it was asked
// through rides the resolution's chain for the duration of that read, and `#assertAcyclic` — the check a
// constructor ring already goes through — is what catches a ring of aliases too. The chain is per ACTIVE
// PATH, built by nesting, so it unwinds as the read unwinds and a token reached twice by two different
// paths is not a cycle.
//
// The capability this buys is the mixed case at the bottom: a ring made of constructor edges AND alias
// edges is one ring, on one chain, with the alias link visible in the message. Two separate mechanisms
// could never have reported that, because neither would have seen the whole of it.

describe("cycles through aliases", () => {
    it("catches an alias pointing at itself", () => {
        const SELF = Symbol("SELF")

        const container = new Container()
        container.register({ provide: SELF, useExisting: SELF })

        expect(() => container.resolve(SELF)).toThrowError("Circular dependency found: SELF -> SELF")
    })

    it("catches a ring of two, and reports it from whichever end asked", () => {
        const A = Symbol("A")
        const B = Symbol("B")

        const container = new Container()
        container.register([
            { provide: A, useExisting: B },
            { provide: B, useExisting: A },
        ])

        // The token asked for is the token the chain opens and closes on — the same convention the
        // constructor ring above follows.
        expect(() => container.resolve(A)).toThrowError("Circular dependency found: A -> B -> A")
        expect(() => container.resolve(B)).toThrowError("Circular dependency found: B -> A -> B")
    })

    it("catches a longer ring, naming every hop in traversal order", () => {
        const A = Symbol("A")
        const B = Symbol("B")
        const C = Symbol("C")

        const container = new Container()
        container.register([
            { provide: A, useExisting: B },
            { provide: B, useExisting: C },
            { provide: C, useExisting: A },
        ])

        expect(() => container.resolve(A)).toThrowError("Circular dependency found: A -> B -> C -> A")
    })

    it("throws the same CycleError a constructor ring throws", () => {
        const A = Symbol("A")
        const B = Symbol("B")

        const container = new Container()
        container.register([
            { provide: A, useExisting: B },
            { provide: B, useExisting: A },
        ])

        const thrown = (() => {
            try {
                container.resolve(A)
                return null
            } catch (error) {
                return error as CycleError
            }
        })()

        // One mechanism means one error type and one `chain` field, whatever kind of edge closed the ring.
        expect(thrown?.constructor.name).toBe("CycleError")
        expect(thrown?.chain).toEqual([A, B, A])
    })

    it("catches a ring made of BOTH constructor and alias edges, in one chain", () => {
        // THE point of the unification. `Alpha` injects a token that is an ALIAS, whose target injects
        // `Alpha` back. The ring crosses both planes, and neither a construction-only check nor an
        // alias-only check could see all of it — the chain below names the alias link in its own right.
        const BRIDGE = Symbol("BRIDGE")

        class Alpha {
            readonly bridge = inject(BRIDGE)
        }
        class Gamma {
            readonly alpha = inject(Alpha)
        }

        const container = new Container()
        container.register([Alpha, Gamma, { provide: BRIDGE, useExisting: Gamma }])

        expect(() => container.resolve(Alpha)).toThrowError(
            "Circular dependency found: Alpha -> BRIDGE -> Gamma -> Alpha"
        )
    })

    it("leaves a non-cyclic alias read alone, and unwinds after it", () => {
        const ALIAS = Symbol("ALIAS")
        class Service {
            readonly kind = "service"
        }

        const container = new Container()
        container.register([Service, { provide: ALIAS, useExisting: Service }])

        // Repeatable, which is the unwinding: a chain that leaked would refuse the second read.
        expect(container.resolve<Service>(ALIAS).kind).toBe("service")
        expect(container.resolve<Service>(ALIAS)).toBe(container.resolve(Service))
        expect(container.resolve<Service>(ALIAS).kind).toBe("service")
    })

    it("leaves a diamond alone: one target reached twice by two different paths", () => {
        // The chain is per ACTIVE PATH, not a history of everything the resolution has touched. `Left` and
        // `Right` both reach `Shared` through their own aliases, and neither is a cycle — the first path
        // has unwound before the second is walked. Transient on purpose: a cached singleton would
        // short-circuit before the check and pin nothing.
        const VIA_LEFT = Symbol("VIA_LEFT")
        const VIA_RIGHT = Symbol("VIA_RIGHT")
        const SHARED = Symbol("SHARED")

        class Shared {}
        class Diamond {
            readonly left = inject(VIA_LEFT)
            readonly right = inject(VIA_RIGHT)
        }

        const container = new Container()
        container.register([
            Diamond,
            { provide: SHARED, useClass: Shared, scope: Scope.Transient },
            { provide: VIA_LEFT, useExisting: SHARED },
            { provide: VIA_RIGHT, useExisting: SHARED },
        ])

        const diamond = container.resolve(Diamond)

        expect(diamond.left).toBeInstanceOf(Shared)
        expect(diamond.right).toBeInstanceOf(Shared)
        expect(diamond.left).not.toBe(diamond.right)
    })
})

// Construction failures
// ========================================
//
// The circular case is one instance of the general rule, pinned here generally: a provider whose
// construction throws sends the original error straight out of `resolve`, unwrapped — and leaves nothing
// behind, because the frame is installed and removed in a `try/finally`.

describe("a provider constructor that throws", () => {
    const THROWS = Symbol.for("tests.semantics.throws")

    class Exploding {
        constructor() {
            throw new Error("boom from a constructor")
        }
    }

    it("propagates the original error out of resolve unwrapped", () => {
        const container = new Container()
        container.register({ provide: THROWS, useClass: Exploding })

        expect(() => container.resolve(THROWS)).toThrowError("boom from a constructor")
    })

    it("restores the frame afterwards, so the next read starts from a clean one", () => {
        class Dependency {
            readonly kind = "dependency"
        }
        class Consumer {
            readonly dependency = inject(Dependency)
        }

        const container = new Container()
        container.register([{ provide: THROWS, useClass: Exploding }, Dependency, Consumer])

        expect(() => container.resolve(THROWS)).toThrowError("boom from a constructor")

        // A leaked frame would still carry THROWS in its chain, so this second read would report a
        // circular dependency instead of the constructor's own error.
        expect(() => container.resolve(THROWS)).toThrowError("boom from a constructor")

        // And an unrelated graph still builds and injects normally.
        const consumer = container.resolve(Consumer)
        expect(consumer.dependency).toBeInstanceOf(Dependency)
        expect(consumer.dependency).toBe(container.resolve(Dependency))
    })
})
