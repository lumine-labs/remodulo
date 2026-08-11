import { describe, expect, it, vi } from "vitest"

import { Container } from "../../src/container.js"
import { Resolver } from "../../src/resolver.js"
import { Scope } from "../../src/container.types.js"

// Resolver — the read-and-observe half of a container
// ========================================
//
// It mirrors the container's read surface EXACTLY: same names, same mode parameters, same defaults, and
// `on` straight through to the container's own registry. What it does not carry is the write surface —
// `register`, `fork` and `construct` are absent for good — so handing a Resolver out is how a layer offers
// its container's reads without offering its registrations.

const TOKEN = Symbol("PLUGINS")

class Service {
    readonly id = "service"
}

// `Resolver.for` is the ONLY door: the constructor is `private`, so there is no second way to obtain one
// and the canonical-instance guarantee is total rather than conventional. TypeScript-private does not exist
// at runtime, so the enforcement surface is this compile-level pin plus the `private constructor` pin
// against the published declarations in `tests/build/declarations.test.ts`. Never called.
function resolverCannotBeConstructed(container: Container): void {
    // @ts-expect-error the constructor is private — `Resolver.for(container)` is the only door.
    void new Resolver(container)
}
void resolverCannotBeConstructed

describe("construction", () => {
    it("is what `Resolver.for` hands back", () => {
        const container = new Container()
        container.register(Service)

        const resolver = Resolver.for(container)

        expect(resolver).toBeInstanceOf(Resolver)
        expect(resolver.resolve(Service)).toBe(container.resolve(Service))
    })

    it("is CANONICAL per container: same container, same instance", () => {
        const container = new Container()

        expect(Resolver.for(container)).toBe(Resolver.for(container))
    })

    it("is one instance per container, so a fork gets its own", () => {
        const parent = new Container()
        const child = parent.fork()

        expect(Resolver.for(child)).not.toBe(Resolver.for(parent))
        expect(Resolver.for(child)).toBe(Resolver.for(child))
        expect(Resolver.for(parent)).toBe(Resolver.for(parent))
    })
})

// Read parity
// ========================================

describe("resolve", () => {
    it("agrees with the container, and defaults to nearest", () => {
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })
        const child = parent.fork()
        const resolver = Resolver.for(child)

        expect(resolver.resolve(TOKEN)).toBe(child.resolve(TOKEN))
        expect(resolver.resolve(TOKEN)).toBe("parent")
    })

    it("carries the self mode, and its refusal", () => {
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })
        const resolver = Resolver.for(parent.fork())

        expect(() => resolver.resolve(TOKEN, "self")).toThrow(/not registered in this container/)
    })

    it("throws the container's error for a missing token", () => {
        const container = new Container()

        expect(() => Resolver.for(container).resolve(TOKEN)).toThrow(/not registered in this container/)
    })
})

describe("resolveOptional", () => {
    it("agrees with the container, and defaults to nearest", () => {
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })
        const child = parent.fork()
        const resolver = Resolver.for(child)

        expect(resolver.resolveOptional(TOKEN)).toBe("parent")
        expect(resolver.resolveOptional(TOKEN, "self")).toBeUndefined()
        expect(resolver.resolveOptional(Symbol("absent"))).toBeUndefined()
    })
})

describe("resolveOr", () => {
    it("takes both fallback forms, and only reaches them when nothing is registered", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useValue: undefined })
        const resolver = Resolver.for(container)

        // A registered `undefined` is a value, not a miss — the same distinction the container draws.
        expect(resolver.resolveOr(TOKEN, "fallback")).toBeUndefined()
        expect(resolver.resolveOr(Symbol("absent"), "fallback")).toBe("fallback")
        expect(resolver.resolveOr(Symbol("absent"), () => "computed")).toBe("computed")
    })

    it("carries the self mode", () => {
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })
        const resolver = Resolver.for(parent.fork())

        expect(resolver.resolveOr(TOKEN, "fallback")).toBe("parent")
        expect(resolver.resolveOr(TOKEN, "fallback", "self")).toBe("fallback")
    })
})

describe("resolveAll", () => {
    it("agrees with the container, and defaults to the whole chain", () => {
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent", multi: true })
        const child = parent.fork()
        child.register({ provide: TOKEN, useValue: "child", multi: true })
        const resolver = Resolver.for(child)

        expect(resolver.resolveAll(TOKEN)).toEqual(["child", "parent"])
        expect(resolver.resolveAll(TOKEN)).toEqual(child.resolveAll(TOKEN))
        expect(resolver.resolveAll(TOKEN, "nearest")).toEqual(["child"])
        expect(resolver.resolveAll(TOKEN, "self")).toEqual(["child"])
    })

    it("refuses a single registration, like the container does", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "v" })

        expect(() => Resolver.for(container).resolveAll(TOKEN)).toThrow(/is a single registration/)
    })
})

describe("isRegistered", () => {
    it("agrees with the container, and defaults to nearest", () => {
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })
        const resolver = Resolver.for(parent.fork())

        expect(resolver.isRegistered(TOKEN)).toBe(true)
        expect(resolver.isRegistered(TOKEN, "self")).toBe(false)
        expect(resolver.isRegistered(Symbol("absent"))).toBe(false)
    })
})

describe("the metadata plane", () => {
    it("hands out the same snapshots the container does", () => {
        const container = new Container()
        container.register([Service, { provide: TOKEN, useValue: "v", metadata: { policy: "eager" } }])
        const resolver = Resolver.for(container)

        expect(resolver.entry(TOKEN)).toEqual(container.entry(TOKEN))
        expect(resolver.entry(TOKEN)?.metadata).toBe(container.entry(TOKEN)?.metadata)
        expect(resolver.registrations()).toEqual(container.registrations())
        expect(resolver.registrations()).toHaveLength(2)
        expect(resolver.entry(Symbol("absent"))).toBeUndefined()
    })

    it("hands out the collection reads, with the container's refusals", () => {
        const container = new Container()
        container.register([
            { provide: TOKEN, useValue: "a", multi: true },
            { provide: TOKEN, useValue: "b", multi: true },
        ])
        const resolver = Resolver.for(container)

        expect(resolver.entries(TOKEN)).toEqual(container.entries(TOKEN))
        expect(resolver.entries(TOKEN)).toHaveLength(2)
        expect(() => resolver.entry(TOKEN)).toThrow(/multi-provider collection/)
    })

    it("reads the container it was made over, not a copy of it at construction time", () => {
        const container = new Container()
        const resolver = Resolver.for(container)

        expect(resolver.registrations()).toEqual([])

        container.register(Service)

        expect(resolver.registrations()).toHaveLength(1)
        expect(resolver.resolve(Service)).toBeInstanceOf(Service)
    })
})

// The write surface is absent
// ========================================
//
// Checked by `typecheck:tests` for the type-level half and by an `in` sweep for the runtime half. Nothing
// in this function is ever called.
function resolverOffersNoWrites(resolver: Resolver): void {
    // @ts-expect-error `register` is the container's, and a resolver is the read surface.
    resolver.register(Service)
    // @ts-expect-error `fork` makes a container, which is a write door onto a new level.
    resolver.fork()
    // @ts-expect-error `construct` builds, which is not a read.
    resolver.construct(Service)
}
void resolverOffersNoWrites

describe("the write surface", () => {
    it("is absent at runtime too", () => {
        const resolver = Resolver.for(new Container())

        // `in` walks the prototype chain, so this catches a method re-added to the class as readily as an
        // own property. The type-level half is `resolverOffersNoWrites` above.
        for (const name of ["register", "fork", "construct"]) {
            expect(name in resolver, `Resolver still exposes \`${name}\``).toBe(false)
        }

        for (const name of [
            "resolve",
            "resolveOptional",
            "resolveOr",
            "resolveAll",
            "isRegistered",
            "entry",
            "entries",
            "registrations",
            "on",
        ]) {
            expect(name in resolver, `Resolver no longer exposes \`${name}\``).toBe(true)
        }
    })

    it("holds the container privately, so it cannot be read back off the object", () => {
        const container = new Container()
        const resolver = Resolver.for(container)

        expect(Object.values(resolver)).toEqual([])
        expect(JSON.stringify(resolver)).toBe("{}")
    })
})

// Observation parity
// ========================================

describe("on", () => {
    it("registers on the underlying container, so container-direct reads reach the hook", () => {
        const container = new Container()
        container.register(Service)
        const resolver = Resolver.for(container)

        const seen: unknown[] = []
        resolver.on("afterMaterialize", ({ instance }) => seen.push(instance))

        // The read never touched the resolver, and the hook fired anyway: there is no resolver-scoped
        // event stream to be had.
        const instance = container.resolve(Service)

        expect(seen).toEqual([instance])
    })

    it("returns the container's disposer", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useClass: class {}, scope: Scope.Transient })
        const resolver = Resolver.for(container)

        const hook = vi.fn()
        const detach = resolver.on("afterMaterialize", hook)

        container.resolve(TOKEN)
        detach()
        container.resolve(TOKEN)

        expect(hook).toHaveBeenCalledTimes(1)
    })

    it("outlives the resolver that attached it", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useClass: class {}, scope: Scope.Transient })

        const seen: string[] = []
        let resolver: Resolver | null = Resolver.for(container)
        resolver.on("afterMaterialize", () => seen.push("fired"))

        // Dropping the resolver detaches nothing: the hook is the CONTAINER's, and lives until it is
        // disposed or the container dies.
        resolver = null
        container.resolve(TOKEN)
        container.resolve(TOKEN)

        expect(resolver).toBeNull()
        expect(seen).toEqual(["fired", "fired"])
    })

    it("shares one registry with the container, in one registration order", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "v" })
        const resolver = Resolver.for(container)

        const order: string[] = []
        container.on("afterMaterialize", () => order.push("container"))
        resolver.on("afterMaterialize", () => order.push("resolver"))
        container.on("afterMaterialize", () => order.push("container again"))

        container.resolve(TOKEN)

        expect(order).toEqual(["container", "resolver", "container again"])
    })

    it("reports a read made through the resolver on the container the resolver views", () => {
        class Owned {}
        const parent = new Container()
        parent.register(Owned)
        const child = parent.fork()

        const parentEvents: string[] = []
        const childEvents: string[] = []
        for (const event of ["beforeResolution", "afterMaterialize"] as const) {
            parent.on(event, () => parentEvents.push(event))
            child.on(event, () => childEvents.push(event))
        }

        // The chain rule is the container's, and the resolver changes nothing about it: the read was
        // initiated on the child's container, the entry lives on the parent's.
        Resolver.for(child).resolve(Owned)

        expect(childEvents).toEqual(["beforeResolution"])
        expect(parentEvents).toEqual(["afterMaterialize"])
    })

    it("refuses an operation from a resolver-attached before hook, for every caller", () => {
        const container = new Container()
        container.register(Service)
        const refusal = new Error("refused")

        Resolver.for(container).on("beforeResolution", () => {
            throw refusal
        })

        expect(() => container.resolve(Service)).toThrow(refusal)
        expect(() => Resolver.for(container).resolve(Service)).toThrow(refusal)
    })
})
