import { useContext } from "react"

import type { Resolver } from "@remodulo/container"
import type { Module } from "../core/module.js"
import { ModuleContext, type ModuleContextValue } from "./ModuleContext.js"

export function useModuleContext(): ModuleContextValue {
    const value = useContext(ModuleContext)

    if (!value) {
        throw new Error("useModuleContext: no module in context. Wrap with <AppProvider> or <ModuleProvider>.")
    }

    return value
}

export function useModule(): Module {
    return useModuleContext().module
}

export function useResolver(): Resolver {
    return useModuleContext().module.resolver
}

export function useModuleRebuild(): () => void {
    return useModuleContext().rebuild
}
