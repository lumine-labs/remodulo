import type { ModuleHook } from "./module-lifecycle.types.js"
import type { ProviderInput } from "./provider.types.js"

// Params
// ========================================

export type ModuleParams = {
    id?: string
    providers?: readonly ProviderInput[]

    onModuleInit?: ModuleHook
    onModuleMount?: ModuleHook
    onModuleUnmount?: ModuleHook
    onModuleDestroy?: ModuleHook
}
