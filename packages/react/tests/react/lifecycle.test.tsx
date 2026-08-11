import { describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"
import type { ReactNode } from "react"

import type { Provider } from "../../src/core/provider.types.js"
import { ModuleProvider } from "../../src/react/ModuleProvider.js"
import { useResolve } from "../../src/react/useResolve.js"
import { useModuleContext } from "../../src/react/useModuleContext.js"
import { Root, svc } from "../setup/react.js"
import { flush } from "../setup/helpers.js"

// Lifecycle through React
// ========================================
//
// The four phases run against the real renderer now: `<Root>` is `<AppProvider app={new App(...)}>`, and
// each scoped `<ModuleProvider>` inside it owns init on render, mount on effect, unmount + deferred destroy
// on cleanup. Ordering, gating and the deferred-destroy contract match the imperative drive.

describe("lifecycle through React", () => {
    it("runs all four phases across a nested tree in the right order", async () => {
        const log: string[] = []
        const { unmount } = render(
            <Root>
                <ModuleProvider providers={[svc(log, "P")]}>
                    <ModuleProvider providers={[svc(log, "C")]}>
                        <div />
                    </ModuleProvider>
                </ModuleProvider>
            </Root>
        )

        expect(log.filter((l) => l.endsWith(":init"))).toEqual(["P:init", "C:init"])
        expect(log.filter((l) => l.endsWith(":mount"))).toEqual(["P:mount", "C:mount"])

        log.length = 0
        unmount()
        expect(log.filter((l) => l.endsWith(":unmount"))).toEqual(["C:unmount", "P:unmount"])

        await flush()
        expect(log.filter((l) => l.endsWith(":destroy"))).toEqual(["C:destroy", "P:destroy"])
    })

    it("defers a destroy hook that actually suspends, keeping order", async () => {
        const log: string[] = []
        const slow = (label: string, ms: number) => {
            const K = class {
                async onModuleDestroy() {
                    await new Promise((resolve) => setTimeout(resolve, ms))
                    log.push(`${label}:destroy`)
                }
            }
            return K as unknown as Provider
        }

        const { unmount } = render(
            <Root>
                <ModuleProvider providers={[slow("P", 20)]}>
                    <ModuleProvider providers={[slow("C", 5)]}>
                        <div />
                    </ModuleProvider>
                </ModuleProvider>
            </Root>
        )

        unmount()
        expect(log).toEqual([])

        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(log).toEqual(["C:destroy", "P:destroy"])
    })

    it("fires module hooks around provider hooks", async () => {
        const log: string[] = []
        const { unmount } = render(
            <Root>
                <ModuleProvider
                    providers={[svc(log, "svc")]}
                    onModuleInit={() => log.push("module:init")}
                    onModuleMount={() => log.push("module:mount")}
                    onModuleUnmount={() => log.push("module:unmount")}
                    onModuleDestroy={() => log.push("module:destroy")}
                >
                    <div />
                </ModuleProvider>
            </Root>
        )
        expect(log).toEqual(["module:init", "svc:init", "module:mount", "svc:mount"])

        log.length = 0
        unmount()
        await flush()
        expect(log).toEqual(["svc:unmount", "module:unmount", "svc:destroy", "module:destroy"])
    })

    it("resolves through useResolve and exposes the module id", () => {
        const log: string[] = []
        const Token = svc(log, "S")
        let seenId: string | undefined

        function Child(): ReactNode {
            useResolve(Token as never)
            seenId = useModuleContext().module.id
            return null
        }

        render(
            <Root>
                <ModuleProvider id="feature" providers={[Token]}>
                    <Child />
                </ModuleProvider>
            </Root>
        )
        expect(seenId).toBe("feature")
    })

    it("tears down only the subtree that unmounts", async () => {
        const log: string[] = []
        function Tree({ showChild }: { showChild: boolean }): ReactNode {
            return (
                <Root providers={[svc(log, "P")]}>
                    {showChild ? (
                        <ModuleProvider providers={[svc(log, "C")]}>
                            <div />
                        </ModuleProvider>
                    ) : null}
                </Root>
            )
        }
        const { rerender } = render(<Tree showChild />)
        log.length = 0

        rerender(<Tree showChild={false} />)
        await flush()
        expect(log).toEqual(["C:unmount", "C:destroy"])
    })

    it("keeps a lazy provider unbuilt until resolved", async () => {
        const log: string[] = []
        const Token = svc(log, "L")

        function Child({ resolveIt }: { resolveIt: boolean }): ReactNode {
            if (resolveIt) useResolve(Token as never)
            return null
        }

        const { rerender, unmount } = render(
            <Root>
                <ModuleProvider providers={[{ provide: Token, useClass: Token, lazy: true } as Provider]}>
                    <Child resolveIt={false} />
                </ModuleProvider>
            </Root>
        )
        expect(log).toEqual([])

        rerender(
            <Root>
                <ModuleProvider providers={[{ provide: Token, useClass: Token, lazy: true } as Provider]}>
                    <Child resolveIt />
                </ModuleProvider>
            </Root>
        )
        expect(log).toEqual(["L:init", "L:mount"])

        log.length = 0
        unmount()
        await flush()
        expect(log).toEqual(["L:unmount", "L:destroy"])
    })

    it("does not leave an unhandled rejection when a destroy hook throws", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})
        const rejections: unknown[] = []
        const onRejection = (event: PromiseRejectionEvent) => rejections.push(event.reason)
        window.addEventListener("unhandledrejection", onRejection)

        const Bad = class {
            async onModuleDestroy() {
                throw new Error("destroy boom")
            }
        }

        const { unmount } = render(
            <Root>
                <ModuleProvider providers={[Bad as unknown as Provider]}>
                    <div />
                </ModuleProvider>
            </Root>
        )
        unmount()
        await flush()

        window.removeEventListener("unhandledrejection", onRejection)
        expect(rejections).toEqual([])
        expect(spy).toHaveBeenCalled()
        spy.mockRestore()
    })
})
