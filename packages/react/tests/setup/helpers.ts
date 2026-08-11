import { App, Module } from "../../src/core/module.js"
import type { ModuleParams } from "../../src/core/module.types.js"
import type { Provider } from "../../src/types.js"

// Shared test helpers
// ========================================
//
// No decorators and no metadata emit: a service is a plain class, and every dependency it needs it reads
// with `inject()` from the kernel's construction frame.

export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// Imperative construction
// ========================================
//
// 0.5.0 splits construction from init: `new Module(...)` builds and registers, `init()` arms the lifecycle.
// These builders bundle the two so a test that only cares about a live module reads as one line — exactly
// what `ModuleProvider`/`AppProvider` do for you in React. Tests that assert the split itself construct raw.

/** An initialized App (parent `null`), ready to drive through mount / unmount / destroy. */
export function makeApp(params?: ModuleParams): App {
    const app = new App(params)
    app.init()
    return app
}

/** An initialized scoped child of `parent`. Throws at construction if `parent` is not yet initialized. */
export function makeChild(parent: Module, params?: ModuleParams): Module {
    const child = new Module(parent, params)
    child.init()
    return child
}

// Gate refusals
// ========================================

/**
 * The refusal a phase gate throws, matched WHOLE: which signal was sent, the status it was sent from, and
 * the remedy tail naming what that gate does accept. Every phase is a THROW now — a module no longer
 * collapses a signal it cannot serve — so this is the single most repeated assertion in the suite, and
 * matching only the first half let a gate silently change what it advertises without a cell noticing.
 */
/** What each gate says it accepts, mirroring the `expected` array the phase method passes to `wrongStatus`. */
const ACCEPTED: Record<Signal, readonly string[]> = {
    init: ["created"],
    mount: ["initialized", "unmounted"],
    unmount: ["mounted"],
    destroy: ["created", "initialized", "unmounted", "failed"],
}

type Signal = "init" | "mount" | "unmount" | "destroy"

export function refuses(signal: Signal, status: string): RegExp {
    const accepted = ACCEPTED[signal].map((state) => `"${state}"`).join(" or ")
    return new RegExp(escapeRegExp(`Cannot ${signal}() a module whose status is "${status}" — ${signal}() accepts ${accepted}.`))
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export type HookCounts = { init: number; mount: number; unmount: number; destroy: number }

export type TrackedOptions = {
    /** Suspend for this many ms inside onModuleDestroy before recording it. */
    destroyDelay?: number
    /** Throw from this phase. */
    throwOn?: "init" | "mount" | "unmount" | "destroy"
}

export type Tracked = Provider & { counts: HookCounts }

/**
 * A class that appends `<label>:<phase>` to `log` for every lifecycle hook and counts them.
 * Returned as a Provider so it can be used as a bare constructor-shorthand or as `useClass`.
 */
export function tracked(log: string[], label: string, options: TrackedOptions = {}): Tracked {
    const counts: HookCounts = { init: 0, mount: 0, unmount: 0, destroy: 0 }

    const Service = class {
        static counts = counts

        constructor() {
            log.push(`${label}:ctor`)
        }

        onModuleInit() {
            if (options.throwOn === "init") throw new Error(`${label} init`)
            counts.init++
            log.push(`${label}:init`)
        }

        onModuleMount() {
            if (options.throwOn === "mount") throw new Error(`${label} mount`)
            counts.mount++
            log.push(`${label}:mount`)
        }

        onModuleUnmount() {
            if (options.throwOn === "unmount") throw new Error(`${label} unmount`)
            counts.unmount++
            log.push(`${label}:unmount`)
        }

        async onModuleDestroy() {
            if (options.throwOn === "destroy") throw new Error(`${label} destroy`)
            if (options.destroyDelay) await new Promise((resolve) => setTimeout(resolve, options.destroyDelay))
            counts.destroy++
            log.push(`${label}:destroy`)
        }
    }

    return Service as unknown as Tracked
}

/** A class with no lifecycle hooks. */
export function plain(label = "plain"): Provider {
    const Service = class {
        readonly label = label
    }
    return Service as unknown as Provider
}

/** Entries in `log` whose phase matches, e.g. `phase(log, "init")`. */
export function phase(log: string[], name: string): string[] {
    return log.filter((entry) => entry.endsWith(`:${name}`))
}
