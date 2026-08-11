import { useMemo, useState, type JSX, type ReactNode } from "react"

import type { App } from "../core/module.js"
import { ModuleStatus } from "../core/module-lifecycle.types.js"
import { ModuleContext } from "./ModuleContext.js"
import { useModuleLifecycle } from "./useModuleLifecycle.js"

// AppProvider
// ========================================

export type AppProviderProps = {
    app: App | (() => App)
    children?: ReactNode
}

/** React root for an App: captures it once and owns its init, mount, unmount and destroy. */
export function AppProvider({ app, children }: AppProviderProps): JSX.Element {
    const [ownedApp] = useState(() => (typeof app === "function" ? app() : app))

    if (typeof app !== "function" && app !== ownedApp) {
        throw new Error("AppProvider does not support replacing its App instance")
    }

    if (ownedApp.status === ModuleStatus.Created) {
        try {
            ownedApp.init()
        } catch (error) {
            console.error("App failed to initialize:", error)
            throw error
        }
    }

    if (ownedApp.status === ModuleStatus.Failed) {
        throw new Error("App failed to initialize.")
    }

    if (ownedApp.status === ModuleStatus.Destroying || ownedApp.status === ModuleStatus.Destroyed) {
        throw new Error("App was destroyed. Provide a fresh App.")
    }

    useModuleLifecycle(ownedApp)

    const value = useMemo(() => ({ module: ownedApp, rebuild: noop }), [ownedApp])

    return <ModuleContext.Provider value={value}>{children}</ModuleContext.Provider>
}

// Helpers
// ========================================

function noop(): void {}
