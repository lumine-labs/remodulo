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

export abstract class ViewModel {
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

    private onModuleInit(): void {
        this.onInit?.()
    }

    private onModuleMount(): void {
        this.onMount?.()
    }

    private onModuleUnmount(): void {
        try {
            this.onUnmount?.()
        } finally {
            this.#release()
        }
    }

    private async onModuleDestroy(): Promise<void> {
        try {
            await this.onDestroy?.()
        } finally {
            this.#release()
        }
    }

    // Shorthand overrides for lifecycle hooks
    protected onInit?(): void
    protected onMount?(): void
    protected onUnmount?(): void
    protected onDestroy?(): void | Promise<void>

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

    #release(): void {
        const disposers = this.#disposers.splice(0).reverse()
        for (const dispose of disposers) {
            try {
                dispose()
            } catch (error) {
                console.error("ViewModel disposer", error)
            }
        }

        this.#controller?.abort()
        this.#controller = null
    }
}
