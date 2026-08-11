import type { ComponentType, JSX, ReactNode } from "react"

import type { InjectionToken } from "@remodulo/container"
import type { PropsAdapter, PropsRef } from "../primitives/props-ref.js"
import { ModuleProvider, type ModuleProviderProps } from "./ModuleProvider.js"
import { usePropsRef } from "./usePropsRef.js"

// createModuleComponent
// ========================================

export type PropsBridgeOptions<P extends object, T extends object = P> = {
    /**
     * Enrich the raw props before anything else sees them. This is a CUSTOM HOOK — it runs on every render,
     * unconditionally, and may call `useContext` or any other hook.
     */
    use?: (props: P) => T
    /** Update-time transformation applied inside the PropsRef. Pure — no hooks. */
    adapter?: PropsAdapter<T>
    /** The token the PropsRef registers under. Defaults to the `PropsRef` class. */
    token?: InjectionToken<PropsRef<T>>
}

export type ModuleConfig = Omit<ModuleProviderProps, "children">

export function createModuleComponent<P extends object = {}, T extends object = P>(
    config?: ModuleConfig | ((props: T) => ModuleConfig),
    props?: PropsBridgeOptions<P, T>
): ComponentType<P & { children?: ReactNode }> {
    const useProps = props?.use ?? ((p) => p)

    function Module(componentProps: P & { children?: ReactNode }): JSX.Element {
        const { children, ...ownProps } = componentProps
        const rawProps = ownProps as P

        const enriched = useProps(rawProps) as T

        const { provider } = usePropsRef<T, T>(enriched, { adapter: props?.adapter, token: props?.token })

        const resolved = typeof config === "function" ? config(enriched) : config
        const { providers, ...moduleParams } = resolved ?? {}

        return (
            <ModuleProvider {...moduleParams} providers={[provider, ...(providers ?? [])]}>
                {children}
            </ModuleProvider>
        )
    }

    Module.displayName = "Module"

    return Module
}
