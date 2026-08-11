import { describe, expect, it, vi } from "vitest"

import { Container } from "../../src/container.js"
import { ResolveAllMode, Scope } from "../../src/container.types.js"
import type { Constructor } from "../../src/container.types.js"
import type { ClassProvider, FactoryProvider, ValueProvider } from "../../src/providers.types.js"
import { inject, injectAll, injectOptional } from "../../src/injector.js"

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
        // The inversion the container-global registry brings: a hook no longer attaches to the entries a
        // token happens to have at attach time, so a collection that grows afterwards is observed whole.
        const seen: string[] = []
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "a", multi: true })
        container.on("afterMaterialize", ({ instance }) => seen.push(instance as string))
        container.register({ provide: TOKEN, useValue: "b", multi: true })

        container.resolveAll(TOKEN)

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

    it("says nothing about a token with no bindings of its own", () => {
        // There is no attach-time refusal left to make: `on` names no token, so a container that
        // registered nothing simply reports nothing.
        const container = new Container()
        const hook = vi.fn()

        container.on("afterMaterialize", hook)

        expect(container.resolveAll(TOKEN)).toEqual([])
        expect(hook).not.toHaveBeenCalled()
    })

    it("reports nothing of its own for a collection made entirely of aliases", () => {
        // Aliases carry no binding: resolving one materializes the TARGET, on the container that
        // registered the target. There is nothing of the collection's own to report.
        class Legacy {}
        const seen: unknown[] = []

        const container = new Container()
        container.register(Legacy)
        container.register({ provide: TOKEN, useExisting: Legacy, multi: true })
        container.on("afterMaterialize", ({ snapshot }) => seen.push(snapshot.token))

        container.resolveAll(TOKEN)

        expect(seen).toEqual([Legacy])
    })

    // There is one observation door and it takes no token. A hook's payload carries the same
    // `EntrySnapshot` `entries()` hands out, so an adoption filter is written in exactly the vocabulary the
    // metadata plane already speaks — just inside the hook rather than beside it.
    it("a singleton-only hook declines a transient member sharing the token", () => {
        // The standing invariant this container inherits: transients never participate in lifecycle.
        // Deciding per BINDING rather than per token is what keeps that true inside a collection, and the
        // snapshot the hook is handed is per binding.
        class Transient {
            readonly name = "transient"
        }

        const mixed = (): Container => {
            const container = new Container()
            container.register({ provide: TOKEN, useValue: { name: "constant" }, multi: true })
            container.register({ provide: TOKEN, useClass: Transient, multi: true, scope: Scope.Transient })
            return container
        }

        const all: string[] = []
        const everything = mixed()
        everything.on("afterMaterialize", ({ instance }) => all.push((instance as Transient).name))

        const retained: string[] = []
        const offered: string[] = []
        const singletons = mixed()
        singletons.on("afterMaterialize", ({ instance, snapshot }) => {
            offered.push((instance as Transient).name)
            if (snapshot.scope !== Scope.Singleton) return
            retained.push((instance as Transient).name)
        })

        for (const container of [everything, singletons]) {
            container.resolveAll(TOKEN)
            container.resolveAll(TOKEN)
            container.resolveAll(TOKEN)
        }

        // `afterMaterialize` reports every construction, transients included.
        expect(all).toEqual(["constant", "transient", "transient", "transient"])

        // The filtering hook sees exactly the same stream — attachment never depended on scope — and it is
        // the early return, not the container, that keeps the transient out of the adopted set.
        expect(offered).toEqual(["constant", "transient", "transient", "transient"])
        expect(retained).toEqual(["constant"])
    })

    it("adopts nothing when the token retains nothing, while still hearing every construction", () => {
        class Transient {}

        const seen: unknown[] = []
        let calls = 0
        const container = new Container()
        container.register({ provide: TOKEN, useClass: Transient, multi: true, scope: Scope.Transient })
        container.register({ provide: TOKEN, useFactory: () => new Transient(), multi: true, scope: Scope.Transient })

        // Not an error: a token whose every binding is transient simply retains nothing.
        container.on("afterMaterialize", ({ instance, snapshot }) => {
            calls += 1
            if (snapshot.scope !== Scope.Singleton) return
            seen.push(instance)
        })
        container.resolveAll(TOKEN)

        expect(calls).toBe(2)
        expect(seen).toEqual([])
    })

    it("keeps every hook on an event, notified in registration order", () => {
        // A container holds a LIST per event rather than one handler, and every `on` appends to it. That is
        // the whole reason a second observer cannot silently unhook the first — an implementation that
        // stored one handler per event would lose all but the last.
        const order: string[] = []

        const container = new Container()
        container.register({ provide: TOKEN, useValue: "v", multi: true })
        container.on("afterMaterialize", ({ instance }) => order.push(`first:${instance as string}`))
        container.on("afterMaterialize", ({ instance }) => order.push(`second:${instance as string}`))
        container.on("afterMaterialize", ({ instance }) => order.push(`third:${instance as string}`))

        container.resolveAll(TOKEN)

        expect(order).toEqual(["first:v", "second:v", "third:v"])
    })

    it("lets an unfiltered and a self-filtering hook share an event", () => {
        const seen: string[] = []

        const container = new Container()
        container.register({ provide: TOKEN, useValue: "v", multi: true })
        container.on("afterMaterialize", ({ instance }) => seen.push(`all:${instance as string}`))
        container.on("afterMaterialize", ({ instance, snapshot }) => {
            if (snapshot.scope !== Scope.Singleton) return
            seen.push(`retained:${instance as string}`)
        })

        container.resolveAll(TOKEN)

        expect(seen).toEqual(["all:v", "retained:v"])
    })

    it("notifies every hook of a transient binding on every construction", () => {
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

    it("observes without intercepting — a hook cannot change what resolve hands out", () => {
        const original = { name: "original" }

        const container = new Container()
        container.register({ provide: TOKEN, useValue: original })

        // The listener signature says `void`, and the dispatcher returns the original whatever a hook does.
        container.on("afterMaterialize", () => ({ name: "replaced" }) as never)
        container.on("afterResolution", () => undefined)

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
            if (snapshot.token !== TOKEN) return
            seen.push((instance as Direct).name)
        })

        container.resolveAll(TOKEN)

        expect(seen).toEqual(["direct"])
    })
})

describe("scopes inside a collection", () => {
    // Scope is per MEMBER, and there is no uniformity rule. There briefly was one: while adoption was
    // filtered per token, a transient sharing a token with a singleton got adopted and accumulated. Since
    // adoption is filtered per binding (`onPredicateResolution`), the shape it forbade no longer breaks
    // anything, so the guard came out — each member simply behaves as it was declared.

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

})

describe("claim precedence", () => {
    class Service {}

    // Two claims, in a fixed order — mode, then alias — and the first one violated is the one reported. A
    // provider that gets both wrong hears about the earlier one, so the message never depends on which
    // check happens to be cheaper.

    it("reports the mode conflict before the alias conflict", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service })
        container.register({ provide: Symbol("ALIAS"), useExisting: TOKEN })

        expect(() => container.register({ provide: TOKEN, useClass: Service, multi: true })).toThrow(
            "is already a single registration on this container"
        )
    })
})

// Read-surface parity
// ========================================
//
// A mode means the same thing on every read that takes it. `injectAll` and a factory's `inject` array are
// the two injection surfaces, and both are pure routing into the container's own reads: neither owns a mode
// set, a default or an error of its own. That is why both carry the whole set — there is no planner between
// a surface and the read it names to narrow what it can express. What the `inject` grammar REFUSES is a
// separate matter, and it is a type-level matter; it is pinned at the bottom of this file.
//
// `Resolver` is a third mirror of the same reads. It moved into this package with the hook system, and its
// parity block lives beside it in `tests/container/resolver.test.ts`.

describe("injectAll parity", () => {
    /**
     * A plain class whose single field is the injection under test. No decorator and no constructor
     * parameter: `injectAll` reads the ambient construction frame, so a field initializer is a legitimate
     * injection site and the class stays something anyone could have written by hand.
     */
    function collector(token: symbol, mode?: ResolveAllMode): Constructor<{ plugins: string[] }> {
        return class {
            // The mode is OMITTED rather than passed as `undefined` when the caller omitted it, so the
            // default-mode case really is the one-argument call.
            readonly plugins = mode === undefined ? injectAll<string>(token) : injectAll<string>(token, mode)
        }
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

    it("AGREES on an empty own container with a contributing ancestor — every surface that has `nearest`", () => {
        // This corner used to be THE divergence, back when injection was planned by machinery we did not
        // own: `Container.resolveAll(token, false)` guarded the ancestor fallback and answered [], while
        // the injection surface resolved out of reach of that guard and answered the ancestor's members.
        //
        // Owner ruling 2026-08-01: conform to the fallback, then name the guard instead of hiding it.
        // `nearest` IS the fallback everywhere, injection included; the guarded read became `self`.
        //
        // The restriction that used to come with that ruling is GONE here. `injectAll` is a bare function
        // that calls `Container.resolveAll` on the declaring container — the same read, no planner in
        // between — so it carries all three modes, `self` included. The two assertions at the end of this
        // test are the ones that could not previously be written.
        const root = new Container()
        root.register({ provide: TOKEN, useValue: "root", multi: true })
        const bare = root.fork()

        const Nearest = collector(TOKEN, "nearest")
        bare.register(Nearest)

        expect(bare.resolve(Nearest).plugins).toEqual(["root"])
        expect(bare.resolveAll(TOKEN, "nearest")).toEqual(["root"])

        // ...and `self` is exactly the mode that answers differently here.
        expect(bare.resolveAll(TOKEN, "self")).toEqual([])

        // Which the injection surface can now say, and it agrees with the read it routes to.
        const Self = collector(TOKEN, "self")
        bare.register(Self)

        expect(bare.resolve(Self).plugins).toEqual([])
        expect(bare.resolve(Self).plugins).toEqual(bare.resolveAll(TOKEN, "self"))
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

describe("factory inject parity", () => {
    // A factory body gets the same three functions a constructor body does, and they are the same
    // one-liners onto `resolveAll` / `resolveOptional` / `resolve` — each with that read's own default mode
    // and, crucially, that read's own errors. Nothing below asserts a behaviour of injection inside a
    // factory; every assertion is that it has none of its own.

    /** root and leaf both contribute; `bare` is a further fork that contributes nothing of its own. */
    function chain(): { root: Container; leaf: Container; bare: Container } {
        const root = new Container()
        root.register({ provide: TOKEN, useValue: "root", multi: true })
        const leaf = root.fork()
        leaf.register({ provide: TOKEN, useValue: "leaf", multi: true })

        return { root, leaf, bare: leaf.fork() }
    }

    /**
     * Run `read` as the whole body of a factory on `container` and return what it produced. A fresh token
     * per call, so a container can be measured several times without forking — forking would move the
     * read position, which is the very thing the mode tests are about.
     */
    function injected(container: Container, read: () => unknown): unknown {
        const token = Symbol("COLLECTOR")
        container.register({ provide: token, useFactory: read })

        return container.resolve(token)
    }

    /** The message a read throws, so an inject entry can be pinned against it rather than against a copy. */
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

    it("keeps a bare inject meaning one value, nearest, required", () => {
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

    it("routes injectOptional to the safe read, and only injectOptional", () => {
        const MISSING = Symbol("MISSING")
        const container = new Container()

        expect(injected(container, () => injectOptional(MISSING))).toBeUndefined()
        expect(() => injected(container, () => inject(MISSING))).toThrow(
            messageOf(() => container.resolve(MISSING))
        )
    })

    it("inherits the collection guard verbatim — injectAll onto a single registration", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "only" })

        // Not a new error about `injectAll`: the message `resolveAll` would have produced, unchanged.
        expect(() => injected(container, () => injectAll(TOKEN))).toThrow(
            messageOf(() => container.resolveAll(TOKEN))
        )
    })

    it("inherits the single guard verbatim — a single read onto a collection", () => {
        const container = new Container()
        container.register({ provide: TOKEN, useValue: "a", multi: true })

        expect(() => injected(container, () => inject(TOKEN))).toThrow(
            messageOf(() => container.resolve(TOKEN))
        )

        // `injectOptional` does not soften it either — `resolveOptional` refuses a collection rather than
        // reporting absence, and the inject call is that call.
        expect(() => injected(container, () => injectOptional(TOKEN))).toThrow(
            messageOf(() => container.resolveOptional(TOKEN))
        )
    })

    it("mixes the three reads in one factory body, in call order", () => {
        const { leaf } = chain()
        const SINGLE = Symbol("SINGLE")
        const MISSING = Symbol("MISSING")
        leaf.register({ provide: SINGLE, useValue: "one" })

        const HOST = Symbol("HOST")
        leaf.register({
            provide: HOST,
            useFactory: () => [inject(SINGLE), injectOptional(MISSING), injectAll(TOKEN, "self")],
        })

        expect(leaf.resolve(HOST)).toEqual(["one", undefined, ["leaf"]])
    })
})

describe("chained order when registration interleaves across the chain", () => {
    // Every other ordering test registers strictly top-down: parent finishes, then child starts. Real
    // wiring does not cooperate — a module registers, a child module registers, and then the parent
    // registers more as a later feature loads. So which order wins, the container's or the clock's?
    //
    // The container's, on both axes, and the two are independent. `#contributors` walks the chain nearest
    // first, so ALL of the child's members precede ALL of the parent's however late either arrived; and
    // within one container `#entries` preserves that container's own registration order. A member added to
    // the parent after the child had already contributed therefore lands last among the parent's, not last
    // overall and not next to the child's. Wall-clock order is not a thing `resolveAll` can see.

    const MEMBERS = Symbol("INTERLEAVED")

    function interleaved(): { parent: Container; child: Container } {
        const parent = new Container()
        parent.register({ provide: MEMBERS, useValue: "parent-1", multi: true })
        parent.register({ provide: MEMBERS, useValue: "parent-2", multi: true })

        const child = parent.fork()
        child.register({ provide: MEMBERS, useValue: "child-1", multi: true })

        // The late arrival, after the child has already contributed.
        parent.register({ provide: MEMBERS, useValue: "parent-3", multi: true })
        child.register({ provide: MEMBERS, useValue: "child-2", multi: true })

        return { parent, child }
    }

    it("groups by container nearest-first, then by each container's own registration order", () => {
        const { child } = interleaved()

        expect(child.resolveAll(MEMBERS, ResolveAllMode.Chained)).toEqual([
            "child-1",
            "child-2",
            "parent-1",
            "parent-2",
            "parent-3",
        ])
    })

    it("is the default a bare resolveAll uses", () => {
        const { child } = interleaved()

        expect(child.resolveAll(MEMBERS)).toEqual(child.resolveAll(MEMBERS, ResolveAllMode.Chained))
    })

    it("reads one container's bindings under `nearest`, and this one's under `self`", () => {
        const { parent, child } = interleaved()

        // `nearest` stops at the first contributor — the child — and does NOT accumulate the parent's.
        expect(child.resolveAll(MEMBERS, ResolveAllMode.Nearest)).toEqual(["child-1", "child-2"])
        expect(child.resolveAll(MEMBERS, ResolveAllMode.Self)).toEqual(["child-1", "child-2"])

        // From the parent, the child's contributions are simply not in the chain at all.
        expect(parent.resolveAll(MEMBERS, ResolveAllMode.Chained)).toEqual(["parent-1", "parent-2", "parent-3"])
    })

    it("puts a fork made AFTER the parent finished registering in the same place", () => {
        // The fork point is not a snapshot: a child forked late sees the parent's whole list, in the
        // parent's order, exactly as one forked early does.
        const parent = new Container()
        parent.register({ provide: MEMBERS, useValue: "parent-1", multi: true })
        parent.register({ provide: MEMBERS, useValue: "parent-2", multi: true })
        parent.register({ provide: MEMBERS, useValue: "parent-3", multi: true })

        const late = parent.fork()
        late.register({ provide: MEMBERS, useValue: "child-1", multi: true })

        expect(late.resolveAll(MEMBERS, ResolveAllMode.Chained)).toEqual([
            "child-1",
            "parent-1",
            "parent-2",
            "parent-3",
        ])
    })
})

// The half of the grammar no `it` can reach: what the two arms REFUSE. Checked by `pnpm run
// typecheck:tests` against src; the emitted declarations carry these very shapes, so the same pins are
// what a consumer gets.
// ========================================

class Pinned {}

const acceptedProviders: ClassProvider[] = [
    { provide: TOKEN, useClass: Pinned, multi: true },
    { provide: TOKEN, useClass: Pinned, multi: false },
    { useClass: Pinned, multi: false },
]
void acceptedProviders

// @ts-expect-error the provide-less shorthand still cannot join a collection, so `multi: true` needs a `provide`.
const multiShorthand: ClassProvider = { useClass: Pinned, multi: true }
void multiShorthand

// The declarative `inject` array is gone (owner ruling), and with it the whole `FactoryDependency` grammar
// these pins used to cover. What is left to pin is the removal itself, from both ends: the key is unknown,
// and the factory is a zero-argument function.

const acceptedFactories: FactoryProvider[] = [
    { provide: TOKEN, useFactory: () => injectAll(TOKEN) },
    { provide: TOKEN, useFactory: () => 1, multi: true },
    { provide: TOKEN, useFactory: () => 1, scope: Scope.Transient },
]
void acceptedFactories

// @ts-expect-error `inject` is not a key on any provider form any more — a factory injects in its body.
const injectArray: FactoryProvider = { provide: TOKEN, useFactory: () => 1, inject: [TOKEN] }
void injectArray

// @ts-expect-error and it is not one on the four non-factory forms either, which never had the array.
const injectArrayOnValue: ValueProvider = { provide: TOKEN, useValue: 1, inject: [TOKEN] }
void injectArrayOnValue

// @ts-expect-error nothing is passed to a factory, so a factory that declares a parameter is rejected.
const parameterisedFactory: FactoryProvider = { provide: TOKEN, useFactory: (dependency: unknown) => dependency }
void parameterisedFactory

// The same two refusals through `register`, where the object literal meets the `Provider` union rather than
// one named member — the spelling a consumer actually writes. Never called: the pin is the compile.
function registrationPins(container: Container): void {
    // @ts-expect-error excess property against every arm of the union, since no arm declares `inject`.
    container.register({ provide: TOKEN, useFactory: () => 1, inject: [TOKEN] })

    // @ts-expect-error a factory with a parameter matches no arm — `useFactory` is `() => T`.
    container.register({ provide: TOKEN, useFactory: (dependency: unknown) => dependency })
}
void registrationPins
