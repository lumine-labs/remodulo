import { describe, expect, it } from "vitest"

import { Container } from "../../src/container.js"
import { ResolveAllMode, ResolveMode } from "../../src/container.types.js"
import { inject, injectAll, injectOptional } from "../../src/injector.js"

// The declaring-container rule.
// ========================================
//
// Two structures, easily confused, and this file is the difference between them:
//
//   the container CHAIN  — where bindings can be found. A fork sees its ancestors' registrations.
//   the frame STACK      — who is being built right now, and on whose behalf. One frame per construction.
//
// A read starts anywhere in the chain, but the frame it opens is anchored at the container that DECLARED
// the binding it found. So a service registered on a parent constructs as the parent, whichever descendant
// asked for it: its own `inject` calls cannot see the descendant's registrations, and its singleton is
// cached on the parent. That is what makes a module's providers safe to share downward — a shared instance
// cannot end up wired to one child's overrides and handed to another.

const TOKEN = Symbol("TOKEN")

describe("a binding declared by an ancestor", () => {
    it("cannot see a descendant's registrations", () => {
        // THE isolation pin. `Service` lives on the parent; the child shadows TOKEN. Resolving through the
        // child still builds `Service` as the parent, so it reads the parent's TOKEN.
        class Service {
            readonly value = inject<string>(TOKEN)
        }

        const parent = new Container()
        parent.register([{ provide: TOKEN, useValue: "parent" }, Service])
        const child = parent.fork()
        child.register({ provide: TOKEN, useValue: "child" })

        expect(child.resolve(TOKEN)).toBe("child")
        expect(child.resolve(Service).value).toBe("parent")
    })

    it("cannot see a token the descendant alone declares", () => {
        const CHILD_ONLY = Symbol("CHILD_ONLY")
        class Service {
            readonly extra = injectOptional(CHILD_ONLY)
        }

        const parent = new Container()
        parent.register(Service)
        const child = parent.fork()
        child.register({ provide: CHILD_ONLY, useValue: "child" })

        expect(child.resolve(CHILD_ONLY)).toBe("child")
        expect(child.resolve(Service).extra).toBeUndefined()
    })

    it("throws for a required token only the descendant declares", () => {
        const CHILD_ONLY = Symbol("CHILD_ONLY")
        class Service {
            readonly extra = inject<string>(CHILD_ONLY)
        }

        const parent = new Container()
        parent.register(Service)
        const child = parent.fork()
        child.register({ provide: CHILD_ONLY, useValue: "child" })

        expect(() => child.resolve(Service)).toThrow(
            /Token CHILD_ONLY is not registered in this container or any ancestor\./
        )
    })

    it("collects only the chain at or above the declaring container", () => {
        const PLUGINS = Symbol("PLUGINS")
        class Collector {
            readonly plugins = injectAll<string>(PLUGINS)
        }

        const root = new Container()
        root.register([{ provide: PLUGINS, useValue: "root", multi: true }, Collector])
        const child = root.fork()
        child.register({ provide: PLUGINS, useValue: "child", multi: true })

        // The child's own read sees both; the collector, built as `root`, sees only root's.
        expect(child.resolveAll(PLUGINS)).toEqual(["child", "root"])
        expect(child.resolve(Collector).plugins).toEqual(["root"])
    })

    it("caches its singleton on the declaring container, so every descendant shares it", () => {
        let built = 0
        class Service {
            readonly value = inject<string>(TOKEN)
            constructor() {
                built++
            }
        }

        const root = new Container()
        root.register([{ provide: TOKEN, useValue: "root" }, Service])
        const left = root.fork()
        left.register({ provide: TOKEN, useValue: "left" })
        const right = root.fork()
        right.register({ provide: TOKEN, useValue: "right" })

        const fromLeft = left.resolve(Service)
        const fromRight = right.resolve(Service)

        expect(fromRight).toBe(fromLeft)
        expect(fromLeft.value).toBe("root")
        expect(built).toBe(1)
    })

    it("applies to factories exactly as it does to classes", () => {
        const BUILT = Symbol("BUILT")

        const root = new Container()
        root.register([
            { provide: TOKEN, useValue: "root" },
            { provide: BUILT, useFactory: () => ({ value: inject<string>(TOKEN) }) },
        ])
        const child = root.fork()
        child.register({ provide: TOKEN, useValue: "child" })

        expect(child.resolve<{ value: string }>(BUILT).value).toBe("root")
    })

    it("anchors a useExisting alias at the TARGET's declaring container, not the alias's", () => {
        const ALIAS = Symbol("ALIAS")
        const TARGET = Symbol("TARGET")

        class Service {
            readonly value = inject<string>(TOKEN)
        }

        const root = new Container()
        root.register([{ provide: TOKEN, useValue: "root" }, { provide: TARGET, useClass: Service }])
        const child = root.fork()
        child.register([{ provide: TOKEN, useValue: "child" }, { provide: ALIAS, useExisting: TARGET }])

        // The alias is the child's, the target is the root's — and the target is what constructs.
        expect(child.resolve<Service>(ALIAS).value).toBe("root")
        expect(child.resolve(ALIAS)).toBe(root.resolve(TARGET))
    })

    it("keeps a descendant's own binding anchored at the descendant", () => {
        // The other half of the rule: shadowing works, it just does not reach upward into the parent's
        // instances. A binding the child declares constructs as the child and sees the child's tokens.
        class Service {
            readonly value = inject<string>(TOKEN)
        }

        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })
        const child = parent.fork()
        child.register([{ provide: TOKEN, useValue: "child" }, Service])

        expect(child.resolve(Service).value).toBe("child")
        expect(parent.isRegistered(Service)).toBe(false)
    })
})

describe("inject modes", () => {
    function chain(): { parent: Container; child: Container } {
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "parent" })
        return { parent, child: parent.fork() }
    }

    it("defaults to nearest", () => {
        const { child } = chain()
        class Probe {
            readonly value = inject<string>(TOKEN)
        }
        child.register(Probe)

        expect(child.resolve(Probe).value).toBe("parent")
    })

    it("refuses an inherited token under self, exactly as resolve does", () => {
        const { child } = chain()
        class Probe {
            readonly value = inject<string>(TOKEN, { mode: "self" })
        }
        child.register(Probe)

        expect(() => child.resolve(Probe)).toThrow(
            /mode "self" reads its own bindings only/
        )
    })

    it("reads its own binding under self", () => {
        const { child } = chain()
        child.register({ provide: TOKEN, useValue: "child" })
        class Probe {
            readonly value = inject<string>(TOKEN, { mode: "self" })
        }
        child.register(Probe)

        expect(child.resolve(Probe).value).toBe("child")
    })

    it("gives injectOptional the same two modes", () => {
        const { child } = chain()
        class Probe {
            readonly nearest = injectOptional<string>(TOKEN)
            readonly own = injectOptional<string>(TOKEN, { mode: "self" })
        }
        child.register(Probe)

        const probe = child.resolve(Probe)
        expect(probe.nearest).toBe("parent")
        expect(probe.own).toBeUndefined()
    })

    it("accepts an enum member and a bare literal alike", () => {
        const { child } = chain()
        class Probe {
            readonly member = inject<string>(TOKEN, { mode: ResolveMode.Nearest })
            readonly literal = inject<string>(TOKEN, { mode: "nearest" })
        }
        child.register(Probe)

        const probe = child.resolve(Probe)
        expect(probe.member).toBe(probe.literal)
    })
})

describe("injectAll modes", () => {
    const PLUGINS = Symbol("PLUGINS")

    /** root and leaf both contribute; the collector is registered on a further, empty fork. */
    function chain(): { root: Container; leaf: Container; bare: Container } {
        const root = new Container()
        root.register({ provide: PLUGINS, useValue: "root", multi: true })
        const leaf = root.fork()
        leaf.register({ provide: PLUGINS, useValue: "leaf", multi: true })

        return { root, leaf, bare: leaf.fork() }
    }

    /** A fresh token per call, so one container can be measured in several modes without forking it. */
    function collect(container: Container, mode?: ResolveAllMode): string[] {
        const token = Symbol("COLLECTOR")
        const Collector = class {
            readonly plugins = mode === undefined ? injectAll<string>(PLUGINS) : injectAll<string>(PLUGINS, { mode })
        }
        container.register({ provide: token, useClass: Collector })

        return container.resolve<{ plugins: string[] }>(token).plugins
    }

    it("defaults to the whole chain", () => {
        const { leaf } = chain()

        expect(collect(leaf)).toEqual(["leaf", "root"])
        expect(collect(leaf)).toEqual(leaf.resolveAll(PLUGINS))
    })

    it("has the full tri-state — self included, which the old decorator could not express", () => {
        const { leaf, bare } = chain()

        expect(collect(leaf, "self")).toEqual(["leaf"])
        expect(collect(leaf, "nearest")).toEqual(["leaf"])
        expect(collect(leaf, "chained")).toEqual(["leaf", "root"])

        // The corner the two narrow modes exist to separate. `bare` declares nothing of its own: `self`
        // is own-only and reads [], `nearest` falls back to the nearest CONTRIBUTOR's own bindings.
        expect(collect(bare, "self")).toEqual([])
        expect(collect(bare, "nearest")).toEqual(["leaf"])
        expect(collect(bare, "chained")).toEqual(["leaf", "root"])
    })

    it("agrees with resolveAll on the same container, mode for mode", () => {
        const { root, leaf, bare } = chain()

        for (const container of [root, leaf, bare]) {
            for (const mode of ["self", "nearest", "chained"] as const) {
                expect(collect(container, mode)).toEqual(container.resolveAll(PLUGINS, mode))
            }
        }
    })

    it("accepts an enum member and a bare literal alike", () => {
        const { bare } = chain()

        expect(collect(bare, ResolveAllMode.Self)).toEqual(collect(bare, "self"))
        expect(collect(bare, ResolveAllMode.Nearest)).toEqual(collect(bare, "nearest"))
        expect(collect(bare, ResolveAllMode.Chained)).toEqual(collect(bare, "chained"))
    })

    it("reads [] for a collection point nobody filled", () => {
        const container = new Container()
        const EMPTY = Symbol("EMPTY")
        class Collector {
            readonly plugins = injectAll<string>(EMPTY)
        }
        container.register(Collector)

        expect(container.resolve(Collector).plugins).toEqual([])
    })

    it("inherits resolveAll's guard against a single registration", () => {
        const container = new Container()
        const SINGLE = Symbol("SINGLE")
        container.register({ provide: SINGLE, useValue: "only" })
        class Collector {
            readonly plugins = injectAll<string>(SINGLE)
        }
        container.register(Collector)

        expect(() => container.resolve(Collector)).toThrow("Use `resolve`")
    })
})

describe("registration snapshots", () => {
    it("lists own registrations in registration order", () => {
        class Service {}
        const container = new Container()
        container.register([
            { provide: TOKEN, useValue: "value" },
            { provide: Symbol("CLASS"), useClass: Service, scope: "transient" },
            { provide: Symbol("ALIAS"), useExisting: TOKEN },
        ])

        expect(container.registrations().map((registration) => registration.kind)).toEqual([
            "value",
            "class",
            "alias",
        ])
        // The union only yields `scope` once the kind is narrowed — the alias arm does not carry one.
        const klass = container.registrations()[1]
        if (klass?.kind !== "class") throw new Error("expected the second registration to be a class")
        expect(klass.scope).toBe("transient")
    })

    it("stays empty on a fork that declares nothing — snapshots are own-only", () => {
        const parent = new Container()
        parent.register({ provide: TOKEN, useValue: "value" })

        expect(parent.fork().registrations()).toEqual([])
    })

    it("constructs nothing by registering — the container has no eager pass", () => {
        let built = 0
        class Service {
            constructor() {
                built++
            }
        }
        const container = new Container()
        container.register([
            { provide: Symbol("ONE"), useClass: Service },
            { provide: Symbol("TWO"), useClass: Service },
        ])

        expect(built).toBe(0)
        expect(container.registrations()).toHaveLength(2)
    })
})

describe("registrations() is own-only in both directions", () => {
    // `registrations()` maps `#order`, which is this container's own list. The parent-to-child direction is
    // pinned above ("stays empty on a fork that declares nothing"); this is the reverse, and it is the one
    // a module layer actually depends on. A parent whose snapshot grew when a child registered would make
    // "what did THIS module declare" unanswerable, and every eager pass driven off it would run a
    // descendant's providers on the ancestor.

    it("does not report a child's registrations on the parent", () => {
        class OnParent {}
        class OnChild {}

        const parent = new Container()
        parent.register(OnParent)

        const child = parent.fork()
        child.register(OnChild)

        expect(parent.registrations().map((entry) => entry.token)).toEqual([OnParent])
        expect(child.registrations().map((entry) => entry.token)).toEqual([OnChild])
    })

    it("keeps siblings' registrations out of each other", () => {
        class Shared {}
        class First {}
        class Second {}

        const parent = new Container()
        parent.register(Shared)

        const left = parent.fork()
        const right = parent.fork()
        left.register(First)
        right.register(Second)

        expect(left.registrations().map((entry) => entry.token)).toEqual([First])
        expect(right.registrations().map((entry) => entry.token)).toEqual([Second])
        expect(parent.registrations().map((entry) => entry.token)).toEqual([Shared])

        // Both still READ the parent's binding — isolation of the snapshot is not isolation of the chain.
        expect(left.resolve(Shared)).toBe(right.resolve(Shared))
    })
})
