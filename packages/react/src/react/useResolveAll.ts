import { useLazyRef } from "@luminelabs/react-toolkit"

import type { InjectionToken, ResolveAllMode, Resolver } from "@remodulo/container"
import { useResolver } from "./useModuleContext.js"

// Types
// ========================================

type ResolveAllSnapshot<T> = {
    resolver: Resolver
    token: InjectionToken<T>
    mode: ResolveAllMode
    value: T[]
}

// Hooks
// ========================================

export function useResolveAll<T>(token: InjectionToken<T>, mode: ResolveAllMode = "chained"): T[] {
    const resolver = useResolver()
    const ref = useLazyRef<ResolveAllSnapshot<T>>(() => ({
        resolver,
        token,
        mode,
        value: resolver.resolveAll(token, mode),
    }))

    const current = ref.current
    if (current.resolver !== resolver || current.token !== token || current.mode !== mode) {
        ref.current = { resolver, token, mode, value: resolver.resolveAll(token, mode) }
    }

    return ref.current.value
}
