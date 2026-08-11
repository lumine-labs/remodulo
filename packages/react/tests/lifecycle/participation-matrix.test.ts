import { describe, expect, it } from "vitest"

import { Resolver, Scope, inject } from "@remodulo/container"
import type { Constructor } from "@remodulo/container"
import type { Provider } from "../../src/core/provider.types.js"
import { makeApp, makeChild } from "../setup/helpers.js"
import { App, type Module } from "../../src/core/module.js"
import { ModuleStatus } from "../../src/core/module-lifecycle.types.js"

// THE PARTICIPATION MATRIX — which providers take part in the module lifecycle.
// ========================================
//
// THE RULE: every provider form participates EXCEPT `useExisting`, transients and request-scoped
// providers. Whether a provider is lazy or eager, single or multi, changes only WHEN its instance is
// adopted — never WHETHER.
//
// This file is the canonical statement of that rule: one cell per shape, every cell asserting all four
// phase counts, deliberately redundant with the focused tests in participation.test.ts, lazy.test.ts and
// multi.test.ts. Those pin their own contexts; this one is meant to be read start to finish as the
// contract. The design rationale lives in agent-notes/design/v0.5-app-module-classes.md, decision 14.
//
// Counts are asserted PER INSTANCE, not per class: a collection has several members behind one token, and
// a per-class counter cannot tell "one instance adopted twice" from "two instances adopted once each".

// Helpers
// ========================================

type Marks = { init: number; mount: number; unmount: number; destroy: number }

type Participant = {
    readonly label: string
    readonly serial: number
    readonly marks: Marks
}

/** Every instance ever built, adopted or not. */
type Instrumented = Constructor<Participant> & { readonly instances: readonly Participant[] }

const NONE: Marks = { init: 0, mount: 0, unmount: 0, destroy: 0 }
/** Adopted before the module mounted: the full four phases. */
const EAGER: Marks = { init: 1, mount: 1, unmount: 1, destroy: 1 }
/**
 * Adopted after the module mounted: the arrival is CAUGHT UP through init and then mount, so it ends up
 * exactly where an eager sibling is. Lazy changes WHEN a provider joins the lifecycle, never which phases
 * it gets — which is why this is the same set of marks as EAGER, kept under its own name so a cell still
 * says which timing it is exercising.
 */
const LATE: Marks = { init: 1, mount: 1, unmount: 1, destroy: 1 }

/** A class provider's implementation, counting hooks per instance. */
function instrumented(label: string, log: string[]): Instrumented {
    const instances: Participant[] = []

    const Service = class {
        static readonly instances = instances

        readonly label = label
        readonly serial: number
        readonly marks: Marks = { init: 0, mount: 0, unmount: 0, destroy: 0 }

        constructor() {
            this.serial = instances.length + 1
            instances.push(this as unknown as Participant)
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

/**
 * The same four hooks on a plain object — the shape a `useValue` carries and a `useFactory` returns.
 * Adoption is duck-typed, so nothing about these is class-specific.
 */
function participant(label: string, log: string[], serial: number): Participant {
    const marks: Marks = { init: 0, mount: 0, unmount: 0, destroy: 0 }

    return {
        label,
        serial,
        marks,
        onModuleInit: () => {
            marks.init++
            log.push(`${label}#${serial}:init`)
        },
        onModuleMount: () => {
            marks.mount++
            log.push(`${label}#${serial}:mount`)
        },
        onModuleUnmount: () => {
            marks.unmount++
            log.push(`${label}#${serial}:unmount`)
        },
        onModuleDestroy: () => {
            marks.destroy++
            log.push(`${label}#${serial}:destroy`)
        },
    } as Participant
}

/** A factory whose every result is a fresh participant, kept so each can be asserted separately. */
function factoryOf(label: string, log: string[]): { make: () => Participant; built: Participant[] } {
    const built: Participant[] = []

    return {
        built,
        make: () => {
            const made = participant(label, log, built.length + 1)
            built.push(made)
            return made
        },
    }
}

/** mount → unmount → destroy, the whole remaining lifecycle in one line. */
async function drive(module: Module): Promise<void> {
    module.mount()
    module.unmount()
    await module.destroy()
}

const TOKEN = Symbol("MATRIX")
const OTHER = Symbol("MATRIX_OTHER")

// ADOPTED
// ========================================

describe("adopted — class forms", () => {
    it("1. bare class shorthand", async () => {
        const log: string[] = []
        const Service = instrumented("S", log)

        const module = makeApp({ providers: [Service as unknown as Provider] })
        await drive(module)

        expect(Service.instances).toHaveLength(1)
        expect(Service.instances[0]?.marks).toEqual(EAGER)
    })

    it("2. { useClass } — the provide-less shorthand", async () => {
        const log: string[] = []
        const Service = instrumented("S", log)

        const module = makeApp({ providers: [{ useClass: Service } as Provider] })
        await drive(module)

        expect(Service.instances[0]?.marks).toEqual(EAGER)
    })

    it("3. { provide, useClass } — single, eager", async () => {
        const log: string[] = []
        const Service = instrumented("S", log)

        const module = makeApp({ providers: [{ provide: TOKEN, useClass: Service } as Provider] })
        await drive(module)

        expect(Service.instances[0]?.marks).toEqual(EAGER)
    })

    it("4. { provide, useClass, lazy } — single, resolved after mount, caught up in full", async () => {
        const log: string[] = []
        const Service = instrumented("S", log)

        const module = makeApp({ providers: [{ provide: TOKEN, useClass: Service, lazy: true } as Provider] })
        module.mount()
        expect(Service.instances).toHaveLength(0)

        module.container.resolve(TOKEN)
        module.unmount()
        await module.destroy()

        expect(Service.instances[0]?.marks).toEqual(LATE)
    })

    it("5. { provide, useClass, multi } — two members, both adopted, in collection order", async () => {
        const log: string[] = []
        const First = instrumented("A", log)
        const Second = instrumented("B", log)

        const module = makeApp({
            providers: [
                { provide: TOKEN, useClass: First, multi: true } as Provider,
                { provide: TOKEN, useClass: Second, multi: true } as Provider,
            ],
        })

        expect(module.container.resolveAll(TOKEN)).toEqual([First.instances[0], Second.instances[0]])
        await drive(module)

        expect(First.instances[0]?.marks).toEqual(EAGER)
        expect(Second.instances[0]?.marks).toEqual(EAGER)
        expect(log.filter((entry) => entry.endsWith(":init"))).toEqual(["A#1:init", "B#1:init"])
    })

    it("6. { provide, useClass, multi, lazy } — two members, both adopted late on first resolveAll", async () => {
        const log: string[] = []
        const First = instrumented("A", log)
        const Second = instrumented("B", log)

        const module = makeApp({
            providers: [
                { provide: TOKEN, useClass: First, multi: true, lazy: true } as Provider,
                { provide: TOKEN, useClass: Second, multi: true, lazy: true } as Provider,
            ],
        })
        module.mount()
        expect(log).toEqual([])

        module.container.resolveAll(TOKEN)
        module.unmount()
        await module.destroy()

        expect(First.instances[0]?.marks).toEqual(LATE)
        expect(Second.instances[0]?.marks).toEqual(LATE)
    })
})

describe("adopted — factory forms", () => {
    it("7. { provide, useFactory } — single, eager; the RESULT is the participant", async () => {
        const log: string[] = []
        const factory = factoryOf("F", log)

        const module = makeApp({ providers: [{ provide: TOKEN, useFactory: factory.make } as Provider] })
        await drive(module)

        expect(factory.built).toHaveLength(1)
        expect(factory.built[0]?.marks).toEqual(EAGER)
    })

    it("8. { provide, useFactory, lazy } — single, resolved after mount", async () => {
        const log: string[] = []
        const factory = factoryOf("F", log)

        const module = makeApp({
            providers: [{ provide: TOKEN, useFactory: factory.make, lazy: true } as Provider],
        })
        module.mount()
        expect(factory.built).toHaveLength(0)

        module.container.resolve(TOKEN)
        module.unmount()
        await module.destroy()

        expect(factory.built[0]?.marks).toEqual(LATE)
    })

    it("9. { provide, useFactory, multi } — eager", async () => {
        const log: string[] = []
        const first = factoryOf("F", log)
        const second = factoryOf("G", log)

        const module = makeApp({
            providers: [
                { provide: TOKEN, useFactory: first.make, multi: true } as Provider,
                { provide: TOKEN, useFactory: second.make, multi: true } as Provider,
            ],
        })
        await drive(module)

        expect(first.built[0]?.marks).toEqual(EAGER)
        expect(second.built[0]?.marks).toEqual(EAGER)
    })

    it("10. { provide, useFactory, multi, lazy }", async () => {
        const log: string[] = []
        const first = factoryOf("F", log)
        const second = factoryOf("G", log)

        const module = makeApp({
            providers: [
                { provide: TOKEN, useFactory: first.make, multi: true, lazy: true } as Provider,
                { provide: TOKEN, useFactory: second.make, multi: true, lazy: true } as Provider,
            ],
        })
        module.mount()
        expect(first.built).toHaveLength(0)

        module.container.resolveAll(TOKEN)
        module.unmount()
        await module.destroy()

        expect(first.built[0]?.marks).toEqual(LATE)
        expect(second.built[0]?.marks).toEqual(LATE)
    })
})

describe("adopted — value forms", () => {
    it("11. { provide, useValue } — hooks on the value object", async () => {
        const log: string[] = []
        const value = participant("V", log, 1)

        const module = makeApp({ providers: [{ provide: TOKEN, useValue: value }] })
        await drive(module)

        expect(value.marks).toEqual(EAGER)
    })

    it("12a. { provide, useValue, multi } in an EAGER collection — adopted during the eager pass", async () => {
        const log: string[] = []
        const value = participant("V", log, 1)
        const Service = instrumented("S", log)

        const module = makeApp({
            providers: [
                { provide: TOKEN, useClass: Service, multi: true } as Provider,
                { provide: TOKEN, useValue: value, multi: true },
            ],
        })

        // The eager pass reads the whole collection, so the constant's activation fires at init.
        expect(value.marks.init).toBe(1)
        await drive(module)

        expect(value.marks).toEqual(EAGER)
        expect(Service.instances[0]?.marks).toEqual(EAGER)
    })

    it("12b. { provide, useValue, multi } beside a lazy member — REFUSED at registration", () => {
        const log: string[] = []
        const value = participant("V", log, 1)
        const Service = instrumented("S", log)

        // The eager verdict is taken per ENTRY, so an eager value member drags the whole token into the
        // eager pass and the lazy class beside it is built at init after all — the lazy declaration would
        // be silently overruled. The registration ledger now counts value members, so the disagreement is
        // refused where every other one is: at the door.
        expect(() =>
            makeApp({
                providers: [
                    { provide: TOKEN, useClass: Service, multi: true, lazy: true } as Provider,
                    { provide: TOKEN, useValue: value, multi: true },
                ],
            })
        ).toThrow("declares `lazy: false` while the collection already registered for that token is `lazy: true`.")

        expect(value.marks).toEqual(NONE)
        expect(Service.instances).toHaveLength(0)
    })

    it("12c. { provide, useValue, multi, lazy } in an ALL-LAZY collection — adopted on first resolveAll", async () => {
        const log: string[] = []
        const value = participant("V", log, 1)
        const Service = instrumented("S", log)

        const module = makeApp({
            providers: [
                { provide: TOKEN, useClass: Service, multi: true, lazy: true } as Provider,
                { provide: TOKEN, useValue: value, multi: true, lazy: true },
            ],
        })

        // Agreement restored, and the whole collection now honours it: nothing is materialized at init, so
        // the constant is not adopted either. `lazy` on a value defers the ADOPTION, not a construction.
        expect(value.marks).toEqual(NONE)
        expect(Service.instances).toHaveLength(0)

        module.mount()
        expect(value.marks).toEqual(NONE)

        expect(module.container.resolveAll(TOKEN)).toEqual([Service.instances[0], value])

        module.unmount()
        await module.destroy()

        expect(value.marks).toEqual(LATE)
        expect(Service.instances[0]?.marks).toEqual(LATE)
    })

    it("13. MIXED collection — class + factory + value under one token, all three adopted in order", async () => {
        const log: string[] = []
        const Service = instrumented("C", log)
        const factory = factoryOf("F", log)
        const value = participant("V", log, 1)

        const module = makeApp({
            providers: [
                { provide: TOKEN, useClass: Service, multi: true } as Provider,
                { provide: TOKEN, useFactory: factory.make, multi: true } as Provider,
                { provide: TOKEN, useValue: value, multi: true },
            ],
        })

        expect(module.container.resolveAll(TOKEN)).toEqual([Service.instances[0], factory.built[0], value])
        await drive(module)

        expect(Service.instances[0]?.marks).toEqual(EAGER)
        expect(factory.built[0]?.marks).toEqual(EAGER)
        expect(value.marks).toEqual(EAGER)

        expect(log.filter((entry) => entry.endsWith(":init"))).toEqual(["C#1:init", "F#1:init", "V#1:init"])
        // Destroy reverses the collection, whatever form each member took.
        expect(log.filter((entry) => entry.endsWith(":destroy"))).toEqual([
            "V#1:destroy",
            "F#1:destroy",
            "C#1:destroy",
        ])
    })

    it("14. a lazy member resolved BEFORE mount gets mount too — the other half of WHEN", async () => {
        const log: string[] = []
        const Lazy = instrumented("L", log)

        // An eager provider reaches for the lazy collection from its own onModuleInit, so the members
        // arrive mid-init — before the module has mounted, and the mount cascade still has them.
        const Puller = class {
            readonly resolver = inject(Resolver)

            onModuleInit(): void {
                this.resolver.resolveAll(TOKEN)
            }
        }

        const module = makeApp({
            providers: [
                Puller as unknown as Provider,
                { provide: TOKEN, useClass: Lazy, multi: true, lazy: true } as Provider,
            ],
        })

        expect(Lazy.instances).toHaveLength(1)
        await drive(module)

        // Not LATE: it was adopted while the module was still initializing, so it is an ordinary member.
        expect(Lazy.instances[0]?.marks).toEqual(EAGER)
    })
})


// Aliases and the eager pass
// ========================================
//
// THE MODEL: `lazy` on ANY entry controls whether the owning module ASKS for it at init. A binding asks by
// constructing; an alias asks by resolving through. So an alias is in the eager pass unless it says
// otherwise — and because materialization is reported to the entry's OWNER (D53's chain rule), the ask can
// land in one module and the adoption in another.
//
// The rows above stay green through this because their targets are eager bindings in the same module: the
// alias's ask arrives at something the pass was going to build anyway. The cells here are the three shapes
// where the ask is the only thing that builds it.

describe("aliases and the eager pass", () => {
    it("29. an eager alias in a CHILD materializes its target in the PARENT, which adopts it", async () => {
        const log: string[] = []
        const Service = instrumented("T", log)

        const parent = makeApp({
            providers: [{ provide: OTHER, useClass: Service, lazy: true } as Provider],
        })
        parent.mount()

        // Nothing yet: the parent's own entry is lazy, so its eager pass skipped it.
        expect(Service.instances).toHaveLength(0)

        // The child's eager pass resolves through its alias. The ask happens here; the materialization —
        // and therefore the adoption — happens at the module that OWNS the target.
        const child = makeChild(parent, { providers: [{ provide: TOKEN, useExisting: OTHER } as Provider] })
        child.mount()

        expect(Service.instances).toHaveLength(1)
        expect(log).toEqual(["T#1:ctor", "T#1:init", "T#1:mount"])

        // Torn down on the PARENT's schedule, not the child's — the child never owned it.
        child.unmount()
        await child.destroy()
        expect(Service.instances[0]?.marks).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 0 })

        parent.unmount()
        await parent.destroy()
        expect(Service.instances[0]?.marks).toEqual(EAGER)
    })

    it("30. a LAZY alias asks for nothing at init, and its target catches up at the owner on first read", async () => {
        const log: string[] = []
        const Service = instrumented("T", log)

        const module = makeApp({
            providers: [
                { provide: OTHER, useClass: Service, lazy: true } as Provider,
                { provide: TOKEN, useExisting: OTHER, lazy: true } as Provider,
            ],
        })
        module.mount()

        // Both halves lazy, so init asks for nothing at all.
        expect(log).toEqual([])
        expect(Service.instances).toHaveLength(0)

        // First real resolution through the alias builds the target and adopts it at its owner, which
        // catches it up through init and mount because the module is already mounted.
        expect(module.container.resolve(TOKEN)).toBeDefined()
        expect(Service.instances).toHaveLength(1)
        expect(log).toEqual(["T#1:ctor", "T#1:init", "T#1:mount"])

        // Already mounted above, so the teardown runs by hand rather than through `drive`.
        module.unmount()
        await module.destroy()
        expect(Service.instances[0]?.marks).toEqual(EAGER)
    })

    it("31. a PLAIN alias drags a lazy target into the eager pass — the deliberate flip", async () => {
        const log: string[] = []
        const Service = instrumented("T", log)

        const module = makeApp({
            providers: [
                { provide: OTHER, useClass: Service, lazy: true } as Provider,
                { provide: TOKEN, useExisting: OTHER } as Provider,
            ],
        })

        // THE BEHAVIOUR CHANGE, pinned deliberately. The target says `lazy` and the alias does not, so the
        // alias's ask overrules it: an eager entry pointing at a lazy one is a contradiction, and the ask
        // wins because asking is what the eager pass IS. Aliases used to be skipped entirely, which made
        // this combination silently lazy.
        //
        // REMEDY, if the laziness was the point: mark BOTH lazy. Cell 30 is that spelling.
        expect(Service.instances).toHaveLength(1)
        expect(log).toEqual(["T#1:ctor", "T#1:init"])

        await drive(module)
        expect(Service.instances[0]?.marks).toEqual(EAGER)
    })
})

// NEVER ADOPTED
// ========================================

describe("never adopted — aliases", () => {
    it("15. { provide, useExisting } — the alias adds no participant; the target is adopted once", async () => {
        const log: string[] = []
        const Service = instrumented("T", log)

        const module = makeApp({
            providers: [
                { provide: OTHER, useClass: Service } as Provider,
                { provide: TOKEN, useExisting: OTHER } as Provider,
            ],
        })

        expect(module.container.resolve(TOKEN)).toBe(Service.instances[0])
        await drive(module)

        // ONE instance, adopted ONCE — reaching it through a second token does not adopt it twice.
        expect(Service.instances).toHaveLength(1)
        expect(Service.instances[0]?.marks).toEqual(EAGER)
        expect(log.filter((entry) => entry.endsWith(":init"))).toEqual(["T#1:init"])
    })

    it("16a. { provide, useExisting, multi } — contributes the instance, adopts nothing extra", async () => {
        const log: string[] = []
        const Target = instrumented("T", log)
        const Member = instrumented("M", log)

        const module = makeApp({
            providers: [
                { provide: OTHER, useClass: Target } as Provider,
                { provide: TOKEN, useClass: Member, multi: true } as Provider,
                { provide: TOKEN, useExisting: OTHER, multi: true } as Provider,
            ],
        })

        expect(module.container.resolveAll(TOKEN)).toEqual([Member.instances[0], Target.instances[0]])
        await drive(module)

        expect(Target.instances[0]?.marks).toEqual(EAGER)
        expect(Member.instances[0]?.marks).toEqual(EAGER)
        expect(log.filter((entry) => entry.endsWith(":init"))).toEqual(["T#1:init", "M#1:init"])
    })

    it("16b. alias member in a CHILD, target in the parent — the parent adopts, the child does not", async () => {
        const log: string[] = []
        const Target = instrumented("T", log)
        const Member = instrumented("M", log)

        const parent = makeApp({ providers: [{ provide: OTHER, useClass: Target } as Provider] })
        const child = makeChild(parent, {
            providers: [
                { provide: TOKEN, useClass: Member, multi: true } as Provider,
                { provide: TOKEN, useExisting: OTHER, multi: true } as Provider,
            ],
        })

        expect(child.container.resolveAll(TOKEN)).toEqual([Member.instances[0], Target.instances[0]])

        child.mount()
        parent.mount()
        parent.unmount()
        await child.destroy()

        // Destroying the child took its own member and left the parent's instance untouched.
        expect(Member.instances[0]?.marks).toEqual(EAGER)
        expect(Target.instances[0]?.marks).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 0 })

        await parent.destroy()
        expect(Target.instances[0]?.marks).toEqual(EAGER)
    })
})

describe("never adopted — transients", () => {
    it("17. transient class, single", async () => {
        const log: string[] = []
        const Service = instrumented("T", log)

        const module = makeApp({
            providers: [{ provide: TOKEN, useClass: Service, scope: Scope.Transient } as Provider],
        })

        // Not built by the eager pass either — nothing would keep it.
        expect(Service.instances).toHaveLength(0)

        module.mount()
        module.container.resolve(TOKEN)
        module.container.resolve(TOKEN)
        module.unmount()
        await module.destroy()

        expect(Service.instances).toHaveLength(2)
        for (const instance of Service.instances) expect(instance.marks).toEqual(NONE)
    })

    it("18. transient member beside a singleton member — the neighbour adopts, the transient never does", async () => {
        const log: string[] = []
        const Singleton = instrumented("S", log)
        const Transient = instrumented("T", log)

        const module = makeApp({
            providers: [
                { provide: TOKEN, useClass: Singleton, multi: true } as Provider,
                { provide: TOKEN, useClass: Transient, multi: true, scope: Scope.Transient } as Provider,
            ],
        })
        module.mount()

        const first = module.container.resolveAll(TOKEN)
        const second = module.container.resolveAll(TOKEN)
        const third = module.container.resolveAll(TOKEN)

        expect(first[0]).toBe(second[0])
        expect(first[1]).not.toBe(second[1])
        expect(second[1]).not.toBe(third[1])

        module.unmount()
        await module.destroy()

        expect(Singleton.instances).toHaveLength(1)
        expect(Singleton.instances[0]?.marks).toEqual(EAGER)

        // Four transients: one from the eager pass, three from the reads. Not one of them adopted, so the
        // module's participant set never grew however often the collection was read.
        expect(Transient.instances).toHaveLength(4)
        for (const instance of Transient.instances) expect(instance.marks).toEqual(NONE)
    })

    it("19. transient factory, single and inside a collection", async () => {
        const log: string[] = []
        const solo = factoryOf("F", log)
        const member = factoryOf("G", log)
        const Singleton = instrumented("S", log)

        const module = makeApp({
            providers: [
                { provide: OTHER, useFactory: solo.make, scope: Scope.Transient } as Provider,
                { provide: TOKEN, useClass: Singleton, multi: true } as Provider,
                { provide: TOKEN, useFactory: member.make, multi: true, scope: Scope.Transient } as Provider,
            ],
        })
        module.mount()

        module.container.resolve(OTHER)
        module.container.resolve(OTHER)
        module.container.resolveAll(TOKEN)

        module.unmount()
        await module.destroy()

        expect(solo.built).toHaveLength(2)
        for (const built of solo.built) expect(built.marks).toEqual(NONE)
        for (const built of member.built) expect(built.marks).toEqual(NONE)
        expect(Singleton.instances[0]?.marks).toEqual(EAGER)
    })

    it("20. all-transient collection — nothing observed, nothing built eagerly", async () => {
        const log: string[] = []
        const First = instrumented("A", log)
        const Second = instrumented("B", log)

        const module = makeApp({
            providers: [
                { provide: TOKEN, useClass: First, multi: true, scope: Scope.Transient } as Provider,
                { provide: TOKEN, useClass: Second, multi: true, scope: Scope.Transient } as Provider,
            ],
        })

        expect(log).toEqual([])

        module.mount()
        module.container.resolveAll(TOKEN)
        module.container.resolveAll(TOKEN)
        module.unmount()
        await module.destroy()

        expect(First.instances).toHaveLength(2)
        expect(Second.instances).toHaveLength(2)
        for (const instance of [...First.instances, ...Second.instances]) expect(instance.marks).toEqual(NONE)

        // Constructions only — never a hook.
        expect(log.every((entry) => entry.endsWith(":ctor"))).toBe(true)
    })
})

describe("never adopted — request scope", () => {
    it("21. request-scoped class, single", async () => {
        const log: string[] = []
        const Service = instrumented("R", log)

        const module = makeApp({
            providers: [{ provide: TOKEN, useClass: Service, scope: Scope.Request } as Provider],
        })

        expect(Service.instances).toHaveLength(0)

        module.mount()
        module.container.resolve(TOKEN)
        module.container.resolve(TOKEN)
        module.unmount()
        await module.destroy()

        // One read is one graph, so two reads are two instances — and neither was adopted.
        expect(Service.instances).toHaveLength(2)
        for (const instance of Service.instances) expect(instance.marks).toEqual(NONE)
    })

    it("22. request-scoped + lazy — `lazy` changes nothing that was not already deferred", async () => {
        const log: string[] = []
        const Service = instrumented("R", log)

        const module = makeApp({
            providers: [{ provide: TOKEN, useClass: Service, scope: Scope.Request, lazy: true } as Provider],
        })
        module.mount()
        expect(Service.instances).toHaveLength(0)

        module.container.resolve(TOKEN)
        module.unmount()
        await module.destroy()

        expect(Service.instances).toHaveLength(1)
        expect(Service.instances[0]?.marks).toEqual(NONE)
        expect(log).toEqual(["R#1:ctor"])
    })

    it("23. request-scoped member beside a singleton member", async () => {
        const log: string[] = []
        const Singleton = instrumented("S", log)
        const Requested = instrumented("R", log)

        const module = makeApp({
            providers: [
                { provide: TOKEN, useClass: Singleton, multi: true } as Provider,
                { provide: TOKEN, useClass: Requested, multi: true, scope: Scope.Request } as Provider,
            ],
        })
        module.mount()

        const first = module.container.resolveAll(TOKEN)
        const second = module.container.resolveAll(TOKEN)

        expect(first[0]).toBe(second[0])
        expect(first[1]).not.toBe(second[1])

        module.unmount()
        await module.destroy()

        expect(Singleton.instances[0]?.marks).toEqual(EAGER)

        // Three: one from the eager pass the singleton neighbour pulled, two from the reads.
        expect(Requested.instances).toHaveLength(3)
        for (const instance of Requested.instances) expect(instance.marks).toEqual(NONE)
    })

    it("24. request-scoped factory, single and inside a collection", async () => {
        const log: string[] = []
        const solo = factoryOf("F", log)
        const member = factoryOf("G", log)
        const Singleton = instrumented("S", log)

        const module = makeApp({
            providers: [
                { provide: OTHER, useFactory: solo.make, scope: Scope.Request } as Provider,
                { provide: TOKEN, useClass: Singleton, multi: true } as Provider,
                { provide: TOKEN, useFactory: member.make, multi: true, scope: Scope.Request } as Provider,
            ],
        })
        module.mount()

        module.container.resolve(OTHER)
        module.container.resolve(OTHER)
        module.container.resolveAll(TOKEN)

        module.unmount()
        await module.destroy()

        expect(solo.built).toHaveLength(2)
        for (const built of solo.built) expect(built.marks).toEqual(NONE)
        for (const built of member.built) expect(built.marks).toEqual(NONE)
        expect(Singleton.instances[0]?.marks).toEqual(EAGER)
    })

    it("25. all-request collection — nothing observed, nothing built eagerly", async () => {
        const log: string[] = []
        const First = instrumented("A", log)
        const Second = instrumented("B", log)

        const module = makeApp({
            providers: [
                { provide: TOKEN, useClass: First, multi: true, scope: Scope.Request } as Provider,
                { provide: TOKEN, useClass: Second, multi: true, scope: Scope.Request } as Provider,
            ],
        })

        expect(log).toEqual([])

        module.mount()
        module.container.resolveAll(TOKEN)
        module.container.resolveAll(TOKEN)
        module.unmount()
        await module.destroy()

        expect(First.instances).toHaveLength(2)
        expect(Second.instances).toHaveLength(2)
        for (const instance of [...First.instances, ...Second.instances]) expect(instance.marks).toEqual(NONE)

        expect(log.every((entry) => entry.endsWith(":ctor"))).toBe(true)
    })

    it("26. a request-scoped dependency of an adopted singleton is not itself adopted", async () => {
        const log: string[] = []
        const Requested = instrumented("R", log)

        const Owner = class {
            readonly dep = inject(OTHER)

            onModuleInit(): void {
                log.push("O#1:init")
            }
        }

        const module = makeApp({
            providers: [
                { provide: OTHER, useClass: Requested, scope: Scope.Request } as Provider,
                { provide: TOKEN, useClass: Owner } as Provider,
            ],
        })
        await drive(module)

        expect(Requested.instances).toHaveLength(1)
        expect(Requested.instances[0]?.marks).toEqual(NONE)
        expect(log.filter((entry) => entry.endsWith(":init"))).toEqual(["O#1:init"])
    })
})

// OUTSIDE THE MATRIX — construct()
// ========================================
//
// THE DESIGN LINE: `construct()` builds outside the lifecycle plane; its instances are caller-owned, never
// module participants.
//
// Every cell above turns on a REGISTRATION: adoption rides `afterMaterialize`, `afterMaterialize` carries
// an entry snapshot, and an entry is what registration creates. `container.construct(cls)` deliberately has
// none of that — it opens a frame so `inject()` works in the constructor and calls `new cls()`, and that is
// the whole of it. Verified against the kernel source (`Container#construct`): it announces nothing, on any
// of the four channels. So a class with all four hooks, built this way, is an object the caller holds and
// the module has never heard of — not "adopted late", not "adopted and skipped", simply not in the plane.
//
// The one thing that DOES cross over is the reads the constructor makes, and those are judged like any
// other read the module answers. That is the second cell, and it is the argument made executable.

describe("outside the matrix — construct()", () => {
    it("27. builds a lifecycle candidate before init and after, and adopts neither", async () => {
        const log: string[] = []
        const Candidate = instrumented("K", log)

        const events: string[] = []
        const app = new App({})
        for (const event of ["beforeResolution", "afterResolution", "beforeMaterialize", "afterMaterialize"] as const) {
            app.container.on(event, () => events.push(event))
        }

        // PRE-INIT, and the gate is already watching — it is armed in the ModuleLifecycle constructor, not
        // by init(). It never fires, because no entry means no resolution to announce.
        const early = app.container.construct(Candidate)
        expect(events).toEqual([])
        expect(app.status).toBe(ModuleStatus.Created)

        app.init()

        // POST-INIT, past the eager pass and inside the plane's working life. Same answer — but asked as a
        // DELTA, because `init()` legitimately fills this list: the eager pass resolves and materializes
        // the system providers, and those are real events on this container. What must be zero is what the
        // `construct` call below adds to it.
        const beforeLate = events.length
        expect(beforeLate).toBeGreaterThan(0)

        const late = app.container.construct(Candidate)
        expect(late).not.toBe(early)
        expect(events).toHaveLength(beforeLate)

        await drive(app)

        // Two instances, both the caller's, neither one ever notified of anything.
        expect(Candidate.instances).toHaveLength(2)
        expect(Candidate.instances[0]).toBe(early)
        expect(Candidate.instances[1]).toBe(late)
        for (const instance of Candidate.instances) expect(instance.marks).toEqual(NONE)
        expect(log).toEqual(["K#1:ctor", "K#2:ctor"])
    })

    it("28. is judged by the module's status through the reads its constructor makes", () => {
        const log: string[] = []
        const Dependency = instrumented("D", log)

        const Dependent = class {
            readonly dep = inject(TOKEN)
        }

        const app = new App({ providers: [{ provide: TOKEN, useClass: Dependency } as Provider] })

        // `construct()` announces nothing of its own, but the frame it opens is anchored at this module's
        // container — so an `inject()` in the constructor is an ordinary read, and reads are exactly what
        // the resolution gate judges. A dependency-free construct sails past a `created` module; this one
        // is refused, by the inner read rather than by anything construct() does.
        expect(() => app.container.construct(Dependent)).toThrow(
            'Cannot resolve MATRIX from a module whose status is "created"'
        )
        expect(Dependency.instances).toHaveLength(0)

        app.init()

        // Armed, and the read lands. The holder is still not a participant — the dependency it pulled is
        // one, because the module registered THAT.
        const built = app.container.construct(Dependent)
        expect(built.dep).toBe(app.container.resolve(TOKEN))
        expect(Dependency.instances).toHaveLength(1)
        expect(log).toEqual(["D#1:ctor", "D#1:init"])
    })
})
