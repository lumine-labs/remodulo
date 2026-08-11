import { afterEach, describe, expect, it, vi } from "vitest"

import { ModuleStatus } from "../../src/core/module-lifecycle.types.js"
import { makeApp, makeChild, tracked } from "../setup/helpers.js"

// Hook errors.
// ========================================
//
// A failed phase is fatal to the module, but the constructive and destructive phases fail differently:
//
//   init     — abort at the first throw, propagate it raw out of `Module.init()`.
//   mount    — abort at the first throw, tear the module down (see errors-torture), rethrow the ORIGINAL.
//   unmount  — fail-safe: run every hook, then throw one AggregateError carrying them in the order raised.
//   destroy  — fail-safe: run every hook, `console.error("module.destroy", ...)` each, never throw.
//
// React callers recover from the throwing phases with an ErrorBoundary, imperative callers with try/catch.

afterEach(() => {
    vi.restoreAllMocks()
})

describe("throwing phases", () => {
    it("throws out of init", () => {
        const log: string[] = []

        expect(() =>
            makeApp({
                providers: [tracked(log, "A"), tracked(log, "B", { throwOn: "init" })],
            })
        ).toThrow("B init")
    })

    it("throws out of mount", () => {
        const log: string[] = []
        const module = makeApp({
            providers: [tracked(log, "A"), tracked(log, "B", { throwOn: "mount" })],
        })

        expect(() => module.mount()).toThrow("B mount")
    })

    it("throws an AggregateError out of unmount, carrying the raw hook error", () => {
        const log: string[] = []
        const module = makeApp({
            providers: [tracked(log, "A"), tracked(log, "B", { throwOn: "unmount" })],
        })
        module.mount()

        let caught: unknown
        try {
            module.unmount()
        } catch (error) {
            caught = error
        }

        expect(caught).toBeInstanceOf(AggregateError)
        expect((caught as AggregateError).errors.map((error) => (error as Error).message)).toEqual(["B unmount"])
    })

    it("abandons the rest of the init phase", () => {
        const log: string[] = []
        const first = tracked(log, "A")
        const last = tracked(log, "C")

        expect(() =>
            makeApp({
                providers: [first, tracked(log, "B", { throwOn: "init" }), last],
            })
        ).toThrow("B init")

        expect([first.counts.init, last.counts.init]).toEqual([1, 0])
    })

    it("abandons the rest of the mount phase", () => {
        const log: string[] = []
        const first = tracked(log, "A")
        const last = tracked(log, "C")
        const module = makeApp({
            providers: [first, tracked(log, "B", { throwOn: "mount" }), last],
        })

        expect(() => module.mount()).toThrow("B mount")
        expect([first.counts.mount, last.counts.mount]).toEqual([1, 0])
    })

    it("finishes the rest of the unmount phase after a hook throws", () => {
        const log: string[] = []
        const first = tracked(log, "A")
        const last = tracked(log, "C")
        const module = makeApp({
            providers: [first, tracked(log, "B", { throwOn: "unmount" }), last],
        })
        module.mount()

        // Unmount walks in reverse and is fail-safe: C runs, B throws, A still runs.
        expect(() => module.unmount()).toThrow(AggregateError)
        expect([first.counts.unmount, last.counts.unmount]).toEqual([1, 1])
        expect(module.status).not.toBe(ModuleStatus.Mounted)
    })

    it("carries every failure in the aggregate, in the order they were raised", () => {
        const log: string[] = []
        const module = makeApp({
            providers: [
                tracked(log, "A", { throwOn: "unmount" }),
                tracked(log, "B"),
                tracked(log, "C", { throwOn: "unmount" }),
            ],
            onModuleUnmount: () => {
                throw new Error("module unmount")
            },
        })
        module.mount()

        let caught: unknown
        try {
            module.unmount()
        } catch (error) {
            caught = error
        }

        // Instances run reversed (C, B, A) and the module hook goes last, so that is the aggregate's order.
        expect(caught).toBeInstanceOf(AggregateError)
        expect((caught as AggregateError).errors).toHaveLength(3)
        expect((caught as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
            "C unmount",
            "A unmount",
            "module unmount",
        ])
    })

    it("costs every provider its init when the module init hook throws", () => {
        const log: string[] = []
        const service = tracked(log, "A")

        expect(() =>
            makeApp({
                providers: [service],
                onModuleInit: () => {
                    throw new Error("module init")
                },
            })
        ).toThrow("module init")

        expect(service.counts.init).toBe(0)
        expect(log).toEqual(["A:ctor"])
    })

    it("costs every provider its mount when the module mount hook throws", () => {
        const log: string[] = []
        const service = tracked(log, "A")
        const module = makeApp({
            providers: [service],
            onModuleMount: () => {
                throw new Error("module mount")
            },
        })
        log.length = 0

        expect(() => module.mount()).toThrow("module mount")
        expect(service.counts.mount).toBe(0)
    })

    it("propagates the original error object", () => {
        const boom = new Error("boom")
        class Exploding {
            onModuleInit(): void {
                throw boom
            }
        }

        let caught: unknown
        try {
            makeApp({ providers: [{ provide: Exploding, useValue: new Exploding() }] })
        } catch (error) {
            caught = error
        }

        expect(caught).toBe(boom)
    })

    /**
     * Characterisation: a mount hook that throws aborts the cascade where it stands — the module is never
     * marked mounted and its children never receive their mount.
     */
    it("aborts the mount cascade when a parent hook throws", () => {
        const log: string[] = []
        const childService = tracked(log, "C")
        const parent = makeApp({
            providers: [tracked(log, "P", { throwOn: "mount" })],
        })
        const child = makeChild(parent, { providers: [childService] })
        child.mount()

        expect(() => parent.mount()).toThrow("P mount")
        expect(childService.counts.mount).toBe(0)
    })
})

describe("destroy", () => {
    it("logs a destroy error instead of rejecting", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        const log: string[] = []
        const module = makeApp({
            providers: [tracked(log, "A"), tracked(log, "B", { throwOn: "destroy" })],
        })
        module.mount()
        module.unmount()

        await expect(module.destroy()).resolves.toBeUndefined()

        expect(errorSpy).toHaveBeenCalledTimes(1)
        expect(errorSpy.mock.calls[0]?.[0]).toBe("module.destroy")
        expect((errorSpy.mock.calls[0]?.[1] as Error).message).toBe("B destroy")
    })

    it("keeps destroying the rest after one hook throws", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        const log: string[] = []
        const first = tracked(log, "A")
        const last = tracked(log, "C")
        const module = makeApp({
            providers: [first, tracked(log, "B", { throwOn: "destroy" }), last],
        })
        module.mount()
        module.unmount()
        log.length = 0

        await module.destroy()

        expect(log).toEqual(["C:destroy", "A:destroy"])
        expect([first.counts.destroy, last.counts.destroy]).toEqual([1, 1])
        expect(errorSpy).toHaveBeenCalledTimes(1)
    })

    it("logs once per failing instance", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        const log: string[] = []
        const module = makeApp({
            providers: [
                tracked(log, "A", { throwOn: "destroy" }),
                tracked(log, "B", { throwOn: "destroy" }),
                tracked(log, "C"),
            ],
        })
        module.mount()
        module.unmount()

        await module.destroy()

        expect(errorSpy).toHaveBeenCalledTimes(2)
        expect(errorSpy.mock.calls.map((call) => (call[1] as Error).message)).toEqual(["B destroy", "A destroy"])
    })

    it("still runs the module destroy hook after an instance throws", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        const log: string[] = []
        const module = makeApp({
            providers: [tracked(log, "B", { throwOn: "destroy" })],
            onModuleDestroy: () => log.push("module:destroy"),
        })
        module.mount()
        module.unmount()
        log.length = 0

        await module.destroy()

        expect(log).toEqual(["module:destroy"])
        expect(errorSpy).toHaveBeenCalledTimes(1)
    })

    it("logs a failing module destroy hook and still resolves", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        const module = makeApp({
            onModuleDestroy: () => {
                throw new Error("module destroy")
            },
        })
        module.mount()
        module.unmount()

        await expect(module.destroy()).resolves.toBeUndefined()

        expect(errorSpy).toHaveBeenCalledTimes(1)
        expect((errorSpy.mock.calls[0]?.[1] as Error).message).toBe("module destroy")
    })
})
