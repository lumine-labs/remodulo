import { describe, expect, it } from "vitest"

import { Container, Scope, inject } from "@remodulo/container"
import type { Provider } from "../../src/core/provider.types.js"
import { makeApp, tracked } from "../setup/helpers.js"

// afterMaterialize — the hook the module lifecycle is built on.
// ========================================
//
// It reports instances at construction time, on the container that owns the binding. Attachment is
// container-global and takes no token, so a hook that cares about one binding says so in its first line.
// Everything the lifecycle knows about "what belongs to this module" comes from here.

describe("afterMaterialize", () => {
    it("fires once per constructed singleton, however often it is resolved", () => {
        class Service {}
        const seen: unknown[] = []

        const container = new Container()
        container.register(Service)
        container.on("afterMaterialize", ({ instance }) => seen.push(instance))

        const first = container.resolve(Service)
        container.resolve(Service)
        container.resolve(Service)

        expect(seen).toEqual([first])
    })

    it("fires for a useValue binding on first resolve only", () => {
        const value = { kind: "constant" }
        const TOKEN = Symbol("constant")
        const seen: unknown[] = []

        const container = new Container()
        container.register({ provide: TOKEN, useValue: value })
        container.on("afterMaterialize", ({ instance }) => seen.push(instance))

        container.resolve(TOKEN)
        container.resolve(TOKEN)

        expect(seen).toEqual([value])
    })

    it("fires for a useFactory binding", () => {
        const TOKEN = Symbol("factory")
        const seen: unknown[] = []

        const container = new Container()
        container.register({ provide: TOKEN, useFactory: () => ({ built: true }) })
        container.on("afterMaterialize", ({ instance }) => seen.push(instance))

        const resolved = container.resolve(TOKEN)
        container.resolve(TOKEN)

        expect(seen).toEqual([resolved])
    })

    it("does not fire until something resolves the token", () => {
        class Service {}
        const seen: unknown[] = []

        const container = new Container()
        container.register(Service)
        container.on("afterMaterialize", ({ instance }) => seen.push(instance))

        expect(seen).toEqual([])
    })

    it("fires on the owning container when a descendant resolves the binding", () => {
        class Service {}
        const seen: string[] = []

        const owner = new Container()
        owner.register(Service)
        owner.on("afterMaterialize", () => seen.push("owner"))

        const grandchild = owner.fork().fork()
        const resolved = grandchild.resolve(Service)

        expect(seen).toEqual(["owner"])
        expect(resolved).toBe(owner.resolve(Service))
        // Still once — the second resolve above hits the cached singleton.
        expect(seen).toEqual(["owner"])
    })

    it("reports a dependency before the instance that injected it", () => {
        const B = Symbol("B")
        class Dependency {}
        class Dependent {
            readonly dependency = inject<unknown>(B)
        }

        const order: unknown[] = []
        const container = new Container()
        container.register([{ provide: B, useClass: Dependency }, Dependent])
        container.on("afterMaterialize", ({ snapshot }) => order.push(snapshot.token))

        container.resolve(Dependent)

        expect(order).toEqual([B, Dependent])
    })

    it("fires per instance for a transient binding", () => {
        class Service {}
        const TOKEN = Symbol("transient")
        const seen: unknown[] = []

        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service, scope: Scope.Transient })
        container.on("afterMaterialize", ({ instance }) => seen.push(instance))

        const first = container.resolve(TOKEN)
        const second = container.resolve(TOKEN)
        const third = container.resolve(TOKEN)

        expect(seen).toEqual([first, second, third])
        expect(new Set(seen).size).toBe(3)
    })

    it("never fires for an alias, and fires for the target it redirects to", () => {
        class Service {}
        const ALIAS = Symbol("alias")
        const seen: unknown[] = []

        const container = new Container()
        container.register([Service, { provide: ALIAS, useExisting: Service }])
        container.on("afterMaterialize", ({ snapshot }) => seen.push(snapshot.token))

        container.resolve(ALIAS)

        // An alias owns no binding and constructs nothing, so the only materialization is the target's —
        // which is why the lifecycle needs no alias guard on the payload it filters.
        expect(seen).toEqual([Service])
    })

    it("reports the same instance the caller receives", () => {
        class Service {
            readonly id = "service"
        }
        let reported: unknown

        const container = new Container()
        container.register(Service)
        container.on("afterMaterialize", ({ instance }) => {
            reported = instance
        })

        expect(container.resolve(Service)).toBe(reported)
    })

    it("stays silent on a container that only reaches the binding through the chain", () => {
        const TOKEN = Symbol("upward")
        const parentValue = { from: "parent" }
        const parentSeen: unknown[] = []
        const childSeen: unknown[] = []

        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: parentValue })
        parent.on("afterMaterialize", ({ instance }) => parentSeen.push(instance))

        const child = parent.fork()
        child.on("afterMaterialize", ({ instance }) => childSeen.push(instance))

        // There is no attach-time refusal left to lean on — `on` takes no token, so there is no token for
        // it to refuse over. The same guarantee arrives at the other end: the child owns no binding for
        // TOKEN, so no construction of it is ever reported to the child.
        expect(child.resolve(TOKEN)).toEqual({ from: "parent" })
        expect(childSeen).toEqual([])
        expect(parentSeen).toEqual([parentValue])
    })

    /**
     * Materialization is reported by the OWNER. A descendant that shadows a token owns a different binding,
     * so the ancestor's hook never fires for it: each container hears only about instances its own bindings
     * produced, whichever container the resolution was requested from.
     *
     * That is what makes shadowing safe for the lifecycle. A hook matched by token across the chain would
     * mean a module shadowing an ancestor's token got its instance adopted by the ancestor's lifecycle too
     * — destroyed on the ancestor's schedule, not its own.
     */
    it("does not fire an ancestor's hook for a shadowing binding resolved below it", () => {
        const TOKEN = Symbol("shadowed")
        const parentValue = { from: "parent" }
        const childValue = { from: "child" }
        const parentSeen: unknown[] = []
        const childSeen: unknown[] = []

        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: parentValue })
        parent.on("afterMaterialize", ({ instance }) => parentSeen.push(instance))

        const child = parent.fork()
        child.register({ provide: TOKEN, useValue: childValue })
        child.on("afterMaterialize", ({ instance }) => childSeen.push(instance))

        child.resolve(TOKEN)

        // The report goes to the owner, so the ancestor never sees an instance it does not own.
        expect(childSeen).toEqual([childValue])
        expect(parentSeen).toEqual([])

        parent.resolve(TOKEN)
        expect(parentSeen).toEqual([parentValue])
        expect(childSeen).toEqual([childValue])
    })
})

// Multicast — observing never displaces
// ========================================
//
// Inversify's `onActivation` REPLACES a binding's handler rather than chaining it (measured in
// scratch/probe-multiprovider-7-double-activation.ts). The container keeps one list per event and walks a
// copy of it, so hooks accumulate. Everything below is that contract.

describe("multicast", () => {
    it("lets user code observe a module-owned token WITHOUT unhooking the module's adoption", async () => {
        // THE regression test. A module arms one hook during init to adopt what its container builds.
        // Before the list, any later observation on one of those tokens replaced the module's listener and
        // the service silently stopped receiving its lifecycle — a bug with no error and no failing
        // assertion anywhere near the cause. If this test ever goes away, that trap comes back.
        const log: string[] = []
        const Service = tracked(log, "S")
        const TOKEN = Symbol("module-owned")

        const module = makeApp({ providers: [{ provide: TOKEN, useClass: Service, lazy: true } as Provider] })
        module.mount()

        // User code, well after the module armed its own hook during init.
        const seen: unknown[] = []
        module.container.on("afterMaterialize", ({ snapshot, instance }) => {
            if (snapshot.token === TOKEN) seen.push(instance)
        })

        const instance = module.container.resolve(TOKEN)

        // The user's hook fired...
        expect(seen).toEqual([instance])

        // ...and the module still adopted it — caught up through init and mount on arrival, then the rest
        // of the lifecycle.
        module.unmount()
        await module.destroy()

        expect(Service.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
        expect(log).toEqual(["S:ctor", "S:init", "S:mount", "S:unmount", "S:destroy"])
    })

    it("survives the eager path too — observation added after a module already built its instance", async () => {
        const log: string[] = []
        const Service = tracked(log, "S")
        const TOKEN = Symbol("module-owned-eager")

        const module = makeApp({ providers: [{ provide: TOKEN, useClass: Service } as Provider] })
        module.mount()

        // The instance already exists, so nothing fires for this hook — but attaching it must not disturb
        // the adoption that already happened either.
        const seen: unknown[] = []
        module.container.on("afterMaterialize", ({ snapshot, instance }) => {
            if (snapshot.token === TOKEN) seen.push(instance)
        })
        module.container.resolve(TOKEN)

        expect(seen).toEqual([])

        module.unmount()
        await module.destroy()

        expect(Service.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })

    it("notifies observers in attach order", () => {
        const order: string[] = []
        const TOKEN = Symbol("ordered")

        const container = new Container()
        container.register({ provide: TOKEN, useValue: "v" })
        container.on("afterMaterialize", () => order.push("first"))
        container.on("afterMaterialize", () => order.push("second"))
        container.on("afterMaterialize", () => order.push("third"))

        container.resolve(TOKEN)

        expect(order).toEqual(["first", "second", "third"])
    })

    it("does not drag a hook attached mid-notification into the walk that is already running", () => {
        const order: string[] = []
        const TOKEN = Symbol("reentrant")

        class Service {}

        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service, scope: Scope.Transient })
        container.on("afterMaterialize", () => {
            order.push("first")
            container.on("afterMaterialize", () => order.push("late"))
        })

        container.resolve(TOKEN)
        expect(order).toEqual(["first"])

        // It joins for the next construction, which for a transient is the very next read.
        order.length = 0
        container.resolve(TOKEN)
        expect(order).toEqual(["first", "late"])
    })
})
