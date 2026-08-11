import { act, render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useState, type JSX, type ReactNode } from "react"

import { inject } from "@remodulo/container"
import { Ref, RefMap } from "../../src/primitives/ref.js"
import { ModuleProvider } from "../../src/react/ModuleProvider.js"
import { useResolve } from "../../src/react/useResolve.js"
import type { Provider } from "../../src/types.js"
import { Root } from "../setup/react.js"

// Element holders against a real tree
// ========================================
//
// The three timing guarantees the design rests on, all of them properties of REACT's commit order rather
// than of anything we schedule:
//
//   1. refs attach during the commit's mutation phase; `module.mount()` runs in a passive effect. A service
//      reading `ref.current` in `onModuleMount` therefore already sees the element.
//   2. on deletion React detaches refs (calls the callback with null) before it runs passive cleanups, so
//      `onModuleUnmount` sees null.
//   3. a `deps` swap builds a new module, so the new generation resolves a FRESH holder.
//
// No decorators and no metadata emit: the service reads its holder with `inject()` from the kernel's
// construction frame.

class InputRef extends Ref<HTMLInputElement> {}
class FieldRefs extends RefMap<HTMLInputElement> {}

/** A service that records `ref.current` at each lifecycle phase it is asked about. */
function reader(seen: Record<string, HTMLElement | null | undefined>): Provider {
    const Service = class {
        private readonly ref = inject(InputRef)

        onModuleInit(): void {
            seen.init = this.ref.current
        }
        onModuleMount(): void {
            seen.mount = this.ref.current
        }
        onModuleUnmount(): void {
            seen.unmount = this.ref.current
        }
    }

    return Service as unknown as Provider
}

function Input(): JSX.Element {
    const ref = useResolve(InputRef)
    return <input data-testid="input" ref={ref.set} />
}

describe("Ref in a module", () => {
    it("is populated before onModuleMount, and read through DI rather than props", () => {
        const seen: Record<string, HTMLElement | null | undefined> = {}

        const { getByTestId } = render(
            <Root providers={[InputRef, reader(seen)]}>
                <Input />
            </Root>
        )

        // init runs before the tree has committed anything — nothing is attached yet.
        expect(seen.init).toBeNull()
        // mount runs in a passive effect, after the DOM node exists and the ref callback has fired.
        expect(seen.mount).toBe(getByTestId("input"))
    })

    it("is null again by onModuleUnmount", () => {
        const seen: Record<string, HTMLElement | null | undefined> = {}

        const { unmount } = render(
            <Root providers={[InputRef, reader(seen)]}>
                <Input />
            </Root>
        )
        expect(seen.mount).not.toBeNull()

        unmount()

        // React detaches refs during the deletion pass, ahead of the passive cleanup that unmounts us.
        expect(seen.unmount).toBeNull()
    })

    it("resolves through the module chain from a nested component", () => {
        let holder: InputRef | null = null

        function Probe(): ReactNode {
            holder = useResolve(InputRef)
            return null
        }

        const { getByTestId } = render(
            <Root providers={[InputRef]}>
                <ModuleProvider>
                    <Input />
                    <Probe />
                </ModuleProvider>
            </Root>
        )

        // One holder for the whole subtree: the child module resolves the root's singleton.
        expect(holder!.current).toBe(getByTestId("input"))
    })
})

describe("Ref across a rebuild", () => {
    it("gives the new generation a fresh holder and leaves the old one detached", () => {
        const holders: InputRef[] = []
        let bump = (): void => {}

        function Generation(): JSX.Element {
            const [generation, setGeneration] = useState(0)
            bump = () => setGeneration((current) => current + 1)

            return (
                <ModuleProvider providers={[InputRef]} deps={[generation]}>
                    <Collect />
                </ModuleProvider>
            )
        }

        function Collect(): JSX.Element {
            const ref = useResolve(InputRef)
            if (holders.at(-1) !== ref) holders.push(ref)
            return <input data-testid="input" ref={ref.set} />
        }

        const { getByTestId } = render(
            <Root>
                <Generation />
            </Root>
        )

        const first = holders[0]!
        expect(first.current).toBe(getByTestId("input"))

        act(() => bump())

        const second = holders[1]!
        expect(second).not.toBe(first)

        // MEASURED, not assumed: the rebuild swaps the module, so `useResolve` hands back a new holder and
        // the JSX `ref` prop is a new function identity. React detaches the old callback (null) before
        // attaching the new one, so the abandoned holder ends the swap empty — it does not keep a stale
        // element alive after its module is destroyed.
        expect(first.current).toBeNull()
        expect(second.current).toBe(getByTestId("input"))
    })
})

// RefMap in a list
// ========================================

describe("RefMap in a list", () => {
    let fields: FieldRefs | null = null

    function List({ ids }: { ids: string[] }): JSX.Element {
        fields = useResolve(FieldRefs)

        return (
            <>
                {ids.map((id) => (
                    <input key={id} data-testid={id} ref={fields!.set(id)} />
                ))}
            </>
        )
    }

    function tree(ids: string[]): JSX.Element {
        return (
            <Root providers={[FieldRefs]}>
                <List ids={ids} />
            </Root>
        )
    }

    it("tracks exactly the mounted set, in DOM order", () => {
        const { getByTestId, rerender } = render(tree(["a", "b", "c"]))

        // Attach order is tree order for a freshly mounted list, so this reads as DOM order.
        expect([...fields!.all().keys()]).toEqual(["a", "b", "c"])
        expect(fields!.get("b")).toBe(getByTestId("b"))

        rerender(tree(["a", "c"]))

        expect([...fields!.all().keys()]).toEqual(["a", "c"])
        expect(fields!.get("b")).toBeNull()
    })

    it("reuses the cached callback when a key remounts", () => {
        const { rerender, getByTestId } = render(tree(["a", "b"]))

        const callback = fields!.set("b")
        const stayed = fields!.get("a")

        rerender(tree(["a"]))
        expect(fields!.get("b")).toBeNull()

        rerender(tree(["a", "b"]))

        // Same function object throughout — that is what lets the row reattach without the map ever seeing
        // a second callback for the key. The row that stayed mounted was never detached at all.
        expect(fields!.set("b")).toBe(callback)
        expect(fields!.get("b")).toBe(getByTestId("b"))
        expect(fields!.get("a")).toBe(stayed)
    })
})
