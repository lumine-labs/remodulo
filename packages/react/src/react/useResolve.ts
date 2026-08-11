import { useLazyRef } from "@luminelabs/react-toolkit"

import type { InjectionToken, ResolveMode, Resolver } from "@remodulo/container"
import { useResolver } from "./useModuleContext.js"

// Types
// ========================================

type ResolveSnapshot<T> = {
    resolver: Resolver
    token: InjectionToken<T>
    mode: ResolveMode
    value: T
}

// Hooks
// ========================================

export function useResolve<T>(token: InjectionToken<T>, mode: ResolveMode = "nearest"): T {
    const resolver = useResolver()
    const ref = useLazyRef<ResolveSnapshot<T>>(() => ({
        resolver,
        token,
        mode,
        value: resolver.resolve(token, mode),
    }))

    const current = ref.current
    if (current.resolver !== resolver || current.token !== token || current.mode !== mode) {
        ref.current = { resolver, token, mode, value: resolver.resolve(token, mode) }
    }

    return ref.current.value
}

export function useResolveOptional<T>(token: InjectionToken<T>, mode: ResolveMode = "nearest"): T | undefined {
    const resolver = useResolver()
    const ref = useLazyRef<ResolveSnapshot<T | undefined>>(() => ({
        resolver,
        token,
        mode,
        value: resolver.resolveOptional(token, mode),
    }))

    const current = ref.current
    if (current.resolver !== resolver || current.token !== token || current.mode !== mode) {
        ref.current = { resolver, token, mode, value: resolver.resolveOptional(token, mode) }
    }

    return ref.current.value
}
