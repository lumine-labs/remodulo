import { describe, expect, it, vi } from "vitest"

import { Container } from "../../src/container.js"
import { Resolver } from "../../src/resolver.js"
import { Scope } from "../../src/container.types.js"
import { inject, injectContainer, injectResolver, runInInjectionContext } from "../../src/injector.js"

// `injectResolver` — the frame's anchor, minus the registration door.
// ========================================
//
// `injectContainer` hands a service its declaring container, reads AND registrations. This hands back the
// same anchor's read-and-observe half, for the constructor that needs to resolve or observe something it
// cannot name at registration time and has no business registering into.
//
// It is a reader like the other four, so everything else about it is the frame's ordinary contract: the
// declaring-container rule (§1), the sites a frame is open at (§2), and a throw rather than a null outside
// one (§3).

const TOKEN = Symbol("TOKEN")

describe("which container it views", () => {
    it("is the DECLARING container, not the one the read started from", () => {
        // The same pin `injectContainer` carries, for the same reason: `Service` lives on the parent, so it
        // constructs under a frame anchored at the parent however deep the descendant that asked for it.
        let seen: unknown
        class Service {
            constructor() {
                seen = injectResolver().resolve(TOKEN)
            }
        }

        const parent = new Container()
        parent.register([{ provide: TOKEN, useValue: "parent" }, Service])
        const child = parent.fork()
        child.register({ provide: TOKEN, useValue: "child" })

        child.resolve(Service)

        expect(seen).toBe("parent")
    })

    it("is the descendant's world when the descendant is the one that declared the binding", () => {
        // The other half of the same rule: shadowing anchors at the shadow, so a child-declared service
        // gets a resolver over the child — the same world its own injections came from.
        class Service {
            readonly viaInject = inject<string>(TOKEN)
            readonly viaResolver = injectResolver().resolve<string>(TOKEN)
        }

        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })
        const child = parent.fork()
        child.register([{ provide: TOKEN, useValue: "child" }, Service])

        const service = child.resolve(Service)

        expect(service.viaResolver).toBe(service.viaInject)
        expect(service.viaResolver).toBe("child")
    })

    it("views the anchor's whole chain, parent included", () => {
        const OWN = Symbol("OWN")
        class Service {
            readonly resolver = injectResolver()
        }

        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })
        const child = parent.fork()
        child.register([{ provide: OWN, useValue: "own" }, Service])

        const { resolver } = child.resolve(Service)

        expect(resolver.resolve(OWN)).toBe("own")
        expect(resolver.resolve(TOKEN)).toBe("parent")
        expect(resolver.isRegistered(TOKEN, "self")).toBe(false)
    })

    it("follows a useExisting alias to the TARGET's declaring container", () => {
        const ALIAS = Symbol("ALIAS")
        const TARGET = Symbol("TARGET")

        class Service {
            readonly resolver = injectResolver()
        }

        const root = new Container()
        root.register([
            { provide: TOKEN, useValue: "root" },
            { provide: TARGET, useClass: Service },
        ])
        const child = root.fork()
        child.register([
            { provide: ALIAS, useExisting: TARGET },
            { provide: TOKEN, useValue: "child" },
        ])

        expect(child.resolve<Service>(ALIAS).resolver.resolve(TOKEN)).toBe("root")
    })

    it("views the same container `injectContainer` hands back, in the same frame", () => {
        // Equivalent BY CONSTRUCTION: both read `frame.container`, and one of them then asks
        // `Resolver.for` about it. What differs is the surface, not the anchor.
        class Probe {
            readonly container = injectContainer()
            readonly resolver = injectResolver()
        }

        const container = new Container()
        container.register([{ provide: TOKEN, useValue: "value" }, Probe])

        const probe = container.resolve(Probe)

        expect(probe.container).toBe(container)
        expect(probe.resolver.resolve(TOKEN)).toBe(probe.container.resolve(TOKEN))
        expect(probe.resolver.registrations()).toEqual(probe.container.registrations())
    })

    it("returns the CANONICAL resolver, the same instance on every call", () => {
        class Probe {
            readonly first = injectResolver()
            readonly second = injectResolver()
        }

        const container = new Container()
        container.register([{ provide: TOKEN, useValue: "value" }, Probe])

        const probe = container.resolve(Probe)

        expect(probe.first).toBeInstanceOf(Resolver)
        expect(probe.first).toBe(probe.second)
        expect(probe.first).toBe(Resolver.for(container))
    })

    it("is `Resolver.for` of the anchor, and the anchor is the declaring container", () => {
        // Both halves in one cell: which container is looked up, and that the lookup is the canonical one.
        class Service {
            readonly resolver = injectResolver()
        }

        const parent = new Container()
        parent.register(Service)
        const child = parent.fork()

        const injected = child.resolve(Service).resolver

        expect(injected).toBe(Resolver.for(parent))
        expect(injected).not.toBe(Resolver.for(child))
    })

    it("hands two services declared on one container the same resolver", () => {
        class First {
            readonly resolver = injectResolver()
        }
        class Second {
            readonly resolver = injectResolver()
        }

        const container = new Container()
        container.register([First, Second])

        expect(container.resolve(First).resolver).toBe(container.resolve(Second).resolver)
    })
})

describe("the sites it works at", () => {
    it("works in a field initializer", () => {
        class Service {
            readonly resolver = injectResolver()
        }

        const container = new Container()
        container.register([{ provide: TOKEN, useValue: "value" }, Service])

        expect(container.resolve(Service).resolver.resolve(TOKEN)).toBe("value")
    })

    it("works in a constructor body", () => {
        class Service {
            readonly resolver: Resolver
            constructor() {
                this.resolver = injectResolver()
            }
        }

        const container = new Container()
        container.register([{ provide: TOKEN, useValue: "value" }, Service])

        expect(container.resolve(Service).resolver.resolve(TOKEN)).toBe("value")
    })

    it("works in a useFactory body", () => {
        const BUILT = Symbol("BUILT")

        const container = new Container()
        container.register([
            { provide: TOKEN, useValue: "value" },
            { provide: BUILT, useFactory: () => ({ resolver: injectResolver() }) },
        ])

        expect(container.resolve<{ resolver: Resolver }>(BUILT).resolver.resolve(TOKEN)).toBe("value")
    })

    it("works under runInInjectionContext, viewing the container it was passed", () => {
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })
        const child = parent.fork()
        child.register({ provide: TOKEN, useValue: "child" })

        expect(runInInjectionContext(parent, () => injectResolver().resolve(TOKEN))).toBe("parent")
        expect(runInInjectionContext(child, () => injectResolver().resolve(TOKEN))).toBe("child")
    })

    it("works under Container.construct, viewing the container it was called on", () => {
        class Unregistered {
            readonly resolver = injectResolver()
        }

        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })
        const child = parent.fork()
        child.register({ provide: TOKEN, useValue: "child" })

        expect(parent.construct(Unregistered).resolver.resolve(TOKEN)).toBe("parent")
        expect(child.construct(Unregistered).resolver.resolve(TOKEN)).toBe("child")
        expect(parent.isRegistered(Unregistered)).toBe(false)
    })
})

describe("outside a construction frame", () => {
    it("throws rather than returning null", () => {
        expect(() => injectResolver()).toThrow(/was called outside a construction frame/)
    })

    it("prints the shared catalog entry, naming itself and no token", () => {
        // It takes no token, so the call prints bare — `injectResolver()`, not `injectResolver(TOKEN)`.
        // The rest is the same message the other readers print, because it is the same error path.
        const message = ((): string => {
            try {
                injectResolver()
                return ""
            } catch (error) {
                return (error as Error).message
            }
        })()

        expect(message.startsWith("injectResolver() was called outside a construction frame.")).toBe(true)
        expect(message).toMatch(/constructor body, a field initializer, or a `useFactory` body/)
        expect(message).toMatch(/BEFORE the first `await`/)
        expect(message).toMatch(/open a frame explicitly with `runInInjectionContext`/)
        expect(message).toMatch(/two copies of @remodulo\/container in one process/)
    })

    it("carries the caller on the error, like the other readers", () => {
        const thrown = ((): { code?: string; caller?: string } => {
            try {
                injectResolver()
                return {}
            } catch (error) {
                return error as { code?: string; caller?: string }
            }
        })()

        expect(thrown.code).toBe("REMODULO/INJECTION_CONTEXT")
        expect(thrown.caller).toBe("injectResolver")
    })

    it("is gone again once the construction that opened the frame returns", () => {
        class Service {
            readonly resolver = injectResolver()
        }

        const container = new Container()
        container.register(Service)
        container.resolve(Service)

        expect(() => injectResolver()).toThrow(/outside a construction frame/)
    })
})

describe("the resolver it returns is live", () => {
    it("registers a hook on the declaring container, not on a view of it", () => {
        // The whole point of handing out `on` here: a service observes the container it was declared on,
        // from inside its own construction, and the hook is that container's for as long as it lives.
        const LATER = Symbol("LATER")
        const seen: unknown[] = []

        class Observer {
            constructor() {
                injectResolver().on("afterMaterialize", ({ instance }) => seen.push(instance))
            }
        }

        const container = new Container()
        container.register([Observer, { provide: LATER, useClass: class {}, scope: Scope.Transient }])
        const observer = container.resolve(Observer)

        // Reads made straight on the container reach it — a resolver-attached hook is the container's.
        const first = container.resolve(LATER)
        const second = container.resolve(LATER)

        // The observer's OWN materialization is in the list, and first: the hook was attached during the
        // constructor, and `afterMaterialize` runs after that constructor returns.
        expect(seen).toEqual([observer, first, second])
    })

    it("attaches to the DECLARING container when a descendant drives the construction", () => {
        class Observer {
            constructor() {
                injectResolver().on("afterMaterialize", ({ snapshot }) => seen.push(snapshot.token))
            }
        }
        const seen: unknown[] = []
        const PARENT_OWNED = Symbol("PARENT_OWNED")
        const CHILD_OWNED = Symbol("CHILD_OWNED")

        const parent = new Container()
        parent.register([Observer, { provide: PARENT_OWNED, useValue: "parent" }])
        const child = parent.fork()
        child.register({ provide: CHILD_OWNED, useValue: "child" })

        child.resolve(Observer)
        child.resolve(CHILD_OWNED)
        child.resolve(PARENT_OWNED)

        // The hook went to the PARENT, because that is where `Observer` is declared. So it hears the
        // observer's own materialization and the parent-owned token's, and hears nothing of the entry the
        // child declared — even though the child is what drove all three reads.
        expect(seen).toEqual([Observer, PARENT_OWNED])
    })

    it("hands back the disposer, so a service can detach what it attached", () => {
        const LATER = Symbol("LATER")
        const hook = vi.fn()

        class Observer {
            readonly detach = injectResolver().on("afterMaterialize", hook)
        }

        const container = new Container()
        container.register([Observer, { provide: LATER, useClass: class {}, scope: Scope.Transient }])
        const observer = container.resolve(Observer)

        // One for the observer's own materialization, one for the transient read after it.
        container.resolve(LATER)
        expect(hook).toHaveBeenCalledTimes(2)

        observer.detach()
        container.resolve(LATER)
        expect(hook).toHaveBeenCalledTimes(2)
    })

    it("sees registrations made after the construction that minted it", () => {
        const LATE = Symbol("LATE")
        class Service {
            readonly resolver = injectResolver()
        }

        const container = new Container()
        container.register(Service)
        const { resolver } = container.resolve(Service)

        expect(resolver.isRegistered(LATE)).toBe(false)
        container.register({ provide: LATE, useValue: "installed" })

        expect(resolver.resolve(LATE)).toBe("installed")
    })

    it("offers no registration door, which is the difference from injectContainer", () => {
        class Service {
            readonly resolver = injectResolver()
        }

        const container = new Container()
        container.register(Service)

        const { resolver } = container.resolve(Service)
        for (const name of ["register", "fork", "construct"]) {
            expect(name in resolver, `Resolver still exposes \`${name}\``).toBe(false)
        }
    })
})
