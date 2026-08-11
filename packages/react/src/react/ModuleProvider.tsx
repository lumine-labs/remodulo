import { useContext, useMemo, useRef, useState, type JSX, type ReactNode } from "react"
import { useEvent, useIsomorphicLayoutEffect, useScheduleLayoutEffect } from "@luminelabs/react-toolkit"

import type { Resolver } from "@remodulo/container"
import { Module } from "../core/module.js"
import type { ModuleParams } from "../core/module.types.js"
import type { ModuleHooks } from "../core/module-lifecycle.types.js"
import { ModuleContext } from "./ModuleContext.js"
import { useModuleLifecycle } from "./useModuleLifecycle.js"

// ModuleProvider
// ========================================

export type ModuleProviderProps = ModuleParams & {
    deps?: unknown[]
    children?: ReactNode
}

export function ModuleProvider({ children, deps, ...params }: ModuleProviderProps): JSX.Element {
    const { module, rebuild } = useModule(params, deps)

    const value = useMemo(() => ({ module, rebuild }), [module, rebuild])

    return <ModuleContext.Provider value={value}>{children}</ModuleContext.Provider>
}

// useModule (internal)
// ========================================

/** The module, plus the parent it was built under — so a render can tell whether it is still the right one. */
type ModuleState = {
    parent: Module | null
    module: Module
}

function useModule(params: ModuleParams, deps?: unknown[]): { module: Module; rebuild: () => void } {
    const parent = useContext(ModuleContext)?.module ?? null

    const hooks = useModuleHooks(params)
    const [state, setState] = useState<ModuleState>(() => ({
        parent,
        module: createScopedModule(parent, params, hooks),
    }))

    if (state.parent !== parent) {
        setState({ parent, module: createScopedModule(parent, params, hooks) })
    }

    // Lifecycle signals
    // ------------------------------------

    useModuleLifecycle(state.module)

    // Rebuild
    // ------------------------------------

    const schedule = useScheduleLayoutEffect()

    const performRebuild = useEvent(() => {
        setState({ parent, module: createScopedModule(parent, params, hooks) })
    })

    const rebuild = useEvent(() => {
        schedule("module.rebuild", performRebuild)
    })

    const prevDepsRef = useRef<unknown[] | undefined>(deps)
    useIsomorphicLayoutEffect(() => {
        const prev = prevDepsRef.current
        prevDepsRef.current = deps
        if (depsChanged(prev, deps)) rebuild()
    })

    return { module: state.module, rebuild }
}

function createScopedModule(parent: Module | null, params: ModuleParams, hooks: ModuleHooks): Module {
    if (!parent) {
        throw new Error(
            "ModuleProvider requires a parent module in context. Wrap it in <AppProvider>, or nest it under another <ModuleProvider>."
        )
    }

    const module = new Module(parent, { ...params, ...hooks })
    module.init()
    return module
}

// Hook bridge
// ========================================

function useModuleHooks(params: ModuleParams): ModuleHooks {
    const onModuleInit = useEvent((resolver: Resolver) => params.onModuleInit?.(resolver))
    const onModuleMount = useEvent((resolver: Resolver) => params.onModuleMount?.(resolver))
    const onModuleUnmount = useEvent((resolver: Resolver) => params.onModuleUnmount?.(resolver))
    const onModuleDestroy = useEvent((resolver: Resolver) => params.onModuleDestroy?.(resolver))

    return { onModuleInit, onModuleMount, onModuleUnmount, onModuleDestroy }
}

// Helpers
// ========================================

function depsChanged(prev: unknown[] | undefined, next: unknown[] | undefined): boolean {
    if (prev === undefined || next === undefined) return false
    if (prev.length !== next.length) return true
    return prev.some((value, index) => !Object.is(value, next[index]))
}
