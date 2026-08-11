import { act, render } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useState, type ReactNode } from "react"

import { Resolver, Scope } from "@remodulo/container"
import type { ResolveAllMode, ResolveMode } from "@remodulo/container"
import { ModuleProvider } from "../../src/react/ModuleProvider.js"
import { useModuleContext, useModuleRebuild, useResolver } from "../../src/react/useModuleContext.js"
import { useResolve, useResolveOptional } from "../../src/react/useResolve.js"
import { useResolveAll } from "../../src/react/useResolveAll.js"
import { Root } from "../setup/react.js"

// Resolution hooks
// ========================================

class Counter {
    static made = 0

    readonly seq = ++Counter.made
}

const TRANSIENT_COUNTER = { provide: Counter, useClass: Counter, scope: Scope.Transient } as const

const SHARED = Symbol.for("tests.hooks.shared")
/** A collection token: every provider for it declares `multi: true`, which is what `resolveAll` reads. */
const COLLECTED = Symbol.for("tests.hooks.collected")
const MISSING = Symbol.for("tests.hooks.missing")
const THROWING = Symbol.for("tests.hooks.throwing")

function silenceReactErrorLog(): () => void {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    return () => spy.mockRestore()
}

beforeEach(() => {
    Counter.made = 0
})

describe("useResolve", () => {
    it("resolves a token from the module container", () => {
        let seen: Counter | null = null

        function Probe(): ReactNode {
            seen = useResolve(Counter)
            return null
        }

        render(
            <Root providers={[Counter]}>
                <Probe />
            </Root>
        )

        expect(seen).toBeInstanceOf(Counter)
        expect(seen!.seq).toBe(1)
    })

    it("resolves through the chain from a scoped child", () => {
        let seen: string | null = null

        function Probe(): ReactNode {
            seen = useResolve<string>(SHARED)
            return null
        }

        render(
            <Root providers={[{ provide: SHARED, useValue: "from-root" }]}>
                <ModuleProvider>
                    <Probe />
                </ModuleProvider>
            </Root>
        )

        expect(seen).toBe("from-root")
    })

    it("throws for an unregistered token", () => {
        const restore = silenceReactErrorLog()

        function Probe(): ReactNode {
            useResolve(MISSING)
            return null
        }

        expect(() =>
            render(
                <Root>
                    <Probe />
                </Root>
            )
        ).toThrowError("Token tests.hooks.missing is not registered in this container or any ancestor.")

        restore()
    })

    it('throws in "self" mode when the token lives only in the parent', () => {
        const restore = silenceReactErrorLog()

        function Probe(): ReactNode {
            useResolve(SHARED, "self")
            return null
        }

        expect(() =>
            render(
                <Root providers={[{ provide: SHARED, useValue: "from-root" }]}>
                    <ModuleProvider>
                        <Probe />
                    </ModuleProvider>
                </Root>
            )
        ).toThrowError(
            'Token tests.hooks.shared is not registered in this container (mode "self" reads its own bindings only). Use "nearest" to search its ancestors too.'
        )

        restore()
    })

    it("keeps one instance across re-renders", () => {
        const seen: Counter[] = []
        let bump: (() => void) | null = null

        function Probe(): ReactNode {
            seen.push(useResolve(Counter))
            return null
        }

        function Harness(): ReactNode {
            const [tick, setTick] = useState(0)
            bump = () => setTick((value) => value + 1)
            return (
                <Root providers={[TRANSIENT_COUNTER]}>
                    <Probe />
                    <span>{tick}</span>
                </Root>
            )
        }

        render(<Harness />)
        act(() => bump?.())
        act(() => bump?.())

        // Transient scope would mint a fresh instance on every re-resolve; one instance across three
        // renders is what makes the snapshot observable.
        expect(seen.length).toBe(3)
        expect(new Set(seen).size).toBe(1)
        expect(Counter.made).toBe(1)
    })

    it("re-resolves when the container changes", () => {
        const seen: Counter[] = []
        let rebuild: (() => void) | null = null

        function Probe(): ReactNode {
            seen.push(useResolve(Counter))
            rebuild = useModuleRebuild()
            return null
        }

        render(
            <Root>
                <ModuleProvider providers={[TRANSIENT_COUNTER]}>
                    <Probe />
                </ModuleProvider>
            </Root>
        )

        expect(seen.at(-1)!.seq).toBe(1)

        act(() => rebuild?.())

        expect(seen.at(-1)!.seq).toBe(2)
        expect(seen.at(-1)).not.toBe(seen[0])
    })

    it("re-resolves when the token changes", () => {
        const seen: string[] = []
        let switchToken: (() => void) | null = null
        const A = Symbol.for("tests.hooks.a")
        const B = Symbol.for("tests.hooks.b")

        function Probe(): ReactNode {
            const [token, setToken] = useState<symbol>(A)
            switchToken = () => setToken(B)
            seen.push(useResolve<string>(token))
            return null
        }

        render(
            <Root
                providers={[
                    { provide: A, useValue: "a" },
                    { provide: B, useValue: "b" },
                ]}
            >
                <Probe />
            </Root>
        )

        expect(seen).toEqual(["a"])
        act(() => switchToken?.())
        expect(seen).toEqual(["a", "b"])
    })
})

describe("useResolveOptional", () => {
    it("returns undefined for a missing token instead of throwing", () => {
        let seen: unknown = "sentinel"

        function Probe(): ReactNode {
            seen = useResolveOptional(MISSING)
            return null
        }

        render(
            <Root>
                <Probe />
            </Root>
        )

        expect(seen).toBeUndefined()
    })

    it('returns undefined in "self" mode for a parent-only token, and re-reads when the mode changes', () => {
        // The snapshot compares the MODE now, not a boolean: flipping it has to invalidate the memo, or
        // the hook would keep answering with the width it was first called at.
        const seen: unknown[] = []
        let flip: (() => void) | null = null

        function Probe(): ReactNode {
            const [mode, setMode] = useState<ResolveMode>("nearest")
            flip = () => setMode("self")
            seen.push(useResolveOptional<string>(SHARED, mode))
            return null
        }

        render(
            <Root providers={[{ provide: SHARED, useValue: "from-root" }]}>
                <ModuleProvider>
                    <Probe />
                </ModuleProvider>
            </Root>
        )

        expect(seen).toEqual(["from-root"])

        act(() => flip?.())
        expect(seen).toEqual(["from-root", undefined])
    })

    it("still surfaces an error thrown while constructing a registered token", () => {
        const restore = silenceReactErrorLog()

        function Probe(): ReactNode {
            useResolveOptional(THROWING)
            return null
        }

        expect(() =>
            render(
                <Root
                    providers={[
                        {
                            provide: THROWING,
                            lazy: true,
                            useFactory: () => {
                                throw new Error("factory failed")
                            },
                        },
                    ]}
                >
                    <Probe />
                </Root>
            )
        ).toThrowError(new Error("factory failed"))

        restore()
    })

    it("keeps a stable snapshot across re-renders", () => {
        const seen: Array<Counter | undefined> = []
        const missing: unknown[] = []
        let bump: (() => void) | null = null

        function Probe(): ReactNode {
            seen.push(useResolveOptional(Counter))
            missing.push(useResolveOptional(MISSING))
            return null
        }

        function Harness(): ReactNode {
            const [tick, setTick] = useState(0)
            bump = () => setTick((value) => value + 1)
            return (
                <Root providers={[TRANSIENT_COUNTER]}>
                    <Probe />
                    <span>{tick}</span>
                </Root>
            )
        }

        render(<Harness />)
        act(() => bump?.())

        expect(new Set(seen).size).toBe(1)
        expect(missing).toEqual([undefined, undefined])
        expect(Counter.made).toBe(1)
    })
})

describe("useResolveAll", () => {
    it("collects the chain, nearest module first", () => {
        let seen: string[] = []

        function Probe(): ReactNode {
            seen = useResolveAll<string>(COLLECTED)
            return null
        }

        render(
            <Root providers={[{ provide: COLLECTED, useValue: "root", multi: true }]}>
                <ModuleProvider providers={[{ provide: COLLECTED, useValue: "child", multi: true }]}>
                    <ModuleProvider providers={[{ provide: COLLECTED, useValue: "grandchild", multi: true }]}>
                        <Probe />
                    </ModuleProvider>
                </ModuleProvider>
            </Root>
        )

        expect(seen).toEqual(["grandchild", "child", "root"])
    })

    it("collects the module's own contributions only in self and nearest mode", () => {
        const seen: Record<string, string[]> = {}

        function Probe(): ReactNode {
            seen.self = useResolveAll<string>(COLLECTED, "self")
            seen.nearest = useResolveAll<string>(COLLECTED, "nearest")
            return null
        }

        render(
            <Root providers={[{ provide: COLLECTED, useValue: "root", multi: true }]}>
                <ModuleProvider providers={[{ provide: COLLECTED, useValue: "child", multi: true }]}>
                    <Probe />
                </ModuleProvider>
            </Root>
        )

        expect(seen).toEqual({ self: ["child"], nearest: ["child"] })
    })

    it("separates self from nearest when the module contributes nothing", () => {
        // Owner ruling 2026-08-01: the hook shares inversify's unchained semantics like every other read
        // surface, and that is what `nearest` names. `self` is the same read minus the ancestor fallback.
        const seen: Record<string, string[]> = {}

        function Probe(): ReactNode {
            seen.self = useResolveAll<string>(COLLECTED, "self")
            seen.nearest = useResolveAll<string>(COLLECTED, "nearest")
            return null
        }

        render(
            <Root providers={[{ provide: COLLECTED, useValue: "root", multi: true }]}>
                <ModuleProvider>
                    <Probe />
                </ModuleProvider>
            </Root>
        )

        expect(seen).toEqual({ self: [], nearest: ["root"] })
    })

    it("re-reads when the mode changes, not only when the token or container does", () => {
        const seen: string[][] = []
        let flip: (() => void) | null = null

        function Probe(): ReactNode {
            const [mode, setMode] = useState<ResolveAllMode>("chained")
            flip = () => setMode("self")
            seen.push(useResolveAll<string>(COLLECTED, mode))
            return null
        }

        render(
            <Root providers={[{ provide: COLLECTED, useValue: "root", multi: true }]}>
                <ModuleProvider providers={[{ provide: COLLECTED, useValue: "child", multi: true }]}>
                    <Probe />
                </ModuleProvider>
            </Root>
        )

        expect(seen).toEqual([["child", "root"]])

        act(() => flip?.())
        expect(seen).toEqual([
            ["child", "root"],
            ["child"],
        ])
    })

    it("returns an empty array for a token nobody registered", () => {
        let seen: unknown[] = ["sentinel"]

        function Probe(): ReactNode {
            seen = useResolveAll(MISSING)
            return null
        }

        render(
            <Root>
                <Probe />
            </Root>
        )

        expect(seen).toEqual([])
    })

    it("keeps the same array across re-renders and swaps it when the container changes", () => {
        const seen: string[][] = []
        let bump: (() => void) | null = null
        let rebuild: (() => void) | null = null

        function Probe(): ReactNode {
            seen.push(useResolveAll<string>(COLLECTED))
            rebuild = useModuleRebuild()
            return null
        }

        function Harness(): ReactNode {
            const [tick, setTick] = useState(0)
            bump = () => setTick((value) => value + 1)
            return (
                <Root>
                    <ModuleProvider providers={[{ provide: COLLECTED, useValue: "child", multi: true }]}>
                        <Probe />
                        <span>{tick}</span>
                    </ModuleProvider>
                </Root>
            )
        }

        render(<Harness />)
        act(() => bump?.())

        expect(seen.length).toBe(2)
        expect(seen[0]).toBe(seen[1])

        act(() => rebuild?.())

        expect(seen.at(-1)).not.toBe(seen[0])
        expect(seen.at(-1)).toEqual(["child"])
    })
})

describe("useModuleContext, useResolver, useModuleRebuild", () => {
    it("all read the same context value", () => {
        let context: ReturnType<typeof useModuleContext> | null = null
        let resolver: Resolver | null = null
        let rebuild: (() => void) | null = null

        function Probe(): ReactNode {
            context = useModuleContext()
            resolver = useResolver()
            rebuild = useModuleRebuild()
            return null
        }

        render(
            <Root>
                <ModuleProvider id="same">
                    <Probe />
                </ModuleProvider>
            </Root>
        )

        expect(resolver).toBe(context!.module.resolver)
        expect(rebuild).toBe(context!.rebuild)
        expect(resolver).toBeInstanceOf(Resolver)
    })

    it("keeps the rebuild function identity stable across re-renders", () => {
        const seen: Array<() => void> = []
        let bump: (() => void) | null = null

        function Probe(): ReactNode {
            seen.push(useModuleRebuild())
            return null
        }

        function Harness(): ReactNode {
            const [tick, setTick] = useState(0)
            bump = () => setTick((value) => value + 1)
            return (
                <Root>
                    <ModuleProvider>
                        <Probe />
                        <span>{tick}</span>
                    </ModuleProvider>
                </Root>
            )
        }

        render(<Harness />)
        act(() => bump?.())

        expect(seen.length).toBe(2)
        expect(new Set(seen).size).toBe(1)
    })

    it("throws outside a ModuleProvider", () => {
        const restore = silenceReactErrorLog()
        const message = new Error(
            "useModuleContext: no module in context. Wrap with <AppProvider> or <ModuleProvider>."
        )

        function Context(): ReactNode {
            useModuleContext()
            return null
        }
        function UseResolver(): ReactNode {
            useResolver()
            return null
        }
        function UseRebuild(): ReactNode {
            useModuleRebuild()
            return null
        }

        expect(() => render(<Context />)).toThrowError(message)
        expect(() => render(<UseResolver />)).toThrowError(message)
        expect(() => render(<UseRebuild />)).toThrowError(message)

        restore()
    })

    it("throws from useResolve outside a ModuleProvider, through useResolver", () => {
        const restore = silenceReactErrorLog()

        function Probe(): ReactNode {
            useResolve(MISSING)
            return null
        }

        expect(() => render(<Probe />)).toThrowError(
            new Error("useModuleContext: no module in context. Wrap with <AppProvider> or <ModuleProvider>.")
        )

        restore()
    })
})
