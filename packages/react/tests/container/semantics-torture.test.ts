import { describe, expect, it, vi } from "vitest"

import { Container, Scope, inject, injectOptional } from "@remodulo/container"
import type { Constructor, InjectionToken } from "@remodulo/container"
import type { Provider } from "../../src/core/provider.types.js"
import { App, Module } from "../../src/core/module.js"
import { ModuleStatus } from "../../src/core/module-lifecycle.types.js"
import { makeApp, makeChild } from "../setup/helpers.js"

// Provider semantics under pressure.
// ========================================
//
// The headline is the first block: a singleton is per-CONTAINER, never global. Everything else here works
// the same seam from a different angle — the four provider forms driven through a real `Module` rather than
// a bare `Container`, shadowing across three module levels, sibling isolation, deep constructor chains, and
// the two things that are not semantics at all but hard failure modes: circular dependencies and `lazy`.
//
// No decorators: a dependency is read with `inject()` in a field initializer, which runs before the
// constructor body — so the construction order the chain tests assert is unchanged.

// Helpers
// ========================================

type Marks = { init: number; mount: number; unmount: number; destroy: number }

type Instance = {
    readonly label: string
    readonly serial: number
    readonly marks: Marks
    /** Whatever was injected, positionally — the chain tests assert identity through it. */
    readonly deps: readonly unknown[]
}

type Instrumented = Constructor<Instance> & { readonly instances: readonly Instance[] }

const NONE: Marks = { init: 0, mount: 0, unmount: 0, destroy: 0 }
const ONCE: Marks = { init: 1, mount: 1, unmount: 1, destroy: 1 }

/**
 * A class that keeps every instance it ever builds and counts the four hooks PER INSTANCE.
 * `helpers.tracked` counts per class, which cannot tell "one instance, adopted twice" from "two instances,
 * adopted once each" — and that distinction is the entire point of the per-container singleton proof.
 *
 * Trailing `tokens` are what the class injects, positionally: read in a field initializer, so every
 * dependency is built before this instance's own constructor body runs.
 */
function instrumented(label: string, log: string[], ...tokens: InjectionToken<unknown>[]): Instrumented {
    const instances: Instance[] = []

    const Service = class {
        static readonly instances = instances

        readonly label = label
        readonly serial: number
        readonly marks: Marks = { init: 0, mount: 0, unmount: 0, destroy: 0 }
        readonly deps: readonly unknown[] = tokens.map((token) => inject(token))

        constructor() {
            this.serial = instances.length + 1
            instances.push(this as unknown as Instance)
            log.push(`${label}#${this.serial}:ctor`)
        }

        onModuleInit(): void {
            this.marks.init++
            log.push(`${label}#${this.serial}:init`)
        }

        onModuleMount(): void {
            this.marks.mount++
            log.push(`${label}#${this.serial}:mount`)
        }

        onModuleUnmount(): void {
            this.marks.unmount++
            log.push(`${label}#${this.serial}:unmount`)
        }

        onModuleDestroy(): void {
            this.marks.destroy++
            log.push(`${label}#${this.serial}:destroy`)
        }
    }

    return Service as unknown as Instrumented
}

/** Log entries for one phase, e.g. `only(log, "ctor")`. */
function only(log: readonly string[], name: string): string[] {
    return log.filter((entry) => entry.endsWith(`:${name}`))
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

    it("gives two sibling Apps an instance each for the very same class provider", () => {
        const log: string[] = []
        const Service = instrumented("S", log)

        const left = makeApp({ providers: [Service] })
        const right = makeApp({ providers: [Service] })

        const fromLeft = left.container.resolve(Service)
        const fromRight = right.container.resolve(Service)

        expect(fromRight).not.toBe(fromLeft)
        expect(fromLeft.serial).toBe(1)
        expect(fromRight.serial).toBe(2)
        expect(Service.instances).toHaveLength(2)

        // Stable within each container, and still exactly two in total after re-resolving both.
        expect(left.container.resolve(Service)).toBe(fromLeft)
        expect(right.container.resolve(Service)).toBe(fromRight)
        expect(Service.instances).toHaveLength(2)
        expect(only(log, "ctor")).toEqual(["S#1:ctor", "S#2:ctor"])
    })

    it("gives two sibling modules under one parent an instance each", () => {
        const log: string[] = []
        const Service = instrumented("S", log)

        const parent = makeApp()
        const left = makeChild(parent, { providers: [Service] })
        const right = makeChild(parent, { providers: [Service] })

        const fromLeft = left.container.resolve(Service)
        const fromRight = right.container.resolve(Service)

        expect(fromRight).not.toBe(fromLeft)
        expect(Service.instances).toHaveLength(2)
        // The parent declares nothing for it, so there is no third instance hiding above them.
        expect(parent.container.isRegistered(Service)).toBe(false)
    })

    it("shares one parent instance with every descendant that does not declare it", () => {
        const log: string[] = []
        const Service = instrumented("S", log)

        const parent = makeApp({ providers: [Service] })
        const left = makeChild(parent, { providers: [] })
        const right = makeChild(parent, { providers: [] })
        const grandchild = makeChild(left, { providers: [] })

        const fromParent = parent.container.resolve(Service)

        expect(left.container.resolve(Service)).toBe(fromParent)
        expect(right.container.resolve(Service)).toBe(fromParent)
        expect(grandchild.container.resolve(Service)).toBe(fromParent)
        expect(Service.instances).toEqual([fromParent])
        expect(only(log, "ctor")).toEqual(["S#1:ctor"])

        // Owned by the parent alone: no descendant reports the token as its own.
        expect(left.container.isRegistered(Service, "self")).toBe(false)
        expect(grandchild.container.isRegistered(Service, "self")).toBe(false)
        expect(parent.container.isRegistered(Service, "self")).toBe(true)
    })

    it("runs one lifecycle for a shared parent instance and two for two sibling declarations", async () => {
        const sharedLog: string[] = []
        const Shared = instrumented("Shared", sharedLog)
        const ownLog: string[] = []
        const Own = instrumented("Own", ownLog)

        // `Shared` is declared once at the top; `Own` is declared by each child.
        const parent = makeApp({ providers: [Shared] })
        const left = makeChild(parent, { providers: [Own] })
        const right = makeChild(parent, { providers: [Own] })

        left.mount()
        right.mount()
        parent.mount()
        parent.unmount()
        await parent.destroy()

        expect(Shared.instances).toHaveLength(1)
        expect(Shared.instances[0]?.marks).toEqual(ONCE)

        expect(Own.instances).toHaveLength(2)
        expect(Own.instances[0]).not.toBe(Own.instances[1])
        expect(Own.instances[0]?.marks).toEqual(ONCE)
        expect(Own.instances[1]?.marks).toEqual(ONCE)
    })
})

// Transient
// ========================================
//
// Fresh per resolve, and never adopted: `ModuleLifecycle` attaches no activation listener to a transient
// binding, so there is no code path that could hand one to a lifecycle owner.

describe("transient scope", () => {
    it("hands each singleton holder its own transient dependency and adopts none of them", async () => {
        const log: string[] = []
        const Transient = instrumented("T", log)
        const TRANSIENT = Symbol.for("tests.torture.transient")

        class First {
            readonly dependency = inject<Instance>(TRANSIENT)
        }
        class Second {
            readonly dependency = inject<Instance>(TRANSIENT)
        }

        const module = makeApp({
            providers: [
                { provide: TRANSIENT, useClass: Transient, scope: Scope.Transient } as Provider,
                First as Provider,
                Second as Provider,
            ],
        })

        const first = module.container.resolve(First)
        const second = module.container.resolve(Second)

        expect(first.dependency).not.toBe(second.dependency)
        expect(Transient.instances).toHaveLength(2)

        module.mount()
        module.unmount()
        await module.destroy()

        // Two live instances, held by adopted singletons, and neither ever heard a hook.
        for (const instance of Transient.instances) expect(instance.marks).toEqual(NONE)
    })

    it("stays fresh and unadopted when a descendant module resolves it", async () => {
        const log: string[] = []
        const Transient = instrumented("T", log)
        const TRANSIENT = Symbol.for("tests.torture.transient-descendant")

        const parent = makeApp({
            providers: [{ provide: TRANSIENT, useClass: Transient, scope: Scope.Transient } as Provider],
        })
        const child = makeChild(parent, { providers: [] })
        child.mount()
        parent.mount()

        const a = child.container.resolve<Instance>(TRANSIENT)
        const b = child.container.resolve<Instance>(TRANSIENT)
        const c = parent.container.resolve<Instance>(TRANSIENT)

        expect(new Set([a, b, c]).size).toBe(3)

        parent.unmount()
        await parent.destroy()

        for (const instance of Transient.instances) expect(instance.marks).toEqual(NONE)
        expect(only(log, "init")).toEqual([])
    })
})

// The four provider forms, driven through a Module
// ========================================
//
// The shapes themselves are covered at the `Container` level. What is asserted here is that a real module —
// system providers registered, eager pass run, lifecycle armed — treats all four identically: same
// resolution, same adoption, and an alias that adds nothing of its own.

describe("provider forms through a module", () => {
    const USE_CLASS = Symbol.for("tests.torture.use-class")
    const USE_VALUE = Symbol.for("tests.torture.use-value")
    const USE_FACTORY = Symbol.for("tests.torture.use-factory")
    const ALIAS = Symbol.for("tests.torture.alias")
    const ABSENT = Symbol.for("tests.torture.absent")

    it("resolves class shorthand, useClass, useValue, useFactory and useExisting from one module", () => {
        const log: string[] = []
        const Shorthand = instrumented("Shorthand", log)
        const Implementation = instrumented("Implementation", log)
        const value = { kind: "value" }
        const factory = vi.fn(() => ({
            config: inject(USE_VALUE),
            dependency: inject(USE_CLASS),
            missing: injectOptional(ABSENT),
        }))

        const module = makeApp({
            providers: [
                Shorthand,
                { provide: USE_CLASS, useClass: Implementation } as Provider,
                { provide: USE_VALUE, useValue: value },
                { provide: USE_FACTORY, useFactory: factory } as Provider,
                { provide: ALIAS, useExisting: USE_CLASS },
            ],
        })

        const shorthand = module.container.resolve(Shorthand)
        const implementation = module.container.resolve<Instance>(USE_CLASS)
        const built = module.container.resolve<{ config: unknown; dependency: unknown; missing: unknown }>(USE_FACTORY)

        expect(shorthand).toBeInstanceOf(Shorthand)
        expect(implementation).toBeInstanceOf(Implementation)
        expect(module.container.resolve(USE_VALUE)).toBe(value)

        // The body's reads run in source order; the optional miss reads undefined rather than throwing.
        expect(built.config).toBe(value)
        expect(built.dependency).toBe(implementation)
        expect(built.missing).toBeUndefined()
        expect(factory).toHaveBeenCalledTimes(1)

        // An alias is the target's instance — not a copy, and not a second construction.
        expect(module.container.resolve(ALIAS)).toBe(implementation)
        expect(Implementation.instances).toEqual([implementation])
    })

    it("adopts one participant per constructed instance, and none for the alias", async () => {
        const log: string[] = []
        const Shorthand = instrumented("Shorthand", log)
        const Implementation = instrumented("Implementation", log)
        const valueMarks: Marks = { init: 0, mount: 0, unmount: 0, destroy: 0 }
        const factoryMarks: Marks = { init: 0, mount: 0, unmount: 0, destroy: 0 }

        const hooks = (marks: Marks) => ({
            onModuleInit: () => marks.init++,
            onModuleMount: () => marks.mount++,
            onModuleUnmount: () => marks.unmount++,
            onModuleDestroy: () => marks.destroy++,
        })

        const module = makeApp({
            providers: [
                Shorthand,
                { provide: USE_CLASS, useClass: Implementation } as Provider,
                { provide: USE_VALUE, useValue: hooks(valueMarks) },
                { provide: USE_FACTORY, useFactory: () => hooks(factoryMarks) },
                { provide: ALIAS, useExisting: USE_CLASS },
            ],
        })

        module.mount()
        module.unmount()
        await module.destroy()

        expect(Shorthand.instances[0]?.marks).toEqual(ONCE)
        expect(Implementation.instances[0]?.marks).toEqual(ONCE)
        expect(valueMarks).toEqual(ONCE)
        expect(factoryMarks).toEqual(ONCE)

        // Four participants, two class constructions — the alias contributed no fifth run of anything.
        expect(only(log, "init")).toEqual(["Shorthand#1:init", "Implementation#1:init"])
        expect(Implementation.instances).toHaveLength(1)
    })
})

// Parent lookup and shadowing across three module levels
// ========================================
//
// Resolution walks up to the nearest declaration and stops. Adoption does not walk at all: an instance
// belongs to the module whose container declared its binding, whoever asked for it.

describe("shadowing across three module levels", () => {
    const TOKEN = Symbol.for("tests.torture.shadowed")
    const ROOT_CONSUMER = Symbol.for("tests.torture.consumer.root")
    const MIDDLE_CONSUMER = Symbol.for("tests.torture.consumer.middle")
    const LEAF_CONSUMER = Symbol.for("tests.torture.consumer.leaf")

    /** root declares TOKEN, middle declares nothing, leaf shadows it. Each level has a consumer of TOKEN. */
    function tree(log: string[]) {
        const RootService = instrumented("Root", log)
        const LeafService = instrumented("Leaf", log)
        // Stands in for a component at that level: a plain holder, no hooks, so it joins no lifecycle.
        const consumer = (token: symbol): Provider => ({
            provide: token,
            useFactory: () => ({ service: inject<Instance>(TOKEN) }),
        })

        const root = makeApp({
            providers: [{ provide: TOKEN, useClass: RootService } as Provider, consumer(ROOT_CONSUMER)],
        })
        const middle = makeChild(root, { providers: [consumer(MIDDLE_CONSUMER)] })
        const leaf = makeChild(middle, {
            providers: [{ provide: TOKEN, useClass: LeafService } as Provider, consumer(LEAF_CONSUMER)],
        })

        return { root, middle, leaf, RootService, LeafService }
    }

    const consumed = (module: Module, token: symbol): Instance =>
        module.container.resolve<{ service: Instance }>(token).service

    it("serves the middle module the parent's instance and the leaf its own", () => {
        const log: string[] = []
        const { root, middle, leaf, RootService, LeafService } = tree(log)

        const rootInstance = root.container.resolve<Instance>(TOKEN)
        const leafInstance = leaf.container.resolve<Instance>(TOKEN)

        expect(rootInstance).toBeInstanceOf(RootService)
        expect(leafInstance).toBeInstanceOf(LeafService)
        expect(leafInstance).not.toBe(rootInstance)

        // The middle declares nothing, so it reaches straight past itself to the root.
        expect(middle.container.resolve<Instance>(TOKEN)).toBe(rootInstance)
        expect(middle.container.isRegistered(TOKEN, "self")).toBe(false)

        // Each level's own consumer got what its own container sees.
        expect(consumed(root, ROOT_CONSUMER)).toBe(rootInstance)
        expect(consumed(middle, MIDDLE_CONSUMER)).toBe(rootInstance)
        expect(consumed(leaf, LEAF_CONSUMER)).toBe(leafInstance)

        expect(RootService.instances).toHaveLength(1)
        expect(LeafService.instances).toHaveLength(1)
    })

    it("keeps adoption with the declaring module — root's instance in root, leaf's in leaf", async () => {
        const log: string[] = []
        const { root, middle, leaf, RootService, LeafService } = tree(log)

        leaf.mount()
        middle.mount()
        root.mount()
        root.unmount()
        await root.destroy()

        expect(RootService.instances[0]?.marks).toEqual(ONCE)
        expect(LeafService.instances[0]?.marks).toEqual(ONCE)

        // Init is creation order (root before leaf); teardown reverses the tree (leaf before root).
        expect(only(log, "init")).toEqual(["Root#1:init", "Leaf#1:init"])
        expect(only(log, "mount")).toEqual(["Root#1:mount", "Leaf#1:mount"])
        expect(only(log, "unmount")).toEqual(["Leaf#1:unmount", "Root#1:unmount"])
        expect(only(log, "destroy")).toEqual(["Leaf#1:destroy", "Root#1:destroy"])
    })

    it("destroys the shadowing leaf without touching the shadowed instance the middle still uses", async () => {
        const log: string[] = []
        const { root, middle, leaf, RootService, LeafService } = tree(log)

        leaf.mount()
        middle.mount()
        root.mount()

        leaf.unmount()
        await leaf.destroy()

        expect(LeafService.instances[0]?.marks).toEqual(ONCE)
        expect(RootService.instances[0]?.marks).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 0 })
        expect(consumed(middle, MIDDLE_CONSUMER)).toBe(RootService.instances[0])

        root.unmount()
        await root.destroy()
        expect(RootService.instances[0]?.marks).toEqual(ONCE)
        expect(LeafService.instances[0]?.marks).toEqual(ONCE)
    })
})

// Sibling modules
// ========================================

describe("the same token in sibling modules", () => {
    const TOKEN = Symbol.for("tests.torture.sibling")

    it("keeps instances and lifecycles fully independent", async () => {
        const log: string[] = []
        const Service = instrumented("S", log)

        const parent = makeApp()
        const left = makeChild(parent, { providers: [{ provide: TOKEN, useClass: Service } as Provider] })
        const right = makeChild(parent, { providers: [{ provide: TOKEN, useClass: Service } as Provider] })
        left.mount()
        right.mount()
        parent.mount()

        const [first, second] = Service.instances
        expect(Service.instances).toHaveLength(2)
        expect(left.container.resolve<Instance>(TOKEN)).toBe(first)
        expect(right.container.resolve<Instance>(TOKEN)).toBe(second)

        // Neither sibling can see the other's declaration, at any depth below it.
        expect(makeChild(left, {}).container.resolve<Instance>(TOKEN)).toBe(first)
        expect(makeChild(right, {}).container.resolve<Instance>(TOKEN)).toBe(second)

        // Tearing one down leaves the other's instance untouched.
        left.unmount()
        await left.destroy()
        expect(first?.marks).toEqual(ONCE)
        expect(second?.marks).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 0 })

        parent.unmount()
        await parent.destroy()
        expect(first?.marks).toEqual(ONCE)
        expect(second?.marks).toEqual(ONCE)
    })
})

// Constructor dependency chains
// ========================================

describe("constructor dependency chains", () => {
    const A = Symbol.for("tests.torture.chain.a")
    const B = Symbol.for("tests.torture.chain.b")
    const C = Symbol.for("tests.torture.chain.c")
    const D = Symbol.for("tests.torture.chain.d")

    it("builds a four-deep chain once each and adopts it dependency-first", async () => {
        const log: string[] = []
        // A -> B -> C -> D. Deliberately DECLARED dependent-first, so declaration order and construction
        // order disagree and the assertions below are about construction, not about the provider list.
        const Alpha = instrumented("A", log, B)
        const Beta = instrumented("B", log, C)
        const Gamma = instrumented("C", log, D)
        const Delta = instrumented("D", log)

        const module = makeApp({
            providers: [
                { provide: A, useClass: Alpha } as Provider,
                { provide: B, useClass: Beta } as Provider,
                { provide: C, useClass: Gamma } as Provider,
                { provide: D, useClass: Delta } as Provider,
            ],
        })

        // Every link built exactly once, and the chain is wired to those same instances.
        for (const link of [Alpha, Beta, Gamma, Delta]) expect(link.instances).toHaveLength(1)
        expect(Alpha.instances[0]?.deps[0]).toBe(Beta.instances[0])
        expect(Beta.instances[0]?.deps[0]).toBe(Gamma.instances[0])
        expect(Gamma.instances[0]?.deps[0]).toBe(Delta.instances[0])
        expect(module.container.resolve<Instance>(A)).toBe(Alpha.instances[0])

        // Construction runs innermost-first, and adoption records that order, not the declaration order.
        expect(only(log, "ctor")).toEqual(["D#1:ctor", "C#1:ctor", "B#1:ctor", "A#1:ctor"])
        expect(only(log, "init")).toEqual(["D#1:init", "C#1:init", "B#1:init", "A#1:init"])

        module.mount()
        expect(only(log, "mount")).toEqual(["D#1:mount", "C#1:mount", "B#1:mount", "A#1:mount"])

        module.unmount()
        await module.destroy()

        // Teardown reverses it: the dependent dies before the dependency it was holding.
        expect(only(log, "unmount")).toEqual(["A#1:unmount", "B#1:unmount", "C#1:unmount", "D#1:unmount"])
        expect(only(log, "destroy")).toEqual(["A#1:destroy", "B#1:destroy", "C#1:destroy", "D#1:destroy"])
    })

    it("builds a shared leaf of a diamond once and hands both arms the same instance", () => {
        const log: string[] = []
        const Top = instrumented("Top", log, B, C)
        const Left = instrumented("L", log, D)
        const Right = instrumented("R", log, D)
        const Leaf = instrumented("Leaf", log)

        makeApp({
            providers: [
                { provide: A, useClass: Top } as Provider,
                { provide: B, useClass: Left } as Provider,
                { provide: C, useClass: Right } as Provider,
                { provide: D, useClass: Leaf } as Provider,
            ],
        })

        expect(Leaf.instances).toHaveLength(1)
        expect(Top.instances[0]?.deps).toEqual([Left.instances[0], Right.instances[0]])
        expect(Left.instances[0]?.deps[0]).toBe(Leaf.instances[0])
        expect(Right.instances[0]?.deps[0]).toBe(Leaf.instances[0])

        // The shared leaf is built and adopted once, even though two dependents pulled it in.
        expect(only(log, "ctor")).toEqual(["Leaf#1:ctor", "L#1:ctor", "R#1:ctor", "Top#1:ctor"])
        expect(only(log, "init")).toEqual(["Leaf#1:init", "L#1:init", "R#1:init", "Top#1:init"])
    })
})

// Circular dependencies
// ========================================
//
// UNSUPPORTED BY DESIGN, permanently. A constructor cycle is a structural mistake in the consuming app, not
// a case the container is expected to absorb: the kernel walks its construction chain, detects the repeat
// and throws, and no Delay-style escape hatch will be built. Throwing loudly at init IS the contract, so
// the tests below pin the exact error text and where it surfaces. For the rare legitimate cycle,
// factory-thunk indirection is the documented workaround.

describe("circular dependencies", () => {
    /** Alpha and Beta reading each other from their field initializers. */
    function cycle(): { container: Container; Alpha: Constructor; Beta: Constructor } {
        class Alpha {
            readonly beta = inject(Beta)
        }
        class Beta {
            readonly alpha = inject(Alpha)
        }

        const container = new Container()
        container.register([Alpha as Provider, Beta as Provider])
        return { container, Alpha, Beta }
    }

    it("throws the kernel's circular-dependency error, naming the whole path", () => {
        const { container, Alpha } = cycle()

        // The message walks the cycle back to the repeat that opened it, rather than just naming the pair.
        expect(() => container.resolve(Alpha)).toThrowError("Circular dependency found: Alpha -> Beta -> Alpha")

        const thrown = (() => {
            try {
                container.resolve(Alpha)
                return null
            } catch (error) {
                return error as Error
            }
        })()
        expect(thrown?.constructor.name).toBe("CycleError")
    })

    it("reports the cycle from whichever end asked for it", () => {
        const { container, Beta } = cycle()

        expect(() => container.resolve(Beta)).toThrowError("Circular dependency found: Beta -> Alpha -> Beta")
    })

    /**
     * Where it lands in a module: the eager pass lives in `ModuleLifecycle#collectInstances`, which runs
     * before any phase runner. The error escapes `Module.init()` raw and the module is left constructed but
     * un-initialized — a state nothing else in the public API produces.
     */
    it("escapes Module.init() raw and leaves the module un-initialized", () => {
        class Alpha {
            readonly beta = inject(Beta)
        }
        class Beta {
            readonly alpha = inject(Alpha)
        }

        const app = new App({ providers: [Alpha as Provider, Beta as Provider] })

        expect(() => app.init()).toThrowError("Circular dependency found: Alpha -> Beta -> Alpha")
        expect(app.status).toBeOneOf([ModuleStatus.Created, ModuleStatus.Failed])
        expect(app.status).not.toBe(ModuleStatus.Mounted)
    })

    /**
     * The TDZ case the old deferred-token wrapper existed for is gone with the decorators. A decorator
     * evaluated its token argument at class-DECLARATION time, so a class declared further down the file
     * was still in its temporal dead zone. `inject()` runs at CONSTRUCTION time, by which point every
     * declaration in the module has been evaluated — nothing to defer, and no wrapper to defer it with.
     */
    it("needs no deferral for a token whose class is declared later in the file", () => {
        class Consumer {
            readonly later = inject(Later)
        }

        class Later {
            readonly kind = "later"
        }

        const container = new Container()
        container.register([Consumer as Provider, Later as Provider])

        expect(container.resolve<{ later: unknown }>(Consumer).later).toBeInstanceOf(Later)
    })

    it("closes a cycle through factory indirection — the documented workaround", () => {
        const GET_BETA = Symbol.for("tests.torture.get-beta")

        class Alpha {
            readonly getBeta = inject<() => unknown>(GET_BETA)
        }
        class Beta {
            readonly alpha = inject(Alpha)
        }

        const module = makeApp({
            providers: [
                Alpha as Provider,
                Beta as Provider,
                // The indirection is the accessor: Alpha holds a thunk, so Beta is not on Alpha's
                // construction path and the cycle never forms. `Module` is injectable in its own
                // container, which is how the factory reaches back for the late resolve.
                {
                    provide: GET_BETA,
                    useFactory: () => {
                        const owner = inject(Module)
                        return () => owner.container.resolve(Beta)
                    },
                } as Provider,
            ],
        })

        const alpha = module.container.resolve<Alpha>(Alpha)
        const beta = module.container.resolve<Beta>(Beta)

        expect(beta.alpha).toBe(alpha)
        expect(alpha.getBeta()).toBe(beta)
    })
})

// Construction failures during the eager pass
// ========================================
//
// The circular case is one instance of the general rule, pinned here generally: a provider whose
// construction throws takes the same route out. `ModuleLifecycle#collectInstances` runs the eager pass
// before any phase runner, so the original error propagates out of `init()` unwrapped and the module is
// left constructed but un-initialized.

describe("a provider constructor that throws", () => {
    it("propagates out of Module.init() unwrapped and leaves the module un-initialized", () => {
        const THROWS = Symbol.for("tests.torture.throws")

        class Exploding {
            constructor() {
                throw new Error("boom from a constructor")
            }
        }

        const module = new App({ providers: [{ provide: THROWS, useClass: Exploding } as Provider] })

        expect(() => module.init()).toThrowError("boom from a constructor")
        expect(module.status).toBeOneOf([ModuleStatus.Created, ModuleStatus.Failed])
        expect(module.status).not.toBe(ModuleStatus.Mounted)
    })
})

// lazy
// ========================================

describe("lazy providers", () => {
    it("skips the eager pass, builds once on first resolve, and is a singleton chain-wide thereafter", () => {
        const log: string[] = []
        const Service = instrumented("L", log)
        const TOKEN = Symbol.for("tests.torture.lazy")

        const owner = makeApp({ providers: [{ provide: TOKEN, useClass: Service, lazy: true } as Provider] })
        const child = makeChild(owner, { providers: [] })
        const grandchild = makeChild(child, { providers: [] })
        owner.mount()
        child.mount()
        grandchild.mount()

        // Registered but not built: `isRegistered` reports on the binding, not on an instance.
        expect(owner.container.isRegistered(TOKEN, "self")).toBe(true)
        expect(Service.instances).toHaveLength(0)
        expect(log).toEqual([])

        const first = grandchild.container.resolve<Instance>(TOKEN)
        expect(Service.instances).toEqual([first])

        // Every later resolve, at every level of the chain, is that same instance — one construction total.
        expect(child.container.resolve<Instance>(TOKEN)).toBe(first)
        expect(owner.container.resolve<Instance>(TOKEN)).toBe(first)
        expect(grandchild.container.resolve<Instance>(TOKEN)).toBe(first)
        expect(Service.instances).toHaveLength(1)
        expect(only(log, "ctor")).toEqual(["L#1:ctor"])
    })
})
