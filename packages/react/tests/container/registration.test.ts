import { describe, expect, it } from "vitest"

import { Container, Scope } from "@remodulo/container"
import type { Constructor } from "@remodulo/container"
import type { Provider } from "../../src/core/provider.types.js"
// One token, one registration per container.
// ========================================
//
// A duplicate is a mistake, never an override: `register` throws for every provider shape. The same token
// in a parent and in a `fork()` is a different matter — that is shadowing, and it is legal.


const ALREADY_REGISTERED = /is already registered on this container\. One token, one registration/

describe("duplicate registration", () => {
    it("throws for the bare constructor shorthand", () => {
        class Service {}

        const container = new Container()
        container.register(Service)

        expect(() => container.register(Service)).toThrow(ALREADY_REGISTERED)
        expect(() => container.register(Service)).toThrow(/Token Service is already registered/)
    })

    it("throws for useClass", () => {
        class Service {}
        const TOKEN = Symbol("dup-class")

        const container = new Container()
        container.register({ provide: TOKEN, useClass: Service })

        expect(() => container.register({ provide: TOKEN, useClass: Service })).toThrow(ALREADY_REGISTERED)
    })

    it("throws for useValue", () => {
        const TOKEN = Symbol("dup-value")

        const container = new Container()
        container.register({ provide: TOKEN, useValue: "first" })

        expect(() => container.register({ provide: TOKEN, useValue: "second" })).toThrow(ALREADY_REGISTERED)
        expect(container.resolve(TOKEN)).toBe("first")
    })

    it("throws for useFactory", () => {
        const TOKEN = Symbol("dup-factory")

        const container = new Container()
        container.register({ provide: TOKEN, useFactory: () => 1 })

        expect(() => container.register({ provide: TOKEN, useFactory: () => 2 })).toThrow(ALREADY_REGISTERED)
    })

    it("throws for useExisting", () => {
        const TARGET = Symbol("target")
        const ALIAS = Symbol("dup-alias")

        const container = new Container()
        container.register([
            { provide: TARGET, useValue: "target" },
            { provide: ALIAS, useExisting: TARGET },
        ])

        expect(() => container.register({ provide: ALIAS, useExisting: TARGET })).toThrow(ALREADY_REGISTERED)
    })

    it("throws for the provide-less useClass shorthand after the bare constructor", () => {
        class Service {}

        const container = new Container()
        container.register(Service)

        expect(() => container.register({ useClass: Service })).toThrow(ALREADY_REGISTERED)
        expect(() => container.register({ useClass: Service })).toThrow(/Token Service is already registered/)
    })

    it("throws for the provide-less useClass shorthand after the equivalent provide + useClass", () => {
        class Service {}

        const container = new Container()
        container.register({ provide: Service, useClass: Service })

        expect(() => container.register({ useClass: Service, scope: Scope.Transient })).toThrow(ALREADY_REGISTERED)
    })

    it("throws for anything registering the class again after the provide-less useClass shorthand", () => {
        class Service {}

        const shapes: Provider[] = [
            Service,
            { useClass: Service },
            { useClass: Service, lazy: true },
            { provide: Service, useClass: Service },
            { provide: Service, useValue: "value" },
        ]

        for (const shape of shapes) {
            const container = new Container()
            container.register({ useClass: Service })

            expect(() => container.register(shape)).toThrow(ALREADY_REGISTERED)
        }
    })

    it("throws across differing shapes for the same token", () => {
        class Service {}
        const TOKEN = Symbol("dup-mixed")
        const OTHER = Symbol("other")

        const shapes: Provider[] = [
            { provide: TOKEN, useValue: "value" },
            { provide: TOKEN, useFactory: () => "factory" },
            { provide: TOKEN, useExisting: OTHER },
            { provide: TOKEN, useClass: Service, scope: Scope.Transient },
            { provide: TOKEN, useClass: Service, lazy: true },
        ]

        for (const shape of shapes) {
            const container = new Container()
            container.register({ provide: OTHER, useValue: "other" })
            container.register({ provide: TOKEN, useClass: Service })

            expect(() => container.register(shape)).toThrow(ALREADY_REGISTERED)
        }
    })

    it("throws on a duplicate inside a single array registration", () => {
        const TOKEN = Symbol("dup-in-array")
        const container = new Container()

        expect(() =>
            container.register([
                { provide: TOKEN, useValue: "first" },
                { provide: TOKEN, useValue: "second" },
            ])
        ).toThrow(ALREADY_REGISTERED)

        // The providers before the duplicate are already bound — register is not transactional.
        expect(container.resolve(TOKEN)).toBe("first")
    })

    it("names a string token verbatim in the message", () => {
        const container = new Container()
        container.register({ provide: "config", useValue: 1 })

        expect(() => container.register({ provide: "config", useValue: 2 })).toThrow(/^Token config is already/)
    })

    it("throws even when the token is registered by an ancestor and re-registered here later", () => {
        const TOKEN = Symbol("shadow-then-dup")
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })

        const child = parent.fork()
        child.register({ provide: TOKEN, useValue: "child" })

        expect(() => child.register({ provide: TOKEN, useValue: "again" })).toThrow(ALREADY_REGISTERED)
    })
})

describe("shadowing across a fork", () => {
    it("allows the same token in a parent and a child, nearest wins", () => {
        const TOKEN = Symbol("shadowed")
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })

        const child = parent.fork()
        expect(() => child.register({ provide: TOKEN, useValue: "child" })).not.toThrow()

        expect(child.resolve(TOKEN)).toBe("child")
        expect(parent.resolve(TOKEN)).toBe("parent")
    })

    it("shadows with a different provider shape and a different instance", () => {
        class Service {
            constructor(readonly origin = "class") {}
        }
        const TOKEN = Symbol("shadow-shape")

        const parent = new Container()
        parent.register({ provide: TOKEN, useClass: Service })

        const child = parent.fork()
        child.register({ provide: TOKEN, useValue: { origin: "value" } })

        expect(parent.resolve<Service>(TOKEN)).toBeInstanceOf(Service)
        expect(child.resolve<Service>(TOKEN)).toEqual({ origin: "value" })
    })

    it("keeps shadowing local — a sibling fork still sees the ancestor binding", () => {
        const TOKEN = Symbol("sibling")
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })

        const shadowed = parent.fork()
        shadowed.register({ provide: TOKEN, useValue: "shadowed" })
        const sibling = parent.fork()

        expect(shadowed.resolve(TOKEN)).toBe("shadowed")
        expect(sibling.resolve(TOKEN)).toBe("parent")
    })

    it("shadows at any depth, and a grandchild sees the nearest declaration", () => {
        const TOKEN = Symbol("deep")
        const root = new Container()
        root.register({ provide: TOKEN, useValue: "root" })
        const middle = root.fork()
        middle.register({ provide: TOKEN, useValue: "middle" })
        const leaf = middle.fork()

        expect(leaf.resolve(TOKEN)).toBe("middle")
        expect(leaf.isRegistered(TOKEN, "self")).toBe(false)
    })

    it("gives each fork its own singleton when both declare the token", () => {
        const built: string[] = []
        class Service {
            constructor() {
                built.push("built")
            }
        }

        const parent = new Container()
        parent.register(Service)
        const child = parent.fork()
        child.register(Service)

        const fromParent = parent.resolve(Service)
        const fromChild = child.resolve(Service)

        expect(fromChild).not.toBe(fromParent)
        expect(built).toHaveLength(2)
    })

    it("fork() does not copy registrations backwards", () => {
        const TOKEN = Symbol("child-only")
        const parent = new Container()
        const child = parent.fork()
        child.register({ provide: TOKEN, useValue: "child" })

        expect(parent.isRegistered(TOKEN)).toBe(false)
        expect(child.isRegistered(TOKEN)).toBe(true)
    })
})
