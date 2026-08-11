import { useEffect } from "react"

import type { Module } from "../core/module.js"
import { ModuleStatus } from "../core/module-lifecycle.types.js"

// Module Lifecycle
// ========================================

const scheduled = new WeakMap<Module, ReturnType<typeof setTimeout>>()

export function useModuleLifecycle(module: Module): void {
    useEffect(() => {
        cancelDestroy(module)

        if (isResting(module)) module.mount()

        return () => {
            try {
                if (module.status === ModuleStatus.Mounted) module.unmount()
            } finally {
                scheduleDestroy(module)
            }
        }
    }, [module])
}

function isResting(module: Module): boolean {
    return module.status === ModuleStatus.Initialized || module.status === ModuleStatus.Unmounted
}

function scheduleDestroy(module: Module): void {
    cancelDestroy(module)

    const timer = setTimeout(() => {
        scheduled.delete(module)
        void module.destroy()
    }, 0)

    scheduled.set(module, timer)
}

function cancelDestroy(module: Module): void {
    const timer = scheduled.get(module)
    if (timer === undefined) return

    clearTimeout(timer)
    scheduled.delete(module)
}
