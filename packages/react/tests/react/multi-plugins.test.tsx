import { act, render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useState, type ReactNode } from "react"

import { injectAll } from "@remodulo/container"
import type { Provider } from "../../src/core/provider.types.js"
import { ModuleProvider } from "../../src/react/ModuleProvider.js"
import { useModule, useModuleRebuild, useResolver } from "../../src/react/useModuleContext.js"
import { useResolve } from "../../src/react/useResolve.js"
import { useResolveAll } from "../../src/react/useResolveAll.js"
import { Root } from "../setup/react.js"
import { flush, tracked } from "../setup/helpers.js"
import type { Tracked } from "../setup/helpers.js"

// The plugin pattern, end to end.
// ========================================
//
// This is what multi-providers are for: an app-level token every module along the chain may contribute to,
// read back as one collection at the deepest point. Three nested `<ModuleProvider>`s each register a
// `{ provide: PLUGINS, useClass: ..., multi: true }`, and the leaf reads the whole set two ways — through
// `injectAll()` in a service and through `useResolveAll` in a component. The two paths must agree, the order
// must be nearest-first, and every instance must be adopted by the module that DECLARED it, not by the one
// that read it.

const PLUGINS = Symbol.for("tests.multi.plugins")

const contribute = (service: Provider): Provider =>
    ({ provide: PLUGINS, useClass: service, multi: true }) as Provider

/** A service that reads the whole collection at construction. */
function collector(mode?: "nearest" | "chained"): Provider & { seen: string[][] } {
    const seen: string[][] = []

    const Collector = class {
        static seen = seen
        readonly plugins: { label: string }[] =
            mode === undefined ? injectAll(PLUGINS) : injectAll(PLUGINS, mode)

        constructor() {
            seen.push(this.plugins.map((plugin) => plugin.label))
        }
    }

    return Collector as unknown as Provider & { seen: string[][] }
}

/** A tracked lifecycle service that also carries a readable label. */
function plugin(log: string[], label: string): Tracked {
    const Service = tracked(log, label) as unknown as { prototype: { label: string } } & Tracked
    Service.prototype.label = label
    return Service
}

describe("the plugin pattern", () => {
    it("collects nearest-first across three modules, identically through injectAll and useResolveAll", () => {
        const log: string[] = []
        const root = plugin(log, "R")
        const mid = plugin(log, "M")
        const leaf = plugin(log, "L")
        const Collector = collector()

        let fromHook: { label: string }[] = []
        const fromService: { plugins: { label: string }[] }[] = []

        function Probe(): ReactNode {
            fromHook = useResolveAll<{ label: string }>(PLUGINS)
            fromService.push(useResolve<{ plugins: { label: string }[] }>(Collector as never))
            return null
        }

        render(
            <Root providers={[contribute(root)]}>
                <ModuleProvider providers={[contribute(mid)]}>
                    <ModuleProvider providers={[contribute(leaf), Collector]}>
                        <Probe />
                    </ModuleProvider>
                </ModuleProvider>
            </Root>
        )

        expect(fromHook.map((p) => p.label)).toEqual(["L", "M", "R"])
        expect(Collector.seen).toEqual([["L", "M", "R"]])
        expect(fromService[0]?.plugins).toEqual(fromHook)
    })

    it("agrees mode for mode across container, resolver, hook and injectAll", () => {
        // The probe sits in a module that contributes NOTHING, which is the only place the three modes
        // give three different answers: chained accumulates, nearest falls back to the leaf's own
        // collection alone, self is empty. Every surface that has a mode must land on the same one.
        const log: string[] = []
        const root = plugin(log, "R")
        const mid = plugin(log, "M")
        const leaf = plugin(log, "L")
        const NearestCollector = collector("nearest")
        const ChainedCollector = collector("chained")

        const labels = (plugins: { label: string }[]): string[] => plugins.map((p) => p.label)
        let seen: Record<string, string[]> = {}

        function Probe(): ReactNode {
            // Three doors onto the same widths: the hooks, the module's own container, and the canonical
            // resolver the context hands out. The container is reached off the module — there is no hook
            // for it any more.
            const container = useModule().container
            const resolver = useResolver()

            seen = {
                hookChained: labels(useResolveAll<{ label: string }>(PLUGINS, "chained")),
                hookNearest: labels(useResolveAll<{ label: string }>(PLUGINS, "nearest")),
                hookSelf: labels(useResolveAll<{ label: string }>(PLUGINS, "self")),
                containerChained: labels(container.resolveAll(PLUGINS, "chained")),
                containerNearest: labels(container.resolveAll(PLUGINS, "nearest")),
                containerSelf: labels(container.resolveAll(PLUGINS, "self")),
                resolverChained: labels(resolver.resolveAll(PLUGINS, "chained")),
                resolverNearest: labels(resolver.resolveAll(PLUGINS, "nearest")),
                resolverSelf: labels(resolver.resolveAll(PLUGINS, "self")),
                injectAllChained: labels(
                    useResolve<{ plugins: { label: string }[] }>(ChainedCollector as never).plugins
                ),
                injectAllNearest: labels(
                    useResolve<{ plugins: { label: string }[] }>(NearestCollector as never).plugins
                ),
            }
            return null
        }

        render(
            <Root providers={[contribute(root)]}>
                <ModuleProvider providers={[contribute(mid)]}>
                    <ModuleProvider providers={[contribute(leaf)]}>
                        <ModuleProvider providers={[NearestCollector, ChainedCollector]}>
                            <Probe />
                        </ModuleProvider>
                    </ModuleProvider>
                </ModuleProvider>
            </Root>
        )

        expect(seen).toEqual({
            hookChained: ["L", "M", "R"],
            containerChained: ["L", "M", "R"],
            resolverChained: ["L", "M", "R"],
            injectAllChained: ["L", "M", "R"],
            hookNearest: ["L"],
            containerNearest: ["L"],
            resolverNearest: ["L"],
            injectAllNearest: ["L"],
            hookSelf: [],
            containerSelf: [],
            resolverSelf: [],
        })
    })

    it("adopts every contribution into its own module", async () => {
        const log: string[] = []
        const root = plugin(log, "R")
        const mid = plugin(log, "M")
        const leaf = plugin(log, "L")

        const { unmount } = render(
            <Root providers={[contribute(root)]}>
                <ModuleProvider providers={[contribute(mid)]}>
                    <ModuleProvider providers={[contribute(leaf)]}>
                        <div />
                    </ModuleProvider>
                </ModuleProvider>
            </Root>
        )

        // One init and one mount each: adoption follows the binding, so no module claims another's plugin.
        expect(root.counts).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 0 })
        expect(mid.counts).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 0 })
        expect(leaf.counts).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 0 })

        expect(log.filter((entry) => entry.endsWith(":init"))).toEqual(["R:init", "M:init", "L:init"])
        expect(log.filter((entry) => entry.endsWith(":mount"))).toEqual(["R:mount", "M:mount", "L:mount"])

        unmount()
        await flush()

        // Every level goes all the way down, the App's own contribution included — `<Root>` destroys its
        // App on unmount, so R is buried alongside M and L.
        expect(leaf.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
        expect(mid.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
        expect(root.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
    })

    it("drops only the leaf's contribution when the leaf module goes away", async () => {
        const log: string[] = []
        const root = plugin(log, "R")
        const mid = plugin(log, "M")
        const leaf = plugin(log, "L")

        let seen: string[] = []
        let toggle: (() => void) | null = null

        function Probe(): ReactNode {
            seen = useResolveAll<{ label: string }>(PLUGINS).map((p) => p.label)
            return null
        }

        function Harness(): ReactNode {
            const [withLeaf, setWithLeaf] = useState(true)
            toggle = () => setWithLeaf(false)

            return (
                <Root providers={[contribute(root)]}>
                    <ModuleProvider providers={[contribute(mid)]}>
                        {withLeaf ? (
                            <ModuleProvider providers={[contribute(leaf)]}>
                                <Probe />
                            </ModuleProvider>
                        ) : (
                            <Probe />
                        )}
                    </ModuleProvider>
                </Root>
            )
        }

        render(<Harness />)
        expect(seen).toEqual(["L", "M", "R"])

        act(() => toggle?.())
        await flush()

        expect(seen).toEqual(["M", "R"])
        expect(leaf.counts).toEqual({ init: 1, mount: 1, unmount: 1, destroy: 1 })
        expect(mid.counts.destroy).toBe(0)
        expect(root.counts.destroy).toBe(0)
    })
})

describe("rebuilding a contributing module", () => {
    it("buries the old generation's members and collects the new ones, leaving ancestors alone", async () => {
        const log: string[] = []
        const root = plugin(log, "R")
        const mid = plugin(log, "M")

        let seen: string[] = []
        let rebuild: (() => void) | null = null

        function Probe(): ReactNode {
            seen = useResolveAll<{ label: string }>(PLUGINS).map((p) => p.label)
            rebuild = useModuleRebuild()
            return null
        }

        render(
            <Root providers={[contribute(root)]}>
                <ModuleProvider providers={[contribute(mid)]}>
                    <Probe />
                </ModuleProvider>
            </Root>
        )

        expect(seen).toEqual(["M", "R"])
        expect(mid.counts).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 0 })

        act(() => rebuild?.())
        await flush()

        // A fresh container, a fresh contribution — same shape, second instance.
        expect(seen).toEqual(["M", "R"])
        expect(mid.counts).toEqual({ init: 2, mount: 2, unmount: 1, destroy: 1 })

        // The ancestor's contribution was never rebuilt, and it is still the same instance.
        expect(root.counts).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 0 })
        expect(log.filter((entry) => entry === "R:ctor")).toHaveLength(1)
    })
})
