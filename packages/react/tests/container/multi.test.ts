import { describe, expect, it } from "vitest"

import { Container, ResolveAllMode, Resolver, Scope, inject, injectAll, injectOptional } from "@remodulo/container"
import type { Constructor } from "@remodulo/container"
import type {
    ClassProvider,
    ExistingProvider,
    FactoryProvider,
    Provider,
    ValueProvider,
} from "../../src/core/provider.types.js"
import { registerProviders } from "../../src/core/provider.js"
import { makeApp, makeChild } from "../setup/helpers.js"

// Multi-providers.
// ========================================
//
// `multi: true` turns a token from one registration into a collection several providers contribute to.
// The whole contract rests on one property: MODE IS CHAIN-WIDE. A token is a single registration or a
// collection, and it is that for every container in the chain — registration refuses to mix. That is what
// lets `resolve` and `resolveAll` decide from the nearest declared mode alone, and it is why every
// diagonal cell of the matrix below throws at registration rather than at the read.


const TOKEN = Symbol("PLUGINS")

describe("registration matrix — same container", () => {
    it("single then single: rejected, as before", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "a" })

        expect(() => container.register({ provide: TOKEN, useValue: "b" })).toThrow(
            "Token PLUGINS is already registered on this container."
        )
    })

    it("multi then multi: appended", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "a", multi: true })
        container.register({ provide: TOKEN, useValue: "b", multi: true })
        container.register({ provide: TOKEN, useValue: "c", multi: true })

        expect(container.resolveAll(TOKEN)).toEqual(["a", "b", "c"])
    })

    it("multi: false claims the token exactly as omitting multi does", () => {
        class Service {}

        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service, multi: false })

        expect(container.resolve(TOKEN)).toBeInstanceOf(Service)
        expect(() => container.register({ provide: TOKEN, useValue: "b", multi: true })).toThrow(
            "Token PLUGINS is already a single registration on this container, and this provider registers it as a multi-provider collection."
        )
    })

    it("single then multi: rejected, naming both registrations", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "a" })

        expect(() => container.register({ provide: TOKEN, useValue: "b", multi: true })).toThrow(
            "Token PLUGINS is already a single registration on this container, and this provider registers it as a multi-provider collection."
        )
    })

    it("multi then single: rejected, naming both registrations", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "a", multi: true })

        expect(() => container.register({ provide: TOKEN, useValue: "b" })).toThrow(
            "Token PLUGINS is already a multi-provider collection on this container, and this provider registers it as a single registration."
        )
    })

    it("points at the fix in either direction", () => {
        const single = new Container()
        single.register({ provide: TOKEN, useValue: "a" })
        expect(() => single.register({ provide: TOKEN, useValue: "b", multi: true })).toThrow(
            "Drop `multi: true` here, or add it to the other registration."
        )

        const multi = new Container()
        multi.register({ provide: TOKEN, useValue: "a", multi: true })
        expect(() => multi.register({ provide: TOKEN, useValue: "b" })).toThrow(
            "Add `multi: true` here, or drop it from the other registration."
        )
    })

    it("rejects the mix whichever provider form carries it", () => {
        class Service {}

        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service, multi: true })

        expect(() => container.register({ provide: TOKEN, useFactory: () => "b" })).toThrow(
            "is already a multi-provider collection"
        )
        expect(() => container.register({ provide: TOKEN, useValue: "b" })).toThrow(
            "is already a multi-provider collection"
        )
    })
})

describe("registration matrix — across the chain", () => {
    it("single then single: allowed, the child shadows the parent", () => {
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })
        const child = parent.fork()
        child.register({ provide: TOKEN, useValue: "child" })

        expect(child.resolve(TOKEN)).toBe("child")
        expect(parent.resolve(TOKEN)).toBe("parent")
    })

    it("multi then multi: allowed, the child contributes to the chain's collection", () => {
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent", multi: true })
        const child = parent.fork()
        child.register({ provide: TOKEN, useValue: "child", multi: true })

        expect(child.resolveAll(TOKEN)).toEqual(["child", "parent"])
        expect(parent.resolveAll(TOKEN)).toEqual(["parent"])
    })

    it("single in the parent then multi in the child: rejected at the child's registration", () => {
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })
        const child = parent.fork()

        expect(() => child.register({ provide: TOKEN, useValue: "child", multi: true })).toThrow(
            "Token PLUGINS is already a single registration on an ancestor container, and this provider registers it as a multi-provider collection."
        )
    })

    it("multi in the parent then single in the child: rejected at the child's registration", () => {
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent", multi: true })
        const child = parent.fork()

        expect(() => child.register({ provide: TOKEN, useValue: "child" })).toThrow(
            "Token PLUGINS is already a multi-provider collection on an ancestor container, and this provider registers it as a single registration."
        )
    })

    it("looks past a container that declares nothing", () => {
        const root = new Container()
        root.register({ provide: TOKEN, useValue: "root", multi: true })
        const middle = root.fork()
        const leaf = middle.fork()

        expect(() => leaf.register({ provide: TOKEN, useValue: "leaf" })).toThrow(
            "already a multi-provider collection on an ancestor container"
        )
    })

    it("only the first own registration consults the chain — later members just append", () => {
        const root = new Container()
        root.register({ provide: TOKEN, useValue: "root", multi: true })
        const leaf = root.fork()
        leaf.register({ provide: TOKEN, useValue: "leaf-1", multi: true })
        leaf.register({ provide: TOKEN, useValue: "leaf-2", multi: true })

        expect(leaf.resolveAll(TOKEN)).toEqual(["leaf-1", "leaf-2", "root"])
    })
})

describe("resolve guards", () => {
    function multiContainer(): Container {
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "a", multi: true })
        container.register({ provide: TOKEN, useValue: "b", multi: true })
        return container
    }

    it("resolve refuses a collection", () => {
        expect(() => multiContainer().resolve(TOKEN)).toThrow(
            "Token PLUGINS is a multi-provider collection — several providers contribute to it, so there is no single value to read. Use `resolveAll`."
        )
    })

    it("resolveOptional refuses a collection rather than reporting absence", () => {
        // Misuse, not a miss: `undefined` here would read as "nothing registered", which is a lie.
        expect(() => multiContainer().resolveOptional(TOKEN)).toThrow("Use `resolveAll`.")
    })

    it("resolveOr refuses a collection rather than falling back", () => {
        expect(() => multiContainer().resolveOr(TOKEN, "fallback")).toThrow("Use `resolveAll`.")
        expect(() => multiContainer().resolveOr(TOKEN, () => "fallback")).toThrow("Use `resolveAll`.")
    })

    it("refuses a collection contributed entirely by an ancestor", () => {
        const child = multiContainer().fork()

        expect(() => child.resolve(TOKEN)).toThrow("Use `resolveAll`.")
        expect(() => child.resolveOptional(TOKEN)).toThrow("Use `resolveAll`.")
        expect(() => child.resolveOr(TOKEN, "fallback")).toThrow("Use `resolveAll`.")
    })

    it("refuses a collection of exactly one member", () => {
        // The guard is about the MODE, not the count: a collection that happens to have one contribution
        // today is still a collection, and code reading it with `resolve` breaks on the second plugin.
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "only", multi: true })

        expect(() => container.resolve(TOKEN)).toThrow("Use `resolveAll`.")
        expect(container.resolveAll(TOKEN)).toEqual(["only"])
    })

    it("resolveAll refuses a single registration", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "only" })

        expect(() => container.resolveAll(TOKEN)).toThrow(
            "Token PLUGINS is a single registration, not a multi-provider collection — `resolveAll` would hide that behind a one-element array. Use `resolve`, or mark every provider for it `multi: true`."
        )
    })

    it("resolveAll refuses a single registration inherited from an ancestor", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "only" })

        expect(() => container.fork().resolveAll(TOKEN)).toThrow("Use `resolve`")
    })

    it("resolveAll on a completely unregistered token stays []", () => {
        // The optional-contribution pattern: a collection point nobody filled is empty, not a mistake.
        const root = new Container()
        const child = root.fork()

        expect(root.resolveAll(TOKEN)).toEqual([])
        expect(child.resolveAll(TOKEN)).toEqual([])
        expect(child.resolveAll(TOKEN, "nearest")).toEqual([])
        expect(child.resolveAll(TOKEN, "self")).toEqual([])
    })
})

describe("aliases", () => {
    class Legacy {
        readonly name = "legacy"
    }
    class Direct {
        readonly name = "direct"
    }

    it("may BE a collection member, contributing the target's instance", () => {

        const container = new Container()
        container.register(Legacy)
        container.register({ provide: TOKEN, useClass: Direct, multi: true })
        container.register({ provide: TOKEN, useExisting: Legacy, multi: true })

        const all = container.resolveAll<Direct | Legacy>(TOKEN)
        expect(all.map((member) => member.name)).toEqual(["direct", "legacy"])
        expect(all[1]).toBe(container.resolve(Legacy))
    })

    it("may not TARGET a collection that already exists", () => {
        const ALIAS = Symbol("ALIAS")
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "a", multi: true })

        expect(() => container.register({ provide: ALIAS, useExisting: TOKEN })).toThrow(
            "Provider for ALIAS cannot alias PLUGINS: PLUGINS is a multi-provider collection, and `useExisting` is a single-value read of its target"
        )
    })

    it("may not have its target BECOME a collection afterwards", () => {
        const ALIAS = Symbol("ALIAS")
        const container = new Container()
        container.register({ provide: ALIAS, useExisting: TOKEN })

        expect(() => container.register({ provide: TOKEN, useValue: "a", multi: true })).toThrow(
            "Provider for ALIAS cannot alias PLUGINS"
        )
    })

    it("rejects a child's alias onto a collection declared by an ancestor", () => {
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent", multi: true })
        const child = parent.fork()

        expect(() => child.register({ provide: Symbol("ALIAS"), useExisting: TOKEN })).toThrow(
            "cannot alias PLUGINS"
        )
    })

    it("rejects a child's collection when an ancestor already aliases the token", () => {
        const ALIAS = Symbol("ALIAS")
        const parent = new Container()
        parent.register({ provide: ALIAS, useExisting: TOKEN })
        const child = parent.fork()

        expect(() => child.register({ provide: TOKEN, useValue: "child", multi: true })).toThrow(
            "Provider for ALIAS cannot alias PLUGINS"
        )
    })

    it("leaves an alias onto a single registration alone, in either order", () => {
        const ALIAS = Symbol("ALIAS")
        const before = new Container()
        before.register({ provide: TOKEN, useValue: "target" })
        before.register({ provide: ALIAS, useExisting: TOKEN })
        expect(before.resolve(ALIAS)).toBe("target")

        const after = new Container()
        after.register({ provide: ALIAS, useExisting: TOKEN })
        after.register({ provide: TOKEN, useValue: "target" })
        expect(after.resolve(ALIAS)).toBe("target")
    })

    it("leaves an alias onto a token nobody ever registers alone", () => {
        const container = new Container()
        container.register({ provide: Symbol("ALIAS"), useExisting: TOKEN })

        expect(container.resolveAll(TOKEN)).toEqual([])
    })

    it("names both parties, so neither registration has to be hunted for", () => {
        const container = new Container()
        container.register({ provide: "feature.logger", useExisting: "app.logger" })

        expect(() => container.register({ provide: "app.logger", useValue: 1, multi: true })).toThrow(
            "Provider for feature.logger cannot alias app.logger"
        )
    })
})

// `lazy` is a react-level key with no kernel counterpart: the kernel container knows nothing about an
// eager pass, so the uniformity claim moved to the MODULE registration path, which is the only place
// `lazy` is read at all. The error text is unchanged, and so is every rule below it.
describe("lazy uniformity", () => {
    class Service {}

    it("accepts a collection whose constructing members agree", () => {
        const module = makeApp({
            providers: [
                { provide: TOKEN, useClass: Service, multi: true, lazy: true },
                { provide: TOKEN, useFactory: () => new Service(), multi: true, lazy: true },
            ],
        })

        expect(module.container.resolveAll(TOKEN)).toHaveLength(2)
    })

    it("takes a value member in when it agrees", () => {
        // A value builds nothing, but it is MATERIALIZED by the same eager `resolveAll` as its constructing
        // siblings — so it is inside the rule, and it has to declare the same verdict they do.
        const module = makeApp({
            providers: [
                { provide: TOKEN, useClass: Service, multi: true, lazy: true },
                { provide: TOKEN, useValue: "ready", multi: true, lazy: true },
            ],
        })

        expect(module.container.resolveAll(TOKEN)).toHaveLength(2)
    })

    it("refuses a value member that does not", () => {
        expect(() =>
            makeApp({
                providers: [
                    { provide: TOKEN, useClass: Service, multi: true, lazy: true },
                    { provide: TOKEN, useValue: "ready", multi: true },
                ],
            })
        ).toThrow(
            "Provider for PLUGINS declares `lazy: false` while the collection already registered for that token is `lazy: true`."
        )
    })

    it("lets an alias member into a lazy collection — when it agrees, and refuses it when it does not", () => {
        // FLIPPED: an alias member used to be exempt from the lazy ledger, on the theory that it binds
        // nothing so it has no timing of its own. It does have one — `lazy` decides whether the owner
        // RESOLVES THROUGH it at init, which is what pulls the target into existence. So it reconciles like
        // every other member, and the remedy for the old spelling is to mark it lazy too.
        const module = makeApp({
            providers: [
                Service,
                { provide: TOKEN, useClass: Service, multi: true, lazy: true },
                { provide: TOKEN, useExisting: Service, multi: true, lazy: true },
            ],
        })

        expect(module.container.resolveAll(TOKEN)).toHaveLength(2)

        // And the disagreements it used to be waved through on, in both directions — an eager alias in a
        // lazy collection, and a lazy alias in an eager one.
        expect(() =>
            makeApp({
                providers: [
                    Service,
                    { provide: TOKEN, useClass: Service, multi: true, lazy: true },
                    { provide: TOKEN, useExisting: Service, multi: true },
                ],
            })
        ).toThrow("declares `lazy: false` while the collection already registered for that token is `lazy: true`.")

        expect(() =>
            makeApp({
                providers: [
                    Service,
                    { provide: TOKEN, useClass: Service, multi: true },
                    { provide: TOKEN, useExisting: Service, multi: true, lazy: true },
                ],
            })
        ).toThrow("declares `lazy: true` while the collection already registered for that token is `lazy: false`.")
    })

    it("reads a value member's verdict whichever end of the list it arrives at", () => {
        // Order must not matter: the value SETS the verdict when it comes first, and is measured against
        // it when it comes last. Either way the refusal is the same one.
        expect(() =>
            makeApp({
                providers: [
                    { provide: TOKEN, useValue: "ready", multi: true },
                    { provide: TOKEN, useClass: Service, multi: true, lazy: true },
                ],
            })
        ).toThrow(
            "Provider for PLUGINS declares `lazy: true` while the collection already registered for that token is `lazy: false`."
        )

        const module = makeApp({
            providers: [
                { provide: TOKEN, useValue: "ready", multi: true, lazy: true },
                { provide: TOKEN, useClass: Service, multi: true, lazy: true },
            ],
        })

        expect(module.container.resolveAll(TOKEN)).toHaveLength(2)
    })

    it("rejects a lazy member joining an eager collection", () => {
        expect(() =>
            makeApp({
                providers: [
                    { provide: TOKEN, useClass: Service, multi: true },
                    { provide: TOKEN, useClass: Service, multi: true, lazy: true },
                ],
            })
        ).toThrow(
            "Provider for PLUGINS declares `lazy: true` while the collection already registered for that token is `lazy: false`."
        )
    })

    it("rejects an eager member joining a lazy collection", () => {
        expect(() =>
            makeApp({
                providers: [
                    { provide: TOKEN, useClass: Service, multi: true, lazy: true },
                    { provide: TOKEN, useClass: Service, multi: true },
                ],
            })
        ).toThrow(
            "Provider for PLUGINS declares `lazy: false` while the collection already registered for that token is `lazy: true`."
        )
    })

    it("is per module, not per chain — each module builds its own contributions", () => {
        const parent = makeApp({ providers: [{ provide: TOKEN, useClass: Service, multi: true }] })
        const child = makeChild(parent, { providers: [{ provide: TOKEN, useClass: Service, multi: true, lazy: true }] })

        expect(child.container.resolveAll(TOKEN)).toHaveLength(2)
    })
})

describe("multi requires an explicit provide", () => {
    it("rejects the class shorthand at runtime, as the types do at compile time", () => {
        class Service {}

        const container = new Container()

        expect(() => container.register({ useClass: Service, multi: true } as never)).toThrow(
            "Provider with `multi: true` requires `provide`"
        )
    })
})

describe("observation", () => {
    it("reports every member of a collection, once each", () => {
        const seen: string[] = []
        class A {
            readonly name = "a"
        }
        class B {
            readonly name = "b"
        }

        const container = new Container()
        container.register({ provide: TOKEN, useClass: A, multi: true })
        container.register({ provide: TOKEN, useClass: B, multi: true })
        container.on("afterMaterialize", ({ instance }) => seen.push((instance as A | B).name))

        container.resolveAll(TOKEN)
        container.resolveAll(TOKEN)

        expect(seen).toEqual(["a", "b"])
    })

    it("observes members registered after the hook was attached", () => {
        const seen: string[] = []
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "a", multi: true })
        container.on("afterMaterialize", ({ instance }) => seen.push(instance as string))
        container.register({ provide: TOKEN, useValue: "b", multi: true })

        container.resolveAll(TOKEN)

        // The reverse of what per-entry attachment did, and harmless for ModuleLifecycle either way: a
        // module registers every provider in its constructor and arms its hook during init.
        expect(seen).toEqual(["a", "b"])
    })

    it("reports an ancestor's members to the ancestor only", () => {
        const parentSeen: string[] = []
        const childSeen: string[] = []

        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent", multi: true })
        parent.on("afterMaterialize", ({ instance }) => parentSeen.push(instance as string))

        const child = parent.fork()
        child.register({ provide: TOKEN, useValue: "child", multi: true })
        child.on("afterMaterialize", ({ instance }) => childSeen.push(instance as string))

        expect(child.resolveAll(TOKEN)).toEqual(["child", "parent"])
        expect(parentSeen).toEqual(["parent"])
        expect(childSeen).toEqual(["child"])
    })

    it("attaches to a token with no bindings of its own, and simply never fires", () => {
        const seen: unknown[] = []
        const container = new Container()

        // Nothing left to refuse: `on` takes no token, so a hook on a container that registered nothing is
        // a hook that hears nothing.
        expect(() => container.on("afterMaterialize", ({ instance }) => seen.push(instance))).not.toThrow()
        expect(seen).toEqual([])
    })

    it("reports nothing of its own for a collection made entirely of aliases", () => {
        // Aliases carry no binding of their own: resolving one materializes the TARGET, and it is the
        // target's entry that gets reported. The collection's own token never appears.
        class Legacy {}

        const seen: unknown[] = []
        const container = new Container()
        container.register(Legacy)
        container.register({ provide: TOKEN, useExisting: Legacy, multi: true })
        container.on("afterMaterialize", ({ snapshot }) => seen.push(snapshot.token))

        container.resolveAll(TOKEN)

        expect(seen).toEqual([Legacy])
    })

    // The kernel reports every construction through one event, and it hands the hook the snapshot of the
    // entry that produced the value. Selecting by scope is therefore an `if` in the hook rather than a
    // predicate consulted at attach time — the mechanism the whole adoption contract rests on.
    it("an in-hook singleton filter skips a transient member sharing the token", () => {
        // The standing invariant since 0.4.0: transients never participate in lifecycle. Filtering per
        // BINDING rather than per token is what keeps that true inside a collection.
        class Transient {
            readonly name = "transient"
        }

        // One observation per container — see the last test in this block for why they cannot share one.
        const mixed = (): Container => {
            const container = new Container()
            container.register({ provide: TOKEN, useValue: { name: "constant" }, multi: true })
            container.register({ provide: TOKEN, useClass: Transient, multi: true, scope: Scope.Transient })
            return container
        }

        const all: string[] = []
        const everything = mixed()
        everything.on("afterMaterialize", ({ instance }) => all.push((instance as { name: string }).name))

        const retained: string[] = []
        const singletons = mixed()
        singletons.on("afterMaterialize", ({ instance, snapshot }) => {
            if (snapshot.scope === Scope.Singleton) retained.push((instance as { name: string }).name)
        })

        for (const container of [everything, singletons]) {
            container.resolveAll(TOKEN)
            container.resolveAll(TOKEN)
            container.resolveAll(TOKEN)
        }

        // The unfiltered hook reports every construction, transients included.
        expect(all).toEqual(["constant", "transient", "transient", "transient"])
        expect(retained).toEqual(["constant"])
    })

    it("the singleton filter reports nothing when the token retains nothing", () => {
        class Transient {}

        const seen: unknown[] = []
        const container = new Container()
        container.register({ provide: TOKEN, useClass: Transient, multi: true, scope: Scope.Transient })
        container.register({ provide: TOKEN, useFactory: () => new Transient(), multi: true, scope: Scope.Transient })

        // Not an error: a token whose every binding is transient simply retains nothing.
        container.on("afterMaterialize", ({ instance, snapshot }) => {
            if (snapshot.scope === Scope.Singleton) seen.push(instance)
        })
        container.resolveAll(TOKEN)

        expect(seen).toEqual([])
    })

    it("keeps every observer of a binding, notified in attach order", () => {
        // The kernel keeps a hook LIST per event and walks a copy of it, so observers accumulate rather
        // than replacing one another — the failure mode inversify's `onActivation` had.
        const order: string[] = []

        const container = new Container()
        container.register({ provide: TOKEN, useValue: "v", multi: true })
        container.on("afterMaterialize", ({ instance }) => order.push(`first:${instance as string}`))
        container.on("afterMaterialize", ({ instance }) => order.push(`second:${instance as string}`))
        container.on("afterMaterialize", ({ instance }) => order.push(`third:${instance as string}`))

        container.resolveAll(TOKEN)

        expect(order).toEqual(["first:v", "second:v", "third:v"])
    })

    it("lets an unfiltered and a filtered observation share a binding", () => {
        const seen: string[] = []

        const container = new Container()
        container.register({ provide: TOKEN, useValue: "v", multi: true })
        container.on("afterMaterialize", ({ instance }) => seen.push(`all:${instance as string}`))
        container.on("afterMaterialize", ({ instance, snapshot }) => {
            if (snapshot.scope === Scope.Singleton) seen.push(`retained:${instance as string}`)
        })

        container.resolveAll(TOKEN)

        expect(seen).toEqual(["all:v", "retained:v"])
    })

    it("notifies every observer of a transient binding on every construction", () => {
        class Service {}

        const first: number[] = []
        const second: number[] = []
        let built = 0

        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service, multi: true, scope: Scope.Transient })
        container.on("afterMaterialize", () => first.push(++built))
        container.on("afterMaterialize", () => second.push(built))

        container.resolveAll(TOKEN)
        container.resolveAll(TOKEN)

        expect(first).toEqual([1, 2])
        expect(second).toEqual([1, 2])
    })

    it("observes without intercepting — a listener cannot change what resolve hands out", () => {
        const original = { name: "original" }

        const container = new Container()
        container.register({ provide: TOKEN, useValue: original })

        // The signature says `void`, and the dispatcher returns the original whatever a hook does.
        container.on("afterMaterialize", () => ({ name: "replaced" }) as never)
        container.on("afterMaterialize", () => undefined)

        expect(container.resolve(TOKEN)).toBe(original)
    })

    it("reports the non-alias members of a mixed collection", () => {
        const seen: string[] = []
        class Legacy {
            readonly name = "legacy"
        }
        class Direct {
            readonly name = "direct"
        }

        const container = new Container()
        container.register(Legacy)
        container.register({ provide: TOKEN, useClass: Direct, multi: true })
        container.register({ provide: TOKEN, useExisting: Legacy, multi: true })
        container.on("afterMaterialize", ({ instance, snapshot }) => {
            if (snapshot.token === TOKEN) seen.push((instance as Direct).name)
        })

        container.resolveAll(TOKEN)

        // The alias member contributes nothing under TOKEN — `Legacy` materializes under its own entry.
        expect(seen).toEqual(["direct"])
    })
})

describe("scopes inside a collection", () => {
    // Scope is per MEMBER, and there is no uniformity rule. There briefly was one: while adoption was
    // filtered per token, a transient sharing a token with a singleton got adopted and accumulated. Since
    // adoption is filtered per NOTIFICATION — every `afterMaterialize` payload carries the producing entry's
    // snapshot — the shape it forbade no longer breaks anything, so the guard came out.

    class Service {}

    it("accepts a singleton and a transient member under one token, either order", () => {
        const singletonFirst = new Container()
        singletonFirst.register({ provide: TOKEN, useClass: Service, multi: true })
        singletonFirst.register({ provide: TOKEN, useFactory: () => new Service(), multi: true, scope: Scope.Transient })
        expect(singletonFirst.resolveAll(TOKEN)).toHaveLength(2)

        const transientFirst = new Container()
        transientFirst.register({ provide: TOKEN, useClass: Service, multi: true, scope: Scope.Transient })
        transientFirst.register({ provide: TOKEN, useFactory: () => new Service(), multi: true })
        expect(transientFirst.resolveAll(TOKEN)).toHaveLength(2)
    })

    it("gives each member the identity its own scope asks for", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service, multi: true })
        container.register({ provide: TOKEN, useFactory: () => new Service(), multi: true, scope: Scope.Transient })

        const first = container.resolveAll(TOKEN)
        const second = container.resolveAll(TOKEN)

        expect(first[0]).toBe(second[0])
        expect(first[1]).not.toBe(second[1])
    })

    it("keeps an all-transient collection fully transient", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service, multi: true, scope: Scope.Transient })
        container.register({ provide: TOKEN, useFactory: () => new Service(), multi: true, scope: Scope.Transient })

        const first = container.resolveAll(TOKEN)
        const second = container.resolveAll(TOKEN)

        expect(first).toHaveLength(2)
        expect(first[0]).not.toBe(second[0])
        expect(first[1]).not.toBe(second[1])
    })

    it("takes value and alias members alongside either scope", () => {
        const container = new Container()
        container.register(Service)
        container.register({ provide: TOKEN, useClass: Service, multi: true, scope: Scope.Transient })
        container.register({ provide: TOKEN, useValue: "constant", multi: true })
        container.register({ provide: TOKEN, useExisting: Service, multi: true })

        expect(container.resolveAll(TOKEN)).toHaveLength(3)
    })

    it("mixes scopes across the chain too", () => {
        const parent = new Container()
        parent.register({ provide: TOKEN, useClass: Service, multi: true })
        const child = parent.fork()
        child.register({ provide: TOKEN, useClass: Service, multi: true, scope: Scope.Transient })

        expect(child.resolveAll(TOKEN)).toHaveLength(2)
    })

    it("still refuses members that disagree about lazy — that one IS group-coupled", () => {
        // The distinction the removal turns on: the eager pass builds a collection whole, so laziness
        // belongs to the group; scope belongs to the binding and nothing reads it collectively. `lazy` is
        // a react-level key, so the claim is made where it is read — the module registration path.
        expect(() =>
            makeApp({
                providers: [
                    { provide: TOKEN, useClass: Service, multi: true, scope: Scope.Transient },
                    { provide: TOKEN, useClass: Service, multi: true, scope: Scope.Transient, lazy: true },
                ],
            })
        ).toThrow("declares `lazy: true`")
    })
})

describe("claim precedence", () => {
    class Service {}

    // Three claims, in a fixed order — mode, then alias, then lazy — and the first one violated is the one
    // reported. A provider that gets two things wrong hears about the earlier one, so the message never
    // depends on which check happens to be cheaper. Mode and alias are the KERNEL's claims and lazy is
    // react's, so the order is now a property of the registration path: it hands each provider to the
    // kernel first and only then settles `lazy`.

    it("reports the mode conflict before anything about lazy", () => {
        expect(() =>
            makeApp({
                providers: [
                    { provide: TOKEN, useClass: Service },
                    { provide: TOKEN, useClass: Service, multi: true, lazy: true },
                ],
            })
        ).toThrow("is already a single registration on this container")
    })

    it("reports the alias conflict before anything about lazy", () => {
        expect(() =>
            makeApp({
                providers: [
                    { provide: Symbol("ALIAS"), useExisting: TOKEN },
                    { provide: TOKEN, useClass: Service, multi: true, lazy: true },
                ],
            })
        ).toThrow("cannot alias PLUGINS")
    })

    it("reports the lazy mismatch once mode and alias are settled", () => {
        expect(() =>
            makeApp({
                providers: [
                    { provide: TOKEN, useClass: Service, multi: true },
                    { provide: TOKEN, useClass: Service, multi: true, lazy: true },
                ],
            })
        ).toThrow("declares `lazy: true`")
    })
})

// Read-surface parity
// ========================================
//
// `Resolver` mirrors `Container`'s read surface exactly — that is its whole job — and a mode means the same
// thing on every read that takes it. The decorator used to be the one surface that could not carry the
// whole set; `injectAll` replaces it and does, so all four surfaces now agree mode for mode. A factory's
// `inject` array is the fourth: it is routed by US, and it routes to the very same reads.

describe("Resolver parity", () => {
    function chain(): { resolver: Resolver; bare: Resolver; leaf: Container } {
        const root = new Container()
        root.register({ provide: TOKEN, useValue: "root", multi: true })
        const leaf = root.fork()
        leaf.register({ provide: TOKEN, useValue: "leaf", multi: true })

        return { resolver: Resolver.for(leaf), bare: Resolver.for(leaf.fork()), leaf }
    }

    it("collects the chain by default, exactly as the container does", () => {
        const { resolver, leaf } = chain()

        expect(resolver.resolveAll(TOKEN)).toEqual(["leaf", "root"])
        expect(resolver.resolveAll(TOKEN)).toEqual(leaf.resolveAll(TOKEN))
    })

    it("collects one level in self and nearest mode, exactly as the container does", () => {
        const { resolver, leaf } = chain()

        for (const mode of ["self", "nearest"] as const) {
            expect(resolver.resolveAll(TOKEN, mode)).toEqual(["leaf"])
            expect(resolver.resolveAll(TOKEN, mode)).toEqual(leaf.resolveAll(TOKEN, mode))
        }
    })

    it("mirrors the container's nearest-mode ancestor fallback, and its self-mode empty", () => {
        // Owner ruling 2026-08-01: `Resolver` mirrors `Container` exactly, and `Container.resolveAll` in
        // `nearest` mode follows inversify — unchained `getAll` on a container with nothing of its own
        // reads the nearest ancestor that has some (MEASURED, probe-multiprovider-2-getall-chain 2h).
        // `self` is that mode minus the fallback, and it is a mode rather than a guard so the decorator's
        // absence from it is visible in the type rather than silent at the call site.
        const { bare } = chain()

        // Nearest CONTRIBUTING ancestor's own bindings — `leaf` alone — where the chained read gets both.
        expect(bare.resolveAll(TOKEN, "nearest")).toEqual(["leaf"])
        expect(bare.resolveAll(TOKEN, "self")).toEqual([])
        expect(bare.resolveAll(TOKEN)).toEqual(["leaf", "root"])
    })

    it("mirrors the container's single reads, self and nearest alike", () => {
        const SINGLE = Symbol("resolver-single")
        const root = new Container()
        root.register({ provide: SINGLE, useValue: "root" })
        const child = root.fork()
        const resolver = Resolver.for(child)

        expect(resolver.resolve(SINGLE, "nearest")).toBe("root")
        expect(resolver.resolveOptional(SINGLE, "self")).toBeUndefined()
        expect(resolver.resolveOr(SINGLE, "fallback", "self")).toBe("fallback")
        expect(resolver.isRegistered(SINGLE, "nearest")).toBe(true)
        expect(resolver.isRegistered(SINGLE, "self")).toBe(false)
        expect(() => resolver.resolve(SINGLE, "self")).toThrow('mode "self" reads its own bindings only')
    })

    it("refuses a single registration through the resolver too", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "only" })

        expect(() => Resolver.for(container).resolveAll(TOKEN)).toThrow("Use `resolve`")
    })
})

describe("injectAll parity", () => {
    function collector(token: symbol, mode?: ResolveAllMode): Constructor<{ plugins: string[] }> {
        const Collector = class {
            readonly plugins: string[] = mode === undefined ? injectAll<string>(token) : injectAll<string>(token, mode)
        }

        return Collector as unknown as Constructor<{ plugins: string[] }>
    }

    it("defaults to the whole chain, agreeing with resolveAll", () => {
        const root = new Container()
        root.register({ provide: TOKEN, useValue: "root", multi: true })
        const leaf = root.fork()
        leaf.register({ provide: TOKEN, useValue: "leaf", multi: true })

        const Default = collector(TOKEN)
        const Chained = collector(TOKEN, "chained")
        leaf.register([Default, Chained])

        expect(leaf.resolve(Default).plugins).toEqual(leaf.resolveAll(TOKEN))
        expect(leaf.resolve(Chained).plugins).toEqual(["leaf", "root"])
    })

    it("agrees with resolveAll in nearest mode when the container has contributions of its own", () => {
        const root = new Container()
        root.register({ provide: TOKEN, useValue: "root", multi: true })
        const leaf = root.fork()
        leaf.register({ provide: TOKEN, useValue: "leaf", multi: true })

        const Nearest = collector(TOKEN, "nearest")
        leaf.register(Nearest)

        expect(leaf.resolve(Nearest).plugins).toEqual(["leaf"])
        expect(leaf.resolve(Nearest).plugins).toEqual(leaf.resolveAll(TOKEN, "nearest"))
    })

    it("agrees with resolveAll in nearest mode when the whole chain is empty", () => {
        const container = new Container()
        const Nearest = collector(Symbol("unbound"), "nearest")
        container.register(Nearest)

        expect(container.resolve(Nearest).plugins).toEqual([])
    })

    it("AGREES on an empty own container with a contributing ancestor — every surface, `self` included", () => {
        // This corner used to be the one divergence: the decorator resolved inside inversify's planner,
        // out of reach of any guard, and could not express `self` at all — so its mode union was narrower
        // than `resolveAll`'s (MEASURED, probe-8 8a/8c). `injectAll` is the same read as `resolveAll`,
        // takes the same three modes, and answers identically in all of them.
        const root = new Container()
        root.register({ provide: TOKEN, useValue: "root", multi: true })
        const bare = root.fork()

        const Nearest = collector(TOKEN, "nearest")
        const Self = collector(TOKEN, "self")
        bare.register([Nearest, Self])

        expect(bare.resolve(Nearest).plugins).toEqual(["root"])
        expect(bare.resolveAll(TOKEN, "nearest")).toEqual(["root"])
        expect(Resolver.for(bare).resolveAll(TOKEN, "nearest")).toEqual(["root"])

        // The mode the decorator could not have, now answering the same as every other surface.
        expect(bare.resolve(Self).plugins).toEqual([])
        expect(bare.resolveAll(TOKEN, "self")).toEqual([])
    })

    it("accepts an enum member as readily as the literal", () => {
        const root = new Container()
        root.register({ provide: TOKEN, useValue: "root", multi: true })
        const leaf = root.fork()
        leaf.register({ provide: TOKEN, useValue: "leaf", multi: true })

        const Member = collector(TOKEN, ResolveAllMode.Nearest)
        leaf.register(Member)

        expect(leaf.resolve(Member).plugins).toEqual(["leaf"])
    })
})

describe("factory body read parity", () => {
    // A factory body is the only route into a factory now: the declarative `inject` array is gone, and
    // `inject` / `injectOptional` / `injectAll` are called directly from inside the construction frame.
    // Nothing below asserts a behaviour of the factory boundary; every assertion is that it has none of
    // its own — each read answers exactly as the same call on the container would.

    /** root and leaf both contribute; `bare` is a further fork that contributes nothing of its own. */
    function chain(): { root: Container; leaf: Container; bare: Container } {
        const root = new Container()
        root.register({ provide: TOKEN, useValue: "root", multi: true })
        const leaf = root.fork()
        leaf.register({ provide: TOKEN, useValue: "leaf", multi: true })

        return { root, leaf, bare: leaf.fork() }
    }

    /**
     * Run `read` as a factory body on `container` and return what it produced. A fresh token per call, so
     * a container can be measured several times without forking — forking would move the read position,
     * which is the very thing the mode tests are about.
     */
    function injected(container: Container, read: () => unknown): unknown {
        const token = Symbol("COLLECTOR")
        // Registration goes through react's door, so the factory is the one the module layer would build.
        registerProviders(container, [{ provide: token, useFactory: read }])

        return container.resolve(token)
    }

    /** The message a read throws, so a body read can be pinned against it rather than against a copy. */
    function messageOf(read: () => unknown): string {
        let message: string | undefined
        try {
            read()
        } catch (error) {
            message = (error as Error).message
        }

        expect(message).toBeDefined()
        return message as string
    }

    it("hands a factory the whole chain's collection by default", () => {
        const { leaf } = chain()

        expect(injected(leaf, () => injectAll(TOKEN))).toEqual(["leaf", "root"])
        expect(injected(leaf, () => injectAll(TOKEN))).toEqual(leaf.resolveAll(TOKEN))
        expect(injected(leaf, () => injectAll(TOKEN, ResolveAllMode.Chained))).toEqual(["leaf", "root"])
    })

    it("means by self and nearest exactly what resolveAll means by them", () => {
        const { leaf, bare } = chain()

        expect(injected(leaf, () => injectAll(TOKEN, "self"))).toEqual(["leaf"])
        expect(injected(leaf, () => injectAll(TOKEN, "nearest"))).toEqual(["leaf"])

        // The distinction the two modes exist for. `bare` declares nothing: `self` is own-only and reads
        // `[]`, `nearest` falls back to the nearest CONTRIBUTOR's own bindings — `leaf` alone, never the
        // chain above it, which is what `chained` is for.
        expect(injected(bare, () => injectAll(TOKEN, "self"))).toEqual([])
        expect(injected(bare, () => injectAll(TOKEN, "nearest"))).toEqual(["leaf"])
        expect(injected(bare, () => injectAll(TOKEN))).toEqual(["leaf", "root"])

        for (const mode of ["self", "nearest", "chained"] as const) {
            expect(injected(bare, () => injectAll(TOKEN, mode))).toEqual(bare.resolveAll(TOKEN, mode))
        }
    })

    it("reads [] for a collection point nobody filled, rather than failing the factory", () => {
        const container = new Container()
        const UNFILLED = Symbol("unfilled")

        expect(injected(container, () => injectAll(UNFILLED))).toEqual([])
    })

    it("keeps a bare read meaning one value, nearest, required", () => {
        const SINGLE = Symbol("SINGLE")
        const root = new Container()
        root.register({ provide: SINGLE, useValue: "root" })
        const child = root.fork()

        expect(injected(child, () => inject(SINGLE))).toBe("root")
        expect(injected(child, () => inject(SINGLE, "nearest"))).toBe("root")
    })

    it("carries self onto the single reads too, throwing or not exactly as they do", () => {
        const SINGLE = Symbol("SINGLE")
        const root = new Container()
        root.register({ provide: SINGLE, useValue: "root" })
        const child = root.fork()

        expect(injected(root, () => inject(SINGLE, "self"))).toBe("root")
        expect(() => injected(child, () => inject(SINGLE, "self"))).toThrow(
            messageOf(() => child.resolve(SINGLE, "self"))
        )
        expect(injected(child, () => injectOptional(SINGLE, "self"))).toBeUndefined()
    })

    it("routes the optional read to the safe read, and only that one", () => {
        const MISSING = Symbol("MISSING")
        const container = new Container()

        expect(injected(container, () => injectOptional(MISSING))).toBeUndefined()
        expect(() => injected(container, () => inject(MISSING))).toThrow(messageOf(() => container.resolve(MISSING)))
    })

    it("inherits the collection guard verbatim — injectAll onto a single registration", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "only" })

        // Not a new error about the factory: the message `resolveAll` would have produced, unchanged.
        expect(() => injected(container, () => injectAll(TOKEN))).toThrow(messageOf(() => container.resolveAll(TOKEN)))
    })

    it("inherits the single guard verbatim — a single read onto a collection", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "a", multi: true })

        expect(() => injected(container, () => inject(TOKEN))).toThrow(messageOf(() => container.resolve(TOKEN)))

        // The optional read does not soften it either — `resolveOptional` refuses a collection rather than
        // reporting absence, and the body read is that call.
        expect(() => injected(container, () => injectOptional(TOKEN))).toThrow(
            messageOf(() => container.resolveOptional(TOKEN))
        )
    })

    it("mixes the three reads in one factory body, in order", () => {
        const { leaf } = chain()
        const SINGLE = Symbol("SINGLE")
        const MISSING = Symbol("MISSING")
        leaf.register({ provide: SINGLE, useValue: "one" })

        const HOST = Symbol("HOST")
        registerProviders(leaf, [
            {
                provide: HOST,
                useFactory: () => [inject(SINGLE), injectOptional(MISSING), injectAll(TOKEN, "self")],
            },
        ])

        expect(leaf.resolve(HOST)).toEqual(["one", undefined, ["leaf"]])
    })
})

// The half of the grammar no `it` can reach: what the forms REFUSE. Checked by `npm run
// typecheck:tests`; the same pins run against the published declarations in the consumer fixtures.
// ========================================

class Pinned {}

const OTHER = Symbol("OTHER")

const acceptedProviders: ClassProvider[] = [
    { provide: TOKEN, useClass: Pinned, multi: true },
    { provide: TOKEN, useClass: Pinned, multi: false },
    { useClass: Pinned, multi: false },
]
void acceptedProviders

// @ts-expect-error the provide-less shorthand still cannot join a collection, so `multi: true` needs a `provide`.
const multiShorthand: ClassProvider = { useClass: Pinned, multi: true }
void multiShorthand

// The declarative `inject` array is gone from the react layer too, so the key is an unknown property on
// the factory form — under the form's own name and against the union `registerProviders` takes.

// @ts-expect-error a factory reads its dependencies in its body; there is no `inject` array to declare.
const injectArrayOnFactory: FactoryProvider<string> = { provide: TOKEN, useFactory: () => "x", inject: [TOKEN] }
void injectArrayOnFactory

const injectArrayThroughTheDoor: Provider[] = [
    // @ts-expect-error the same refusal at the registration door, where the union is what gets checked.
    { provide: TOKEN, useFactory: () => "x", inject: [TOKEN] },
]
void injectArrayThroughTheDoor

// @ts-expect-error the variadic signature existed only so the array had somewhere to spread into.
const parameterisedFactory: FactoryProvider<string> = { provide: TOKEN, useFactory: (received: string) => received }
void parameterisedFactory

// `lazy` is the one key react still adds, and ALL FOUR object forms carry it now. A value carries it
// because materializing it is what adopts it; an alias carries it because `lazy` decides whether the owner
// RESOLVES THROUGH it at init, and that ask is what pulls its target into existence — at whichever module
// owns the target, which may not be this one.

const lazyValue: ValueProvider<string> = { provide: TOKEN, useValue: "a", lazy: true }
void lazyValue

const lazyValueThroughTheDoor: Provider[] = [{ provide: TOKEN, useValue: "a", lazy: true }]
void lazyValueThroughTheDoor

// FLIPPED from a `@ts-expect-error`: the alias was the one form the key was refused on.
const lazyExisting: ExistingProvider<string> = { provide: TOKEN, useExisting: OTHER, lazy: true }
void lazyExisting

const lazyExistingThroughTheDoor: Provider[] = [{ provide: TOKEN, useExisting: OTHER, lazy: true }]
void lazyExistingThroughTheDoor

// The limit these pins have, stated rather than assumed: excess-property checking only fires on a FRESH
// object literal. A provider assembled into a variable first and annotated afterwards keeps the key, and
// no annotation catches it — the same gap the kernel's own pins have.
const predeclared = { provide: TOKEN, useFactory: () => "x", inject: [TOKEN] }
const predeclaredEscapes: Provider = predeclared
void predeclaredEscapes
