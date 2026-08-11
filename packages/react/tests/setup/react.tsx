import { useState, type JSX, type ReactNode } from "react"

import { App } from "../../src/core/module.js"
import type { ModuleParams } from "../../src/core/module.types.js"
import { AppProvider } from "../../src/react/AppProvider.js"
import type { Provider } from "../../src/types.js"

// React test helpers
// ========================================

/**
 * A stable App root for tests. The React root is `<AppProvider app={new App(...)}>`; the app must be
 * created once and kept, or every re-render would mint a fresh one and break the mount/unmount identity.
 * `Root` pins it with a lazy `useState`, so a test can wrap a scoped `<ModuleProvider>` and re-render freely.
 */
export function Root({ children, ...params }: ModuleParams & { children?: ReactNode }): JSX.Element {
    const [app] = useState(() => new App(params))
    return <AppProvider app={app}>{children}</AppProvider>
}

/** A class that appends `<label>:<phase>` to `log` for every lifecycle hook. */
export function svc(log: string[], label: string): Provider {
    const Service = class {
        onModuleInit(): void {
            log.push(`${label}:init`)
        }
        onModuleMount(): void {
            log.push(`${label}:mount`)
        }
        onModuleUnmount(): void {
            log.push(`${label}:unmount`)
        }
        async onModuleDestroy(): Promise<void> {
            log.push(`${label}:destroy`)
        }
    }
    return Service as unknown as Provider
}
