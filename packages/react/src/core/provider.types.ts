import type {
    Constructor,
    ExistingProvider as KernelExistingProvider,
    FactoryProvider as KernelFactoryProvider,
    SelfClassProvider as KernelSelfClassProvider,
    TokenClassProvider as KernelTokenClassProvider,
    ValueProvider as KernelValueProvider,
} from "@remodulo/container/types"
import type { Feature } from "./feature.js"

// Providers
// ========================================

type Lazy<P> = P & {
    /** Skip the owner's eager pass; materialize on first resolve instead. */
    lazy?: boolean
}

export type TokenClassProvider<T = any> = Lazy<KernelTokenClassProvider<T>>
export type SelfClassProvider<T = any> = Lazy<KernelSelfClassProvider<T>>
export type ClassProvider<T = any> = TokenClassProvider<T> | SelfClassProvider<T>
export type FactoryProvider<T = any> = Lazy<KernelFactoryProvider<T>>
export type ValueProvider<T = any> = Lazy<KernelValueProvider<T>>
export type ExistingProvider<T = any> = Lazy<KernelExistingProvider<T>>

export type Provider<T = any> =
    Constructor<T> | ClassProvider<T> | ValueProvider<T> | FactoryProvider<T> | ExistingProvider<T>

export type ProviderInput = Provider | Feature
