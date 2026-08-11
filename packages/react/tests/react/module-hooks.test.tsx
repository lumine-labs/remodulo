import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"

import type { Resolver } from "@remodulo/container"
import type { Module } from "../../src/core/module.js"
import { ModuleProvider } from "../../src/react/ModuleProvider.js"
import { useModule, useResolver } from "../../src/react/useModuleContext.js"
import { Root } from "../setup/react.js"
import { flush, tracked } from "../setup/helpers.js"

// Module hooks through props
// ========================================
//
// All four hook props are bridged with `useEvent`, so the module always calls the latest render's function
// without rebuilding when an inline arrow changes identity.

describe("module hooks reach the lifecycle", () => {
    it("fires all four in order, with no providers involved", async () => {
        const log: string[] = []

        const { unmount } = render(
            <Root>
                <ModuleProvider
                    onModuleInit={() => log.push("init")}
                    onModuleMount={() => log.push("mount")}
                    onModuleUnmount={() => log.push("unmount")}
                    onModuleDestroy={() => log.push("destroy")}
                >
                    <div />
                </ModuleProvider>
            </Root>
        )

        expect(log).toEqual(["init", "mount"])

        unmount()
        await flush()

        expect(log).toEqual(["init", "mount", "unmount", "destroy"])
    })

    it("hands each hook the module's own canonical resolver", async () => {
        const seen: Resolver[] = []
        let contextResolver: Resolver | null = null
        let contextModule: Module | null = null

        function Probe(): ReactNode {
            contextResolver = useResolver()
            contextModule = useModule()
            return null
        }

        const record = (resolver: Resolver) => seen.push(resolver)

        const { unmount } = render(
            <Root>
                <ModuleProvider
                    onModuleInit={record}
                    onModuleMount={record}
                    onModuleUnmount={record}
                    onModuleDestroy={record}
                >
                    <Probe />
                </ModuleProvider>
            </Root>
        )

        unmount()
        await flush()

        expect(seen.length).toBe(4)
        expect(new Set(seen).size).toBe(1)
        // The canonical `module.resolver`, not a fresh view of the same container.
        expect(seen[0]).toBe(contextModule!.resolver)
        expect(contextResolver).toBe(contextModule!.resolver)
    })

    it("hands the hook a read-only door: there is no `register` to reach", async () => {
        const seen: Resolver[] = []

        const record = (resolver: Resolver) => {
            // @ts-expect-error the hook argument is a Resolver — post-init `register()` is the hole this closes.
            void resolver.register
            seen.push(resolver)
        }

        const { unmount } = render(
            <Root>
                <ModuleProvider onModuleInit={record}>
                    <div />
                </ModuleProvider>
            </Root>
        )

        expect(seen.length).toBe(1)
        expect("register" in seen[0]!).toBe(false)

        unmount()
        await flush()
    })

    it("calls the latest render's function, not the one the module was built with", async () => {
        const log: string[] = []

        function Tree({ tag }: { tag: string }): ReactNode {
            return (
                <Root>
                    <ModuleProvider
                        onModuleMount={() => log.push(`mount:${tag}`)}
                        onModuleUnmount={() => log.push(`unmount:${tag}`)}
                        onModuleDestroy={() => log.push(`destroy:${tag}`)}
                    >
                        <div />
                    </ModuleProvider>
                </Root>
            )
        }

        const { rerender, unmount } = render(<Tree tag="a" />)
        expect(log).toEqual(["mount:a"])

        rerender(<Tree tag="b" />)
        rerender(<Tree tag="c" />)

        unmount()
        await flush()

        expect(log).toEqual(["mount:a", "unmount:c", "destroy:c"])
    })

    it("does not rebuild just because the inline hook props are new functions", async () => {
        const log: string[] = []
        const Service = tracked(log, "S")

        function Tree({ tag }: { tag: string }): ReactNode {
            return (
                <Root>
                    <ModuleProvider providers={[Service]} onModuleInit={() => log.push(`init:${tag}`)}>
                        <div />
                    </ModuleProvider>
                </Root>
            )
        }

        const { rerender } = render(<Tree tag="a" />)
        log.length = 0

        rerender(<Tree tag="b" />)
        rerender(<Tree tag="c" />)
        await flush()

        expect(log).toEqual([])
        expect(Service.counts).toEqual({ init: 1, mount: 1, unmount: 0, destroy: 0 })
    })
})

describe("phase failures", () => {
    it("lets an init failure escape into render", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})
        const log: string[] = []
        const Bad = tracked(log, "Bad", { throwOn: "init" })

        expect(() =>
            render(
                <Root>
                    <ModuleProvider providers={[Bad]}>
                        <div />
                    </ModuleProvider>
                </Root>
            )
        ).toThrowError(new Error("Bad init"))

        spy.mockRestore()
    })

    it("lets a failing module init hook escape into render", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        expect(() =>
            render(
                <Root>
                    <ModuleProvider
                        onModuleInit={() => {
                            throw new Error("module init boom")
                        }}
                    >
                        <div />
                    </ModuleProvider>
                </Root>
            )
        ).toThrowError(new Error("module init boom"))

        spy.mockRestore()
    })

    it("logs a destroy failure instead of throwing", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})
        const log: string[] = []
        const Bad = tracked(log, "Bad", { throwOn: "destroy" })

        const { unmount } = render(
            <Root>
                <ModuleProvider providers={[Bad]}>
                    <div />
                </ModuleProvider>
            </Root>
        )

        unmount()
        await flush()

        // Nobody awaits destroy, so an unhandled rejection is the alternative — it is logged instead.
        expect(spy.mock.calls.length).toBe(1)
        expect(spy.mock.calls[0][0]).toBe("module.destroy")
        expect((spy.mock.calls[0][1] as Error).message).toBe("Bad destroy")

        spy.mockRestore()
    })

    it("keeps destroying the rest of the tree after one module's destroy throws", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})
        const log: string[] = []
        const Bad = tracked(log, "Bad", { throwOn: "destroy" })
        const Good = tracked(log, "Good")

        const { unmount } = render(
            <Root>
                <ModuleProvider providers={[Good]}>
                    <ModuleProvider providers={[Bad]}>
                        <div />
                    </ModuleProvider>
                </ModuleProvider>
            </Root>
        )
        log.length = 0

        unmount()
        await flush()

        // The child's destroy throws and is logged; the parent's still runs.
        expect(log).toEqual(["Bad:unmount", "Good:unmount", "Good:destroy"])
        expect(Good.counts.destroy).toBe(1)
        expect(spy.mock.calls.length).toBe(1)

        spy.mockRestore()
    })
})
