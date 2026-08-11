import { act, render, screen } from "@testing-library/react"
import { autorun } from "mobx"
import { inject } from "@remodulo/container"
import { App, AppProvider, createModuleComponent, PropsRef, useResolve } from "@remodulo/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"

import { mobxProps } from "../src/mobxProps"

// Fixture: a service whose factory body reads the bridged props with `inject()` — no decorators
// anywhere.
// ========================================

type Coords = { x: number; y: number }

class Tracker {
    constructor(readonly props: PropsRef<Coords>) {}
}

// Module-scope adapter: identity-stable by construction, which is required — see mobxProps.ts.
const adapter = mobxProps<Coords>()

const TrackerModule = createModuleComponent<Coords>(
    { providers: [{ provide: Tracker, useFactory: () => new Tracker(inject<PropsRef<Coords>>(PropsRef)) }] },
    { adapter }
)

let capturedTracker: Tracker | null = null

function Probe() {
    capturedTracker = useResolve(Tracker)
    return <span data-testid="x">{capturedTracker.props.current.x}</span>
}

let setCoords: ((coords: Coords) => void) | null = null

function Harness() {
    const [app] = useState(() => new App())
    const [coords, setCoordsState] = useState<Coords>({ x: 1, y: 1 })
    setCoords = setCoordsState
    return (
        <AppProvider app={app}>
            <TrackerModule {...coords}>
                <Probe />
            </TrackerModule>
        </AppProvider>
    )
}

describe("mobxProps as the usePropsRef/createModuleComponent adapter", () => {
    beforeEach(() => {
        capturedTracker = null
        setCoords = null
    })

    it("creates once, updates the same observable in place, and keeps a MobX reaction alive across a render-driven prop change", () => {
        const createSpy = vi.spyOn(adapter, "create")
        const updateSpy = vi.spyOn(adapter, "update")

        render(<Harness />)
        expect(screen.getByTestId("x").textContent).toBe("1")
        expect(createSpy).toHaveBeenCalledTimes(1)

        const target = capturedTracker!.props.current

        const seenX: number[] = []
        const dispose = autorun(() => {
            seenX.push(target.x)
        })
        expect(seenX).toEqual([1])

        act(() => {
            setCoords?.({ x: 2, y: 1 })
        })

        // Same PropsRef value, same underlying observable -- update mutated in place, never recreated.
        expect(createSpy).toHaveBeenCalledTimes(1)
        expect(updateSpy).toHaveBeenCalledTimes(1)
        expect(capturedTracker!.props.current).toBe(target)
        expect(target.x).toBe(2)

        // The autorun attached before the update still fired -- proves the reaction survived. (The DOM
        // itself is NOT expected to re-render here: `Probe` is a plain component, not wrapped in MobX's
        // `observer()` -- `mobx-react-lite` is deliberately out of scope for this scaffold, see
        // agent-notes/roadmap.md. Driving React re-renders from the observable is that package's job;
        // this adapter's contract ends at "the observable mutates in place and reactions keep tracking".)
        expect(seenX).toEqual([1, 2])

        dispose()
        createSpy.mockRestore()
        updateSpy.mockRestore()
    })
})
