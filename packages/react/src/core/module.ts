import { Container, Resolver } from "@remodulo/container"

import { flattenProviders, registerProviders } from "./provider.js"
import type { Provider } from "./provider.types.js"
import type { ModuleHooks } from "./module-lifecycle.types.js"
import { ModuleStatus } from "./module-lifecycle.types.js"
import type { ModuleParams } from "./module.types.js"
import { childOfDeadParent, childOfUninitializedParent } from "./module.errors.js"
import { ModuleLifecycle } from "./module-lifecycle.js"
import { ModuleTraversal } from "./module-traversal.js"
import { id } from "./id.js"

// Module
// ========================================

export class Module {
    readonly id: string
    /** @internal The module's own container, for internal machinery. Consumers resolve through `resolver`. */
    readonly container: Container

    readonly parent: Module | null
    readonly #children = new Set<Module>()

    readonly resolver: Resolver
    readonly traversal: ModuleTraversal
    /** @internal */ readonly lifecycle: ModuleLifecycle

    constructor(parent: Module | null, params?: ModuleParams) {
        if (parent) {
            const status = parent.status

            if (status === ModuleStatus.Created || status === ModuleStatus.Initializing) {
                throw new Error(childOfUninitializedParent)
            }

            if (
                status === ModuleStatus.Failed ||
                status === ModuleStatus.Destroying ||
                status === ModuleStatus.Destroyed
            ) {
                throw new Error(childOfDeadParent(status))
            }
        }

        this.parent = parent
        this.container = parent ? parent.container.fork() : new Container()
        this.id = params?.id ?? id()

        this.resolver = Resolver.for(this.container)

        const { onModuleInit, onModuleMount, onModuleUnmount, onModuleDestroy } = params ?? {}
        const hooks: ModuleHooks = { onModuleInit, onModuleMount, onModuleUnmount, onModuleDestroy }

        this.traversal = new ModuleTraversal(this)
        this.lifecycle = new ModuleLifecycle(this, hooks)

        // System providers: the module's own machinery.
        const system: Provider[] = [
            { provide: Module, useValue: this },
            { provide: Resolver, useValue: this.resolver },
            { provide: ModuleTraversal, useValue: this.traversal },
        ]
        const user = flattenProviders(params?.providers ?? [])

        registerProviders(this.container, [...system, ...user])
    }

    // Phases
    // ========================================

    init(): void {
        this.lifecycle.init()
    }

    mount(): void {
        this.lifecycle.mount()
    }

    unmount(): void {
        this.lifecycle.unmount()
    }

    destroy(): Promise<void> {
        return this.lifecycle.destroy()
    }

    // Status
    // ========================================

    get status(): ModuleStatus {
        return this.lifecycle.status
    }

    // Children
    // ========================================

    get children(): ReadonlySet<Module> {
        return this.#children
    }

    /** @internal Attach point for the lifecycle's commit. Consumers read `children`. */
    addChild(child: Module): void {
        this.#children.add(child)
    }

    /** @internal Detach point for the lifecycle's rollback and unlink. Consumers read `children`. */
    removeChild(child: Module): void {
        this.#children.delete(child)
    }
}

// App
// ========================================

export class App extends Module {
    // Type-only brand: a private member makes App nominal, so a bare Module is not assignable to App.
    // `declare` emits no runtime field.
    declare private readonly __appBrand: undefined

    constructor(params?: ModuleParams) {
        super(null, params)
    }
}

// Errors
// ========================================
