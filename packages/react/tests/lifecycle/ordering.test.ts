import { describe, expect, it } from "vitest"

import { inject } from "@remodulo/container"
import type { Provider } from "../../src/core/provider.types.js"
import { makeApp, makeChild, phase, tracked } from "../setup/helpers.js"

// Phase ordering.
// ========================================
//
// The module is driven directly here, exactly as ModuleProvider drives it: `makeApp` / `makeChild`
// construct and init, then mount / unmount / destroy are signalled by hand in whatever order we want.

describe("init", () => {
    it("runs in creation order across a tree", () => {
        const log: string[] = []
        const parent = makeApp({ providers: [tracked(log, "P")] })
        makeChild(parent, { providers: [tracked(log, "C1")] })
        makeChild(parent, { providers: [tracked(log, "C2")] })

        expect(phase(log, "init")).toEqual(["P:init", "C1:init", "C2:init"])
    })

    it("runs at init time, before any mount signal", () => {
        const log: string[] = []
        const module = makeApp({ providers: [tracked(log, "A")] })

        expect(log).toEqual(["A:ctor", "A:init"])
        module.mount()
        expect(log).toEqual(["A:ctor", "A:init", "A:mount"])
    })

    it("runs providers in declaration order within one module", () => {
        const log: string[] = []
        makeApp({ providers: [tracked(log, "A"), tracked(log, "B"), tracked(log, "C")] })

        expect(phase(log, "init")).toEqual(["A:init", "B:init", "C:init"])
    })
})

describe("mount", () => {
    it("is parent-first even when the signals arrive child-first", () => {
        const log: string[] = []
        const parent = makeApp({ providers: [tracked(log, "P")] })
        const first = makeChild(parent, { providers: [tracked(log, "C1")] })
        const second = makeChild(parent, { providers: [tracked(log, "C2")] })
        log.length = 0

        first.mount()
        second.mount()
        expect(log).toEqual([])

        parent.mount()
        expect(phase(log, "mount")).toEqual(["P:mount", "C1:mount", "C2:mount"])
    })

    it("is parent-first when the signals arrive parent-first", () => {
        const log: string[] = []
        const parent = makeApp({ providers: [tracked(log, "P")] })
        const child = makeChild(parent, { providers: [tracked(log, "C")] })
        log.length = 0

        parent.mount()
        child.mount()

        expect(phase(log, "mount")).toEqual(["P:mount", "C:mount"])
    })

    it("cascades through three levels signalled bottom-up", () => {
        const log: string[] = []
        const a = makeApp({ providers: [tracked(log, "A")] })
        const b = makeChild(a, { providers: [tracked(log, "B")] })
        const c = makeChild(b, { providers: [tracked(log, "C")] })
        log.length = 0

        c.mount()
        b.mount()
        a.mount()

        expect(phase(log, "mount")).toEqual(["A:mount", "B:mount", "C:mount"])
    })

    it("mounts a late child immediately when the parent is already mounted", () => {
        const log: string[] = []
        const parent = makeApp({ providers: [tracked(log, "P")] })
        parent.mount()
        log.length = 0

        const child = makeChild(parent, { providers: [tracked(log, "C")] })
        expect(phase(log, "mount")).toEqual([])

        child.mount()
        expect(phase(log, "mount")).toEqual(["C:mount"])
    })

    it("mounts providers within a module in declaration order", () => {
        const log: string[] = []
        const module = makeApp({ providers: [tracked(log, "A"), tracked(log, "B"), tracked(log, "C")] })
        log.length = 0

        module.mount()

        expect(log).toEqual(["A:mount", "B:mount", "C:mount"])
    })
})

describe("unmount", () => {
    it("reverses the whole tree, siblings included", () => {
        const log: string[] = []
        const parent = makeApp({ providers: [tracked(log, "P")] })
        const first = makeChild(parent, { providers: [tracked(log, "C1")] })
        const second = makeChild(parent, { providers: [tracked(log, "C2")] })
        first.mount()
        second.mount()
        parent.mount()
        log.length = 0

        parent.unmount()

        expect(log).toEqual(["C2:unmount", "C1:unmount", "P:unmount"])
    })

    it("reverses provider order inside a module", () => {
        const log: string[] = []
        const module = makeApp({ providers: [tracked(log, "A"), tracked(log, "B"), tracked(log, "C")] })
        module.mount()
        log.length = 0

        module.unmount()

        expect(log).toEqual(["C:unmount", "B:unmount", "A:unmount"])
    })

    it("walks a three-level tree from the leaf up", () => {
        const log: string[] = []
        const a = makeApp({ providers: [tracked(log, "A")] })
        const b = makeChild(a, { providers: [tracked(log, "B")] })
        const c = makeChild(b, { providers: [tracked(log, "C")] })
        c.mount()
        b.mount()
        a.mount()
        log.length = 0

        a.unmount()

        expect(log).toEqual(["C:unmount", "B:unmount", "A:unmount"])
    })

    it("unmounts only the subtree that was signalled", () => {
        const log: string[] = []
        const parent = makeApp({ providers: [tracked(log, "P")] })
        const child = makeChild(parent, { providers: [tracked(log, "C")] })
        child.mount()
        parent.mount()
        log.length = 0

        child.unmount()

        expect(log).toEqual(["C:unmount"])
    })
})

describe("destroy", () => {
    it("reverses the whole tree, siblings included", async () => {
        const log: string[] = []
        const parent = makeApp({ providers: [tracked(log, "P")] })
        const first = makeChild(parent, { providers: [tracked(log, "C1")] })
        const second = makeChild(parent, { providers: [tracked(log, "C2")] })
        first.mount()
        second.mount()
        parent.mount()
        parent.unmount()
        log.length = 0

        await parent.destroy()

        expect(log).toEqual(["C2:destroy", "C1:destroy", "P:destroy"])
    })

    it("reverses provider order inside a module", async () => {
        const log: string[] = []
        const module = makeApp({ providers: [tracked(log, "A"), tracked(log, "B"), tracked(log, "C")] })
        module.mount()
        module.unmount()
        log.length = 0

        await module.destroy()

        expect(log).toEqual(["C:destroy", "B:destroy", "A:destroy"])
    })

    it("genuinely awaits each hook — a slow one blocks the fast one behind it", async () => {
        const log: string[] = []
        // Destroy runs in reverse, so the 25ms hook goes first. Fire-and-forget would let the 5ms hook
        // overtake it and log ["A:destroy", "B:destroy"].
        const module = makeApp({
            providers: [tracked(log, "A", { destroyDelay: 5 }), tracked(log, "B", { destroyDelay: 25 })],
        })
        module.mount()
        module.unmount()
        log.length = 0

        const started = Date.now()
        await module.destroy()
        const elapsed = Date.now() - started

        expect(log).toEqual(["B:destroy", "A:destroy"])
        expect(elapsed).toBeGreaterThanOrEqual(25)
    })

    it("awaits across modules, not just within one", async () => {
        const log: string[] = []
        const parent = makeApp({ providers: [tracked(log, "P", { destroyDelay: 5 })] })
        const child = makeChild(parent, { providers: [tracked(log, "C", { destroyDelay: 25 })] })
        child.mount()
        parent.mount()
        parent.unmount()
        log.length = 0

        await parent.destroy()

        expect(log).toEqual(["C:destroy", "P:destroy"])
    })

    it("destroys only the subtree that was signalled, and the parent survives", async () => {
        const log: string[] = []
        const parent = makeApp({ providers: [tracked(log, "P")] })
        const child = makeChild(parent, { providers: [tracked(log, "C")] })
        child.mount()
        parent.mount()
        child.unmount()
        log.length = 0

        await child.destroy()
        expect(log).toEqual(["C:destroy"])

        parent.unmount()
        await parent.destroy()
        expect(log).toEqual(["C:destroy", "P:unmount", "P:destroy"])
    })
})

describe("construction order", () => {
    it("destroys a dependent before the dependency it injected", async () => {
        const log: string[] = []
        const DEPENDENCY = Symbol("dependency")
        const dependency = tracked(log, "Dependency")

        class Dependent {
            readonly dependency = inject(DEPENDENCY)

            constructor() {
                log.push("Dependent:ctor")
            }
            onModuleDestroy(): void {
                log.push("Dependent:destroy")
            }
        }

        // Declared dependent-first; construction order is still dependency-first, and that is what the
        // lifecycle records.
        const module = makeApp({
            providers: [
                { provide: Dependent, useClass: Dependent } as Provider,
                { provide: DEPENDENCY, useClass: dependency } as Provider,
            ],
        })

        expect(phase(log, "ctor")).toEqual(["Dependency:ctor", "Dependent:ctor"])

        module.mount()
        module.unmount()
        log.length = 0
        await module.destroy()

        expect(log).toEqual(["Dependent:destroy", "Dependency:destroy"])
    })
})

describe("module hooks", () => {
    it("brackets the provider hooks — first up, last down", async () => {
        const log: string[] = []
        const module = makeApp({
            providers: [tracked(log, "svc")],
            onModuleInit: () => log.push("module:init"),
            onModuleMount: () => log.push("module:mount"),
            onModuleUnmount: () => log.push("module:unmount"),
            onModuleDestroy: () => log.push("module:destroy"),
        })

        module.mount()
        module.unmount()
        await module.destroy()

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

    it("hands the module container to every hook", async () => {
        const seen: unknown[] = []
        const module = makeApp({
            onModuleInit: (container) => seen.push(container),
            onModuleMount: (container) => seen.push(container),
            onModuleUnmount: (container) => seen.push(container),
            onModuleDestroy: (container) => seen.push(container),
        })

        module.mount()
        module.unmount()
        await module.destroy()

        expect(seen).toEqual([module.container, module.container, module.container, module.container])
    })

    it("awaits an async module destroy hook", async () => {
        const log: string[] = []
        const module = makeApp({
            providers: [tracked(log, "svc")],
            onModuleDestroy: async () => {
                await new Promise((resolve) => setTimeout(resolve, 20))
                log.push("module:destroy")
            },
        })
        module.mount()
        module.unmount()
        log.length = 0

        await module.destroy()

        expect(log).toEqual(["svc:destroy", "module:destroy"])
    })
})
