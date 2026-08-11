import { act, render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useState, type ReactNode } from "react"

import { Container, Resolver } from "@remodulo/container"
import { App, Module } from "../../src/core/module.js"
import { ModuleStatus } from "../../src/core/module-lifecycle.types.js"
import { AppProvider } from "../../src/react/AppProvider.js"
import { ModuleProvider } from "../../src/react/ModuleProvider.js"
import { useModuleContext, useResolver } from "../../src/react/useModuleContext.js"
import type { ModuleContextValue } from "../../src/react/ModuleContext.js"
import { Root } from "../setup/react.js"
import { flush, tracked } from "../setup/helpers.js"

// AppProvider + ModuleProvider
// ========================================
//
// The React root is `<AppProvider app={new App(...)}>`: it captures the app, inits it before children
// render, mounts it on effect, and on cleanup unmounts and then destroys it — the provider owns the whole
// arc. Every `<ModuleProvider>` is scoped: it forks the module in context and requires one to be there.

const SHARED = Symbol.for("tests.provider.shared")
const ROOT_ONLY = Symbol.for("tests.provider.root-only")

function silenceReactErrorLog(): () => void {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    return () => spy.mockRestore()
}

describe("AppProvider", () => {
    it("inits an un-initialized app before children render", () => {
        const app = new App({ providers: [{ provide: ROOT_ONLY, useValue: "root-only" }] })
        expect(app.status).toBe(ModuleStatus.Created)

        let resolved: string | null = null
        function Probe(): ReactNode {
            // A scoped child throws at construction if its parent is not initialized, so rendering at all
            // proves the app was inited first.
            resolved = useResolver().resolve<string>(ROOT_ONLY)
            return null
        }

        render(
            <AppProvider app={app}>
                <ModuleProvider>
                    <Probe />
                </ModuleProvider>
            </AppProvider>
        )

        // The app is `mounted` by now — the effect ran inside `render` — so this asks the question the old
        // `initialized` boolean asked: init arrived and the state is not the pre-init one nor the failed one.
        expect(app.status).not.toBeOneOf([ModuleStatus.Created, ModuleStatus.Failed])
        expect(resolved).toBe("root-only")
    })

    it("mounts on effect and unmounts on cleanup", () => {
        const log: string[] = []
        const Service = tracked(log, "A")
        const app = new App({ providers: [Service] })

        const { unmount } = render(<AppProvider app={app}><div /></AppProvider>)

        expect(app.status).toBe(ModuleStatus.Mounted)
        expect(Service.counts).toMatchObject({ init: 1, mount: 1, unmount: 0 })

        unmount()
        expect(app.status).not.toBe(ModuleStatus.Mounted)
        expect(Service.counts).toMatchObject({ unmount: 1 })
    })

    it("destroys the app on unmount — root providers get onModuleUnmount AND onModuleDestroy", async () => {
        const log: string[] = []
        const Service = tracked(log, "A")
        const app = new App({ providers: [Service] })

        const { unmount } = render(<AppProvider app={app}><div /></AppProvider>)
        unmount()
        await flush()

        // The full arc, unmount strictly before destroy. Nothing outside the tree has to call
        // `app.destroy()` for a root provider to see its destroy hook.
        expect(Service.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
        expect(log).toEqual(["A:ctor", "A:init", "A:mount", "A:unmount", "A:destroy"])
        expect(app.status).toBeOneOf([ModuleStatus.Destroying, ModuleStatus.Destroyed])
        expect(app.status).not.toBe(ModuleStatus.Mounted)
    })

    it("absorbs a manual app.destroy() after the unmount-driven destroy", async () => {
        const log: string[] = []
        const Service = tracked(log, "A")
        const app = new App({ providers: [Service] })

        const { unmount } = render(<AppProvider app={app}><div /></AppProvider>)
        unmount()
        await flush()
        log.length = 0

        // An owner calling destroy() out of habit is not punished for it: the claim walk finds the subtree
        // already spent and the call collapses. Unlike mount() or unmount() on a corpse — both of which
        // refuse — this caller is asking for a state the App is already in, so it gets it.
        await expect(app.destroy()).resolves.toBeUndefined()
        await flush()

        expect(log).toEqual([])
        expect(Service.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })

    it("does not re-init an app the owner already initialized", () => {
        const log: string[] = []
        const Service = tracked(log, "A")
        const app = new App({ providers: [Service] })
        app.init()

        render(<AppProvider app={app}><div /></AppProvider>)

        expect(Service.counts).toMatchObject({ init: 1, mount: 1 })
    })

    it("publishes { module, rebuild } with the app as the module", () => {
        const app = new App({ id: "the-app" })
        let value: ModuleContextValue | null = null

        function Probe(): ReactNode {
            value = useModuleContext()
            return null
        }

        render(<AppProvider app={app}><Probe /></AppProvider>)

        expect(Object.keys(value!).sort()).toEqual(["module", "rebuild"])
        expect(value!.module).toBe(app)
        expect(value!.module).toBeInstanceOf(App)
        expect(value!.module.id).toBe("the-app")
        expect(typeof value!.rebuild).toBe("function")
    })
})

describe("parallel apps", () => {
    it("keeps two sibling AppProviders in independent containers and lifecycles", async () => {
        const log: string[] = []
        const first = new App({ providers: [tracked(log, "First"), { provide: SHARED, useValue: "first" }] })
        const second = new App({ providers: [tracked(log, "Second"), { provide: SHARED, useValue: "second" }] })

        const seen: string[] = []
        function Probe(): ReactNode {
            seen.push(useResolver().resolve<string>(SHARED))
            return null
        }

        const { unmount } = render(
            <>
                <AppProvider app={first}><Probe /></AppProvider>
                <AppProvider app={second}><Probe /></AppProvider>
            </>
        )

        // Separate containers, no cross-talk: each subtree reads its own app's binding.
        expect(first.container).not.toBe(second.container)
        expect(seen).toEqual(["first", "second"])
        expect(first.container.isRegistered(SHARED, "self")).toBe(true)
        expect(second.container.resolve(SHARED)).toBe("second")

        unmount()
        await flush()

        expect(log.filter((e) => e.startsWith("First"))).toEqual([
            "First:ctor",
            "First:init",
            "First:mount",
            "First:unmount",
            "First:destroy",
        ])
        expect(log.filter((e) => e.startsWith("Second"))).toEqual([
            "Second:ctor",
            "Second:init",
            "Second:mount",
            "Second:unmount",
            "Second:destroy",
        ])
    })
})

describe("ModuleProvider — context value", () => {
    it("publishes exactly { module, rebuild }", () => {
        let value: ModuleContextValue | null = null

        function Probe(): ReactNode {
            value = useModuleContext()
            return null
        }

        render(
            <Root>
                <ModuleProvider id="shape">
                    <Probe />
                </ModuleProvider>
            </Root>
        )

        expect(Object.keys(value!).sort()).toEqual(["module", "rebuild"])
        expect(value!.module).toBeInstanceOf(Module)
        expect(value!.module.id).toBe("shape")
        expect(value!.module.container).toBeInstanceOf(Container)
        expect(typeof value!.rebuild).toBe("function")
    })

    it("generates an id when none is given", () => {
        let id = ""

        function Probe(): ReactNode {
            id = useModuleContext().module.id
            return null
        }

        render(
            <Root>
                <ModuleProvider>
                    <Probe />
                </ModuleProvider>
            </Root>
        )

        expect(id).toMatch(/^id:\d+$/)
    })

    it("keeps the same context object across unrelated re-renders", () => {
        const seen: ModuleContextValue[] = []
        let bump: (() => void) | null = null

        function Probe(): ReactNode {
            seen.push(useModuleContext())
            return null
        }

        function Harness(): ReactNode {
            const [tick, setTick] = useState(0)
            bump = () => setTick((value) => value + 1)
            return (
                <Root>
                    <ModuleProvider id="stable">
                        <Probe />
                        <span data-testid="tick">{tick}</span>
                    </ModuleProvider>
                </Root>
            )
        }

        render(<Harness />)
        act(() => bump?.())
        act(() => bump?.())

        expect(seen.length).toBe(3)
        expect(new Set(seen).size).toBe(1)
    })

    it("renders its children", () => {
        const { container } = render(
            <Root>
                <ModuleProvider>
                    <span data-testid="child">hello</span>
                </ModuleProvider>
            </Root>
        )

        expect(container.textContent).toBe("hello")
    })

    it("accepts no children at all", () => {
        expect(() => render(<Root><ModuleProvider /></Root>)).not.toThrow()
    })
})

describe("ModuleProvider — nesting", () => {
    it("gives a scoped child its own container, seen through its own resolver, reading through to the parent", () => {
        let parent: Resolver | null = null
        let child: Resolver | null = null

        function Parent(): ReactNode {
            parent = useResolver()
            return null
        }
        function Child(): ReactNode {
            child = useResolver()
            return null
        }

        render(
            <Root providers={[{ provide: ROOT_ONLY, useValue: "root-only" }]}>
                <Parent />
                <ModuleProvider providers={[{ provide: SHARED, useValue: "child" }]}>
                    <Child />
                </ModuleProvider>
            </Root>
        )

        expect(child).not.toBe(parent)
        expect(child!.resolve(ROOT_ONLY)).toBe("root-only")
        expect(child!.isRegistered(ROOT_ONLY, "self")).toBe(false)
        expect(parent!.isRegistered(SHARED)).toBe(false)
    })

    it("resolves the nearest override across app, child and grandchild", () => {
        const seen: string[] = []

        function Probe(): ReactNode {
            seen.push(useResolver().resolve<string>(SHARED))
            return null
        }

        render(
            <Root providers={[{ provide: SHARED, useValue: "app" }]}>
                <Probe />
                <ModuleProvider providers={[{ provide: SHARED, useValue: "child" }]}>
                    <Probe />
                    <ModuleProvider providers={[{ provide: SHARED, useValue: "grandchild" }]}>
                        <Probe />
                    </ModuleProvider>
                </ModuleProvider>
            </Root>
        )

        expect(seen).toEqual(["app", "child", "grandchild"])
    })

    it("links the module tree so ancestors reach descendants and back", () => {
        let app: Module | null = null
        let child: Module | null = null
        let grandchild: Module | null = null

        const capture = (assign: (module: Module) => void) =>
            function Probe(): ReactNode {
                assign(useModuleContext().module)
                return null
            }

        const AppProbe = capture((module) => (app = module))
        const Child = capture((module) => (child = module))
        const Grandchild = capture((module) => (grandchild = module))

        render(
            <Root id="app">
                <AppProbe />
                <ModuleProvider id="child">
                    <Child />
                    <ModuleProvider id="grandchild">
                        <Grandchild />
                    </ModuleProvider>
                </ModuleProvider>
            </Root>
        )

        expect(child!.parent).toBe(app)
        expect(grandchild!.parent).toBe(child)
        expect([...app!.children]).toContain(child)
        expect([...child!.children]).toContain(grandchild)
    })
})

describe("ModuleProvider — no parent module in context", () => {
    it("throws when there is no module to fork", () => {
        const restore = silenceReactErrorLog()

        expect(() =>
            render(
                <ModuleProvider>
                    <div />
                </ModuleProvider>
            )
        ).toThrowError(/ModuleProvider requires a parent module in context/)

        restore()
    })
})
