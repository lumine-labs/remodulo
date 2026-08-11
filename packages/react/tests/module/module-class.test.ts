import { describe, expect, it } from "vitest"

import { Container, Resolver, inject, injectResolver } from "@remodulo/container"
import { App, Module } from "../../src/core/module.js"
import { ModuleLifecycle } from "../../src/core/module-lifecycle.js"
import { ModuleStatus } from "../../src/core/module-lifecycle.types.js"
import { ModuleTraversal } from "../../src/core/module-traversal.js"
import { makeApp, makeChild, phase, plain, refuses, tracked } from "../setup/helpers.js"

// The Module / App classes.
// ========================================
//
// Construction and init are two steps now: `new Module(...)` builds the container and registers, `init()`
// arms the lifecycle. Nothing runs a user hook until `init()`, `init()` is idempotent, and a child cannot
// be built from a parent that has not been initialized.

const PARENT_ONLY = Symbol.for("tests.module.parent-only")
const CHILD_ONLY = Symbol.for("tests.module.child-only")

describe("construction", () => {
    it("builds a fresh container for an App and forks the parent's for a child", () => {
        const app = makeApp({ providers: [{ provide: PARENT_ONLY, useValue: "parent" }] })
        const child = new Module(app, { providers: [{ provide: CHILD_ONLY, useValue: "child" }] })
        child.init()

        expect(app.container).toBeInstanceOf(Container)
        expect(child.container).toBeInstanceOf(Container)
        expect(child.container).not.toBe(app.container)

        // Reads travel up the fork chain, writes do not travel down.
        expect(child.container.resolve(PARENT_ONLY)).toBe("parent")
        expect(child.container.isRegistered(PARENT_ONLY, "self")).toBe(false)
        expect(app.container.isRegistered(CHILD_ONLY)).toBe(false)
    })

    it("registers the three system providers on its own container", () => {
        const module = new App()
        const own = (token: Parameters<Container["isRegistered"]>[0]) => module.container.isRegistered(token, "self")

        // THREE, not four. The lifecycle was the fourth until it stopped being a registration and became a
        // part of the Module — `module.lifecycle`, reached directly. It has no token left to register under.
        expect([own(Module), own(Resolver), own(ModuleTraversal)]).toEqual([true, true, true])
    })

    it("registers the very lifecycle that drives the module's phases, not a second one", () => {
        const module = makeApp()
        const lifecycle = module.lifecycle

        // The lifecycle's own surface is the status, and `Module.status` is the one read that forwards it.
        expect(lifecycle).toBeInstanceOf(ModuleLifecycle)
        expect(lifecycle.status).toBe(ModuleStatus.Initialized)

        module.mount()
        expect(lifecycle.status).toBe(ModuleStatus.Mounted)
    })

    // Hooks are handed to the lifecycle at ITS construction, not at `init()`. So the lifecycle is fully
    // armed the moment it exists, and driving the phases through the registered instance — rather than
    // through `Module`'s delegating transitions — fires them all the same. Under the old `init(hooks?)`
    // plumbing this drive lost every module hook: no argument, no hooks.
    //
    // `init()` is the one phase that cannot be driven that way any more, and not for a reason about hooks:
    // the lifecycle sits behind a token like everything else, and the resolution gate refuses a read from a
    // module that has not been armed. So the module arms itself, and the other three go through the token.
    it("carries the params' module hooks from construction, even when the phases are driven through it", async () => {
        const log: string[] = []
        const module = new App({
            providers: [tracked(log, "svc")],
            onModuleInit: () => log.push("module:init"),
            onModuleMount: () => log.push("module:mount"),
            onModuleUnmount: () => log.push("module:unmount"),
            onModuleDestroy: () => log.push("module:destroy"),
        })
        module.init()
        const lifecycle = module.lifecycle

        lifecycle.mount()
        lifecycle.unmount()
        await lifecycle.destroy()

        expect(log.filter((entry) => !entry.endsWith(":ctor"))).toEqual([
            "module:init",
            "svc:init",
            "module:mount",
            "svc:mount",
            "svc:unmount",
            "module:unmount",
            "svc:destroy",
            "module:destroy",
        ])
    })

    it("registers itself under the Module token, resolvable directly and through the Resolver", () => {
        const module = makeApp({ id: "wired" })

        expect(module.container.resolve(Module)).toBe(module)
        expect(module.container.resolve(Resolver).resolve(Module)).toBe(module)
        expect(module.container.resolve(ModuleTraversal)).toBeInstanceOf(ModuleTraversal)
    })

    it("registers the CANONICAL resolver, so the token and the ambient reader are one instance", () => {
        const Reader = class {
            readonly injected = inject(Resolver)
            readonly ambient = injectResolver()
        }

        const module = makeApp({ providers: [Reader as never] })
        const reader = module.container.resolve(Reader)

        // The registration is `Resolver.for(container)`, not a private `new Resolver(container)`, so the
        // two doors into the same container cannot hand out two views of it.
        expect(reader.injected).toBe(Resolver.for(module.container))
        expect(reader.ambient).toBe(reader.injected)
    })

    it("registers user providers alongside the system ones", () => {
        const Plain = plain("wired")
        const module = makeApp({ providers: [Plain, { provide: CHILD_ONLY, useValue: 7 }] })

        expect(module.container.isRegistered(Plain as never, "self")).toBe(true)
        expect(module.container.resolve(CHILD_ONLY)).toBe(7)
    })

    it("does not init — no provider is constructed until init()", () => {
        const log: string[] = []
        const module = new App({ providers: [tracked(log, "A")] })

        expect(log).toEqual([])
        expect(module.status).toBe(ModuleStatus.Created)

        module.init()
        expect(log).toEqual(["A:ctor", "A:init"])
        expect(module.status).toBe(ModuleStatus.Initialized)
    })

    it("throws when a child is built from an un-initialized parent", () => {
        const parent = new App()

        expect(() => new Module(parent, {})).toThrowError(
            "Cannot create a child module from an un-initialized parent — its lifecycle is not armed yet, so instances would leak. Init the parent first."
        )

        parent.init()
        expect(() => new Module(parent, {})).not.toThrow()
    })
})

describe("init", () => {
    // A second init() is refused, and nothing re-fires behind the refusal — pinned once, in
    // `idempotence.test.ts`, which is the file that owns signal discipline. It used to be pinned here too,
    // verbatim, which meant two cells to update for one ruling and no reason to prefer either.

    it("runs providers in declaration order, module hook first", () => {
        const log: string[] = []
        makeApp({
            providers: [tracked(log, "A"), tracked(log, "B")],
            onModuleInit: () => log.push("module:init"),
        })

        // `phase(log, "init")` would also catch "module:init"; the full order below is the real assertion.
        expect(log.filter((e) => !e.endsWith(":ctor"))).toEqual(["module:init", "A:init", "B:init"])
    })
})

// `children` is a live `Set` underneath, so the guarantee is entirely in the type: the mutators are not on
// it. Checked by `typecheck:tests`, and again against the published declarations in the consumer fixtures.
// Nothing here is ever called.
function childrenRefusesMutation(module: Module, child: Module): void {
    // @ts-expect-error a ReadonlySet has no `add`.
    module.children.add(child)
    // @ts-expect-error and no `delete` either.
    module.children.delete(child)
}
void childrenRefusesMutation

describe("children", () => {
    it("attaches and detaches through addChild/removeChild", () => {
        const parent = makeApp({ id: "parent" })
        const child = new Module(parent, { id: "child" })

        parent.addChild(child)
        expect([...parent.children]).toEqual([child])

        parent.removeChild(child)
        expect(parent.children.size).toBe(0)
    })

    it("is the very set the module keeps, not a copy taken per read", () => {
        const parent = makeApp({ id: "parent" })
        const view = parent.children
        const child = new Module(parent, { id: "child" })

        parent.addChild(child)

        expect(view.has(child)).toBe(true)
        expect(parent.children).toBe(view)
    })
})

// `status` is the single read of a module's state. The four derived booleans that used to sit beside it —
// `initialized`, `mounted`, `destroyed`, `claimed` — are gone, not hidden: a second view of one value is a
// second thing that has to be kept true. Checked by `typecheck:tests`, and again against the published
// declarations in the consumer fixtures. Nothing here is ever called.
function statusIsTheOnlyStateRead(module: Module): void {
    // @ts-expect-error `initialized` is gone — `status` is neither `created` nor `failed`.
    void module.initialized
    // @ts-expect-error `mounted` is gone — `status === ModuleStatus.Mounted`.
    void module.mounted
    // @ts-expect-error `destroyed` is gone — `status === ModuleStatus.Destroyed`.
    void module.destroyed
    // @ts-expect-error `claimed` is gone — `status` is `destroying` or `destroyed`.
    void module.claimed
}
void statusIsTheOnlyStateRead

describe("status", () => {
    it("is the only state read on a module — the derived booleans are gone at runtime too", () => {
        const module = makeApp()

        // `in` walks the prototype chain, so this catches a getter re-added on the class as readily as an
        // own property. The type-level half is `statusIsTheOnlyStateRead` above.
        for (const name of ["initialized", "mounted", "destroyed", "claimed"]) {
            expect(name in module, `Module still exposes \`${name}\``).toBe(false)
        }

        expect("status" in module).toBe(true)
        expect(module.status).toBe(ModuleStatus.Initialized)
    })

    it("reports each of the four phases by name across the whole drive", async () => {
        const module = makeApp()

        // Each phase asserted as the status it LANDS on, not merely as "no longer the last one" — the
        // negative form passed for `unmounted` and `destroyed` alike and so pinned neither.
        expect(module.status).toBe(ModuleStatus.Initialized)

        module.mount()
        expect(module.status).toBe(ModuleStatus.Mounted)

        module.unmount()
        expect(module.status).toBe(ModuleStatus.Unmounted)

        await module.destroy()
        expect(module.status).toBe(ModuleStatus.Destroyed)
    })

    // `destroyed` is the end state; `destroying` is the mid-destroy bookkeeping ahead of it. The two differ
    // only inside `destroy()`, which is why the status moves before the await.
    it("reads destroyed only once destroy has resolved", async () => {
        const module = makeApp()

        expect(module.status).not.toBe(ModuleStatus.Destroyed)

        const destroying = module.destroy()
        await destroying

        expect(module.status).toBe(ModuleStatus.Destroyed)
    })

    it("stays destroyed, and collapses a repeated destroy", async () => {
        const module = makeApp()

        // destroy() is the one signal a corpse answers rather than refusing: the claim walk finds nothing
        // left to claim and the call falls straight through.
        await module.destroy()
        await expect(module.destroy()).resolves.toBeUndefined()

        expect(module.status).toBe(ModuleStatus.Destroyed)
    })

    // Children link into the tree at mount, so the whole tree is mounted before the destroy — an
    // un-mounted child is not reachable from its parent and would not be claimed at all.
    it("covers the claimed subtree and stops at it", async () => {
        const root = makeApp()
        const kept = makeChild(root)
        const doomed = makeChild(root)
        const grandchild = makeChild(doomed)

        grandchild.mount()
        doomed.mount()
        kept.mount()
        root.mount()

        // destroy() takes `unmounted`, not `mounted`, so the doomed branch retires itself first. The unmount
        // cascade runs downward only, so `root` and `kept` are untouched by it.
        doomed.unmount()
        await doomed.destroy()

        expect([doomed.status, grandchild.status]).toEqual([ModuleStatus.Destroyed, ModuleStatus.Destroyed])
        expect([root.status, kept.status]).not.toContain(ModuleStatus.Destroyed)
    })
})

describe("App", () => {
    it("pins parent to null", () => {
        const app = new App({ id: "root" })

        expect(app.parent).toBeNull()
        expect(app).toBeInstanceOf(Module)
    })

    it("new App returns an App instance", () => {
        const app = new App({ id: "made" })

        expect(app).toBeInstanceOf(App)
        expect(app.parent).toBeNull()
        expect(app.id).toBe("made")
    })

    it("records the context parent on a child", () => {
        const parent = makeApp({ id: "parent" })
        const child = new Module(parent, { id: "child" })

        expect(child.parent).toBe(parent)
        expect(child.id).toBe("child")
    })
})

describe("ids", () => {
    it("uses params.id verbatim", () => {
        expect(new App({ id: "feature:checkout" }).id).toBe("feature:checkout")
    })

    it("generates an id when none is supplied", () => {
        expect(new App().id).toMatch(/^id:\d+$/)
    })

    it("does not deduplicate two modules asking for the same id", () => {
        const a = new App({ id: "same" })
        const b = new App({ id: "same" })

        expect(a.id).toBe("same")
        expect(b.id).toBe("same")
        expect(a.container).not.toBe(b.container)
    })

    it("generates a distinct id per construction", () => {
        const ids = Array.from({ length: 25 }, () => new App().id)

        expect(new Set(ids).size).toBe(25)
    })
})

describe("four-phase drive across a tree", () => {
    it("mounts parent-first, tears down child-first", async () => {
        const log: string[] = []
        const root = makeApp({ providers: [tracked(log, "R")] })
        const child = new Module(root, { providers: [tracked(log, "C")] })
        child.init()
        log.length = 0

        child.mount()
        root.mount()
        expect(phase(log, "mount")).toEqual(["R:mount", "C:mount"])

        root.unmount()
        expect(phase(log, "unmount")).toEqual(["C:unmount", "R:unmount"])

        await root.destroy()
        expect(phase(log, "destroy")).toEqual(["C:destroy", "R:destroy"])
    })
})
