import { ContainerEvent, Scope, type InjectionToken } from "@remodulo/container"

import { ModuleStatus, ParticipantStatus } from "./module-lifecycle.types.js"
import type { ModuleHooks, Participant, ProviderLifecycle } from "./module-lifecycle.types.js"
import { mountOntoDeadParent, unarmedResolution, unhealthyTree, wrongStatus } from "./module-lifecycle.errors.js"
import type { Module } from "./module.js"
import { isLazyMetadata } from "./provider.js"

// ModuleLifecycle
// ========================================

export class ModuleLifecycle {
    // State
    // ========================================

    #status: ModuleStatus = ModuleStatus.Created
    #participants = new Map<ProviderLifecycle, Participant>()

    constructor(
        private readonly module: Module,
        private readonly hooks?: ModuleHooks
    ) {
        module.container.on(ContainerEvent.BeforeResolution, ({ token }) => {
            if (
                this.#status === ModuleStatus.Created ||
                this.#status === ModuleStatus.Failed ||
                this.#status === ModuleStatus.Destroyed
            ) {
                throw unarmedResolution(token, this.#status)
            }

            for (let ancestor = module.parent; ancestor !== null; ancestor = ancestor.parent) {
                const status = ancestor.status
                if (status === ModuleStatus.Failed || status === ModuleStatus.Destroyed) {
                    throw unhealthyTree(token, ancestor.id, status)
                }
            }
        })
    }

    get status(): ModuleStatus {
        return this.#status
    }

    // Init Phase
    // ========================================

    init(): void {
        if (this.#status !== ModuleStatus.Created) throw wrongStatus("init", this.#status, [ModuleStatus.Created])

        try {
            this.#runInitPhase()
            this.#status = ModuleStatus.Initialized
        } catch (error) {
            this.#status = ModuleStatus.Failed
            throw error
        }
    }

    #runInitPhase(): void {
        const moduleParticipant = createModuleParticipant(this.hooks ?? {}, this.module)
        if (moduleParticipant) this.#appendParticipant(moduleParticipant)

        this.#collectParticipants()

        for (const participant of this.#participants.values()) {
            if (participant.status !== ParticipantStatus.Registered) continue

            try {
                participant.instance.onModuleInit?.()
                participant.status = ParticipantStatus.Initialized
            } catch (error) {
                participant.status = ParticipantStatus.Failed
                throw error
            }
        }
    }

    #collectParticipants(): void {
        const container = this.module.container

        const eagerTokens = new Map<InjectionToken, { multi: boolean }>()

        for (const entry of container.registrations()) {
            if (entry.kind !== "alias" && entry.scope !== Scope.Singleton) continue

            const lazy = isLazyMetadata(entry.metadata)
            if (!lazy && !eagerTokens.has(entry.token)) {
                eagerTokens.set(entry.token, { multi: entry.multi })
            }
        }

        container.on(ContainerEvent.AfterMaterialize, ({ instance, snapshot }) => {
            if (snapshot.scope !== Scope.Singleton || !isLifecycleCandidate(instance)) return
            this.#appendParticipant(instance)
        })

        this.#status = ModuleStatus.Initializing

        for (const [token, { multi }] of eagerTokens) {
            if (multi) {
                container.resolveAll(token, "self")
            } else {
                container.resolve(token, "self")
            }
        }
    }

    // Mount Phase
    // ========================================

    mount(): void {
        if (this.#status !== ModuleStatus.Initialized && this.#status !== ModuleStatus.Unmounted) {
            throw wrongStatus("mount", this.#status, [ModuleStatus.Initialized, ModuleStatus.Unmounted])
        }

        const attachTo = this.module.parent
        if (attachTo) {
            const status = attachTo.status
            if (
                status === ModuleStatus.Failed ||
                status === ModuleStatus.Destroying ||
                status === ModuleStatus.Destroyed
            ) {
                throw new Error(mountOntoDeadParent(status))
            }
        }

        this.module.parent?.addChild(this.module)

        try {
            const parent = this.module.parent

            if (!parent || parent.status === ModuleStatus.Mounted) {
                this.#mountTree()
            }
        } catch (mountError) {
            const rollbackErrors: unknown[] = []

            this.#unmountTree(rollbackErrors)

            this.module.parent?.removeChild(this.module)
            this.#status = ModuleStatus.Failed

            if (rollbackErrors.length === 0) {
                throw mountError
            }

            throw new AggregateError(
                [mountError, ...rollbackErrors],
                "Module mount failed and rollback encountered errors"
            )
        }
    }

    #mountTree(): void {
        this.#runMountPhase()

        if (this.#status !== ModuleStatus.Destroying) this.#status = ModuleStatus.Mounted

        for (const child of this.#children()) {
            child.#mountTree()
        }
    }

    #runMountPhase(): void {
        for (const participant of this.#participants.values()) {
            if (
                participant.status !== ParticipantStatus.Initialized &&
                participant.status !== ParticipantStatus.Unmounted
            ) {
                continue
            }

            try {
                participant.instance.onModuleMount?.()
                participant.status = ParticipantStatus.Mounted
            } catch (error) {
                participant.status = ParticipantStatus.Failed
                throw error
            }
        }
    }

    // Unmount Phase
    // ========================================

    unmount(): void {
        if (this.#status !== ModuleStatus.Mounted) throw wrongStatus("unmount", this.#status, [ModuleStatus.Mounted])

        const errors: unknown[] = []

        this.#unmountTree(errors)

        if (errors.length > 0) {
            throw new AggregateError(errors, "Errors occurred while unmounting module subtree")
        }
    }

    #unmountTree(errors: unknown[]): void {
        this.#status = ModuleStatus.Unmounted

        for (const child of [...this.#children()].reverse()) {
            child.#unmountTree(errors)
        }

        this.#runUnmountPhase(errors)
    }

    #runUnmountPhase(errors: unknown[]): void {
        for (const participant of [...this.#participants.values()].reverse()) {
            if (participant.status !== ParticipantStatus.Mounted) continue

            try {
                participant.instance.onModuleUnmount?.()
            } catch (error) {
                errors.push(error)
            } finally {
                participant.status = ParticipantStatus.Unmounted
            }
        }
    }

    // Destroy Phase
    // ========================================

    async destroy(): Promise<void> {
        if (this.#status === ModuleStatus.Mounted || this.#status === ModuleStatus.Initializing) {
            throw wrongStatus("destroy", this.#status, [
                ModuleStatus.Created,
                ModuleStatus.Initialized,
                ModuleStatus.Unmounted,
                ModuleStatus.Failed,
            ])
        }

        const nodes = this.#claimSubtree()

        for (const node of nodes) {
            // eslint-disable-next-line no-await-in-loop
            await node.#runDestroyPhase()
        }
    }

    /** Mark this subtree claimed and detach it, returning nodes in destroy order (children-first). Synchronous. */
    #claimSubtree(): ModuleLifecycle[] {
        if (this.#status === ModuleStatus.Destroying || this.#status === ModuleStatus.Destroyed) return []

        const nodes: ModuleLifecycle[] = []

        for (const child of [...this.#children()].reverse()) {
            nodes.push(...child.#claimSubtree())
        }

        this.#status = ModuleStatus.Destroying
        this.module.parent?.removeChild(this.module)

        nodes.push(this)
        return nodes
    }

    async #runDestroyPhase(): Promise<void> {
        try {
            let pending = this.#pendingDrain()

            while (pending.length > 0) {
                for (const participant of pending) {
                    try {
                        // eslint-disable-next-line no-await-in-loop
                        await participant.instance.onModuleDestroy?.()
                    } catch (error) {
                        console.error("module.destroy", error)
                    } finally {
                        participant.status = ParticipantStatus.Destroyed
                    }
                }

                pending = this.#pendingDrain()
            }
        } finally {
            this.#participants.clear()
            this.#status = ModuleStatus.Destroyed
        }
    }

    /** Participants still owed an onModuleDestroy, in drain order. `registered` never inited, so it owns nothing. */
    #pendingDrain(): Participant[] {
        const pending: Participant[] = []

        for (const participant of [...this.#participants.values()].reverse()) {
            if (
                participant.status === ParticipantStatus.Registered ||
                participant.status === ParticipantStatus.Destroyed
            ) {
                continue
            }

            pending.push(participant)
        }

        return pending
    }

    // Append Participant
    // ========================================

    #appendParticipant(instance: ProviderLifecycle): void {
        if (this.#status === ModuleStatus.Destroyed) return

        const existing = this.#participants.get(instance)
        if (existing) return

        const participant = { instance, status: ParticipantStatus.Registered }
        this.#participants.set(instance, participant)

        if (this.#status === ModuleStatus.Created || this.#status === ModuleStatus.Initializing) return
        this.#catchUpParticipant(participant)
    }

    #catchUpParticipant(participant: Participant): void {
        const status = this.#status
        const instance = participant.instance

        if (status === ModuleStatus.Destroying) {
            try {
                instance.onModuleInit?.()
                participant.status = ParticipantStatus.Initialized
            } catch (error) {
                participant.status = ParticipantStatus.Failed
                console.error("module.destroy", error)
            }
            return
        }

        try {
            instance.onModuleInit?.()
            participant.status = ParticipantStatus.Initialized

            if (status === ModuleStatus.Mounted) {
                instance.onModuleMount?.()
                participant.status = ParticipantStatus.Mounted
            }
        } catch (error) {
            participant.status = ParticipantStatus.Failed
            console.error(
                `Lazy lifecycle catch-up failed in module ${this.module.id}.`,
                { participant: participant.instance, status: participant.status },
                error
            )
            throw error
        }
    }

    // Children
    // ========================================

    #children(): ModuleLifecycle[] {
        const children: ModuleLifecycle[] = []
        for (const child of this.module.children) {
            children.push(child.lifecycle)
        }
        return children
    }
}

// Helpers
// ========================================

function isLifecycleCandidate(value: unknown): value is ProviderLifecycle {
    if (!value || typeof value !== "object") return false

    const candidate = value as ProviderLifecycle
    return Boolean(
        // eslint-disable-next-line @typescript-eslint/unbound-method
        candidate.onModuleInit || candidate.onModuleMount || candidate.onModuleUnmount || candidate.onModuleDestroy
    )
}

function createModuleParticipant(hooks: ModuleHooks, module: Module): ProviderLifecycle | undefined {
    const participant: ProviderLifecycle = {
        onModuleInit: hooks.onModuleInit ? () => hooks.onModuleInit?.(module.resolver) : undefined,
        onModuleMount: hooks.onModuleMount ? () => hooks.onModuleMount?.(module.resolver) : undefined,
        onModuleUnmount: hooks.onModuleUnmount ? () => hooks.onModuleUnmount?.(module.resolver) : undefined,
        onModuleDestroy: hooks.onModuleDestroy ? () => hooks.onModuleDestroy?.(module.resolver) : undefined,
    }

    return isLifecycleCandidate(participant) ? participant : undefined
}
