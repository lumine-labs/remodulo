import type { ProviderLifecycle } from "@remodulo/react"

// ViewModel
// ========================================

export type Disposer = () => void

const HOOKS = ["onModuleInit", "onModuleMount", "onModuleUnmount", "onModuleDestroy"] as const
const SHORT: Record<(typeof HOOKS)[number], string> = {
    onModuleInit: "onInit",
    onModuleMount: "onMount",
    onModuleUnmount: "onUnmount",
    onModuleDestroy: "onDestroy",
}

export abstract class ViewModel implements ProviderLifecycle {
    constructor() {
        for (
            let proto = Object.getPrototypeOf(this);
            proto !== ViewModel.prototype;
            proto = Object.getPrototypeOf(proto)
        ) {
            for (const key of HOOKS) {
                if (Object.getOwnPropertyDescriptor(proto, key)) {
                    throw new Error(`ViewModel seals ${key}() — override ${SHORT[key]}() instead.`)
                }
            }
        }
        for (const key of HOOKS) {
            Object.defineProperty(this, key, { value: ViewModel.prototype[key], writable: false, configurable: false })
        }
    }

    // Hooks
    // ----------------------------------------

    /** @internal */
    onModuleInit(): void {
        this.onInit?.()
    }
    /** @internal */
    onModuleMount(): void {
        this.onMount?.()
    }
    /** @internal */
    onModuleUnmount(): void {
        this.onUnmount?.()
    }
    /** @internal */
    onModuleDestroy(): void {
        try {
            this.onDestroy?.()
        } finally {
            this.#teardown()
        }
    }

    // Shorthand overrides for lifecycle hooks
    protected onInit?(): void
    protected onMount?(): void
    protected onUnmount?(): void
    protected onDestroy?(): void

    // AbortController
    // ----------------------------------------

    #controller: AbortController | null = null

    protected signal(): AbortSignal {
        this.#controller ??= new AbortController()
        return this.#controller.signal
    }

    // Disposers
    // ----------------------------------------

    readonly #disposers: Disposer[] = []

    protected track<T extends Disposer>(disposer: T): T {
        this.#disposers.push(disposer)
        return disposer
    }

    #teardown(): void {
        const disposers = this.#disposers.splice(0).reverse()
        for (const dispose of disposers) {
            try {
                dispose()
            } catch (error) {
                console.error("ViewModel disposer", error)
            }
        }

        this.#controller?.abort()
    }
}
