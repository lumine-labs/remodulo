import { createModuleComponent } from "@remodulo/react"

import { mobxProps } from "./mobxProps.js"

// createMobxModuleComponent
// ========================================

// The base factory's parameter list, read off the function itself with an instantiation expression so the
// wrapper cannot drift from it. Naming `ModuleConfig`/`PropsBridgeOptions`/`ComponentType`/`ReactNode`
// again would be a second copy of a signature that already exists.
type FactoryArgs<P extends object, T extends object> = Parameters<typeof createModuleComponent<P, T>>

// `createModuleComponent` with the MobX props bridge already wired: the `adapter` slot is owned here, so
// the props param takes `use` and `token` only.
export function createMobxModuleComponent<P extends object = {}, T extends object = P>(
    config?: FactoryArgs<P, T>[0],
    props?: Omit<NonNullable<FactoryArgs<P, T>[1]>, "adapter">
): ReturnType<typeof createModuleComponent<P, T>> {
    // Minted once per component, at definition time — the adapter is a hook dependency of the bridge.
    const adapter = mobxProps<T>()

    return createModuleComponent<P, T>(config, { ...props, adapter })
}
