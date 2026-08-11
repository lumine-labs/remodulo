/* eslint-disable @typescript-eslint/no-this-alias, new-cap */

import {
    Scope,
    type BindingEntrySnapshot,
    type Constructor,
    type ContainerEvent,
    type ContainerEventListener,
    type Entry,
    type EntrySnapshot,
    type EntrySource,
    type Found,
    type InjectionToken,
    type Landing,
    type RegistrationMode,
    type Resolution,
    type ResolveAllMode,
    type ResolveMode,
} from "./container.types.js"
import type {
    ClassProvider,
    EntryMetadata,
    ExistingProvider,
    FactoryProvider,
    Provider,
    ProviderRegistrationMode,
    ValueProvider,
} from "./providers.types.js"
import { PROVIDER_USE_KEYS } from "./providers.js"
import {
    CycleError,
    RegistrationError,
    ResolutionError,
    aliasTargetsMulti,
    alreadyRegistered,
    circularDependency,
    invalidProvider,
    missingProvide,
    mixedImplementationKeys,
    modeConflict,
    multiNeedsProvide,
    multiRegistered,
    notRegistered,
    providerToken,
    singleRegistration,
} from "./container.errors.js"
import type { Frame } from "./frame.types.js"
import { activeFrame, runInFrame } from "./frame.js"

// A miss the read was spelled to tolerate. Distinct from `undefined`, which is a value a token may hold.
const MISS = Symbol("miss")

// Container
// ========================================

export class Container {
    readonly #parent: Container | null

    // Token -> its own entries, in registration order. Aliases included: they resolve, they just build nothing.
    readonly #entries = new Map<InjectionToken, Entry[]>()
    // Every own entry in registration order, for the layer above to drive an eager pass from.
    readonly #order: Entry[] = []

    // Token -> mode, this container only. Chain-wide by construction, so the nearest entry answers.
    readonly #modes = new Map<InjectionToken, ProviderRegistrationMode>()
    // Alias target -> its aliases, so a token turning multi fails whichever order the two arrived in.
    readonly #aliasTargets = new Map<InjectionToken, InjectionToken[]>()

    readonly #hooks: { [E in ContainerEvent]: ContainerEventListener<E>[] } = {
        beforeResolution: [],
        afterResolution: [],
        beforeMaterialize: [],
        afterMaterialize: [],
    }

    constructor(parent?: Container) {
        this.#parent = parent ?? null
    }

    // Hierarchy
    // ========================================

    fork(): Container {
        return new Container(this)
    }

    get parent(): Container | null {
        return this.#parent
    }

    // Registry
    // ========================================

    register(provider: Provider | Provider[]): void {
        if (Array.isArray(provider)) {
            for (const p of provider) this.register(p)
            return
        }

        if (typeof provider === "function") {
            this.#claim(provider, false)
            this.#record(provider, { kind: "class", implementation: provider }, Scope.Singleton, false)
            return
        }

        if (provider === null || typeof provider !== "object") {
            throw new RegistrationError(invalidProvider(provider), providerToken(provider))
        }

        const presentUseKeys = PROVIDER_USE_KEYS.filter((key) => key in provider)
        if (presentUseKeys.length > 1) {
            throw new RegistrationError(mixedImplementationKeys(provider, presentUseKeys), providerToken(provider))
        }
        if (presentUseKeys.length === 0) {
            throw new RegistrationError(invalidProvider(provider), providerToken(provider))
        }
        const [useKey] = presentUseKeys

        const multi = provider.multi === true
        const metadata = sealMetadata(provider.metadata)

        switch (useKey) {
            case "useClass": {
                const p = provider as ClassProvider

                if (typeof p.useClass !== "function") {
                    throw new RegistrationError(invalidProvider(provider), p.provide)
                }

                if (multi && p.provide === undefined) {
                    throw new RegistrationError(multiNeedsProvide(), p.useClass)
                }

                const token = p.provide ?? p.useClass
                const scope = p.scope ?? Scope.Singleton

                this.#claim(token, multi)
                this.#record(token, { kind: "class", implementation: p.useClass }, scope, multi, metadata)
                return
            }

            case "useFactory": {
                const p = provider as FactoryProvider

                if (typeof p.useFactory !== "function") {
                    throw new RegistrationError(invalidProvider(provider), p.provide)
                }

                this.#assertProvide(p.provide, useKey)
                const scope = p.scope ?? Scope.Singleton

                this.#claim(p.provide, multi)
                this.#record(p.provide, { kind: "factory", factory: p.useFactory }, scope, multi, metadata)
                return
            }

            case "useValue": {
                const p = provider as ValueProvider

                this.#assertProvide(p.provide, useKey)
                this.#claim(p.provide, multi)
                this.#record(p.provide, { kind: "value", value: p.useValue }, Scope.Singleton, multi, metadata)
                return
            }

            case "useExisting": {
                const p = provider as ExistingProvider

                if (p.useExisting === undefined) {
                    throw new RegistrationError(invalidProvider(provider), p.provide)
                }

                this.#assertProvide(p.provide, useKey)

                // An alias may BE a collection member, never TARGET one: it redirects to a single-value
                // read, which is what the mode guards refuse.
                if (this.#modeOf(p.useExisting) === "multi") {
                    throw new RegistrationError(aliasTargetsMulti(p.provide, p.useExisting), p.provide)
                }

                this.#claim(p.provide, multi)
                this.#record(p.provide, { kind: "alias", target: p.useExisting }, Scope.Singleton, multi, metadata)
                this.#rememberAlias(p.useExisting, p.provide)
                return
            }
            default:
                throw new RegistrationError(invalidProvider(provider), providerToken(provider))
        }
    }

    isRegistered(token: InjectionToken, mode: RegistrationMode = "nearest"): boolean {
        return mode === "self" ? this.#owns(token) : this.#findSingle(token, "nearest") !== undefined
    }

    registrations(): readonly EntrySnapshot[] {
        return this.#order.map(snapshot)
    }

    entry(token: InjectionToken): EntrySnapshot | undefined {
        if (this.#modes.get(token) === "multi") throw new ResolutionError(multiRegistered(token), token)
        const own = this.#entries.get(token)
        return own === undefined || own.length === 0 ? undefined : snapshot(own[0])
    }

    entries(token: InjectionToken): readonly EntrySnapshot[] {
        if (this.#modes.get(token) === "single") throw new ResolutionError(singleRegistration(token), token)
        const entries = this.#entries.get(token) ?? []
        return entries.map(snapshot)
    }

    // Resolvers
    // ========================================

    resolve<T>(token: InjectionToken<T>, mode: ResolveMode = "nearest"): T {
        return this.#readSingle(token, mode, true) as T
    }

    resolveOptional<T>(token: InjectionToken<T>, mode: ResolveMode = "nearest"): T | undefined {
        const value = this.#readSingle(token, mode, false)
        return value === MISS ? undefined : (value as T)
    }

    resolveOr<T, F>(token: InjectionToken<T>, fallback: () => F, mode?: ResolveMode): T | F
    resolveOr<T, F>(token: InjectionToken<T>, fallback: F, mode?: ResolveMode): T | F
    resolveOr<T, F>(token: InjectionToken<T>, fallback: F | (() => F), mode: ResolveMode = "nearest"): T | F {
        return this.#readWithFallback(token, mode, fallback) as T | F
    }

    resolveAll<T>(token: InjectionToken<T>, mode: ResolveAllMode = "chained"): T[] {
        return this.#readMulti(token, mode) as T[]
    }

    /** Build `cls` in this container's context without registering it or anything it reaches. */
    construct<T>(cls: Constructor<T>): T {
        const context = this.#context()
        this.#assertAcyclic(cls, context)

        const frame: Frame = { container: this, request: context.request, chain: [...context.chain, cls] }
        return runInFrame(frame, () => new cls())
    }

    // Observation
    // ========================================

    /**
     * Attach a hook to one of this container's four events, and get back the disposer that detaches it.
     * Hooks observe or refuse; nothing a hook returns reaches the caller.
     *
     * Registration is CONTAINER-GLOBAL and takes no token: a hook fires for every entry a read on this
     * container LANDS on and for every construction on it, whoever made it, and it filters for itself. A
     * read that lands nothing reaches no hook — whether the kernel refused it or it simply missed. The
     * consequence worth stating before you attach one: a `before*` hook that throws refuses the operation
     * for every caller on this container, not only for the code that attached the hook. Hooks are
     * per-container — a fork inherits none — and they live until disposed or until the container dies.
     */
    on<E extends ContainerEvent>(event: E, listener: ContainerEventListener<E>): () => void {
        const listeners = this.#hooks[event]
        listeners.push(listener)

        let disposed = false
        return () => {
            if (disposed) return
            disposed = true

            const index = listeners.indexOf(listener)
            if (index !== -1) listeners.splice(index, 1)
        }
    }

    // Resolver internals
    // ========================================

    /** Everything one read shares with the graph below it: the ambient frame's, or a fresh graph. */
    #context(): Resolution {
        const frame = activeFrame()
        return frame ? { request: frame.request, chain: frame.chain } : { request: new Map(), chain: [] }
    }

    /** One single-value read. Answers `MISS` where the caller's spelling tolerates finding nothing. */
    #readSingle(token: InjectionToken, mode: ResolveMode, required: boolean): unknown {
        this.#assertSingleValued(token, mode)

        const context = this.#context()
        const found = this.#findSingle(token, mode)
        const landing = found && this.#findLanding(found, context, required)

        if (found === undefined || landing === undefined) {
            if (required) throw new ResolutionError(notRegistered(token, mode), token, mode)

            // Nothing landed, so there was no resolution to report. What the caller makes of the miss —
            // `undefined`, a fallback — is the caller's business rather than an event.
            return MISS
        }

        return this.#readEntry(token, mode, found.entry, landing)
    }

    /** The fallback answers a tolerated MISS, never a registered `undefined` — that one is a value. */
    #readWithFallback<F>(token: InjectionToken, mode: ResolveMode, fallback: F | (() => F)): unknown {
        const value = this.#readSingle(token, mode, false)
        if (value !== MISS) return value
        return typeof fallback === "function" ? (fallback as () => F)() : fallback
    }

    /** One collection read: a pair per member it lands, in the order the members contribute. */
    #readMulti(token: InjectionToken, mode: ResolveAllMode): unknown[] {
        if (this.#modeOf(token) === "single") {
            throw new ResolutionError(singleRegistration(token), token, mode)
        }

        const context = this.#context()
        const all: unknown[] = []

        for (const owner of this.#contributors(token, mode)) {
            for (const entry of owner.#entries.get(token) ?? []) {
                const landing = owner.#findLanding({ owner, entry }, context, true)

                // The member as it sits in the collection, which for an alias member is the alias.
                this.#notifyBeforeResolution(token, mode, entry)
                const instance = landing.owner.#materialize(landing.entry, landing.context)
                this.#notifyAfterResolution(entry, mode, instance)
                all.push(instance)
            }
        }

        return all
    }

    /**
     * One read of an entry already found: announced at the container the read was made on, carrying the
     * entry it was SPELLED through, and materialized from the binding that entry lands on.
     */
    #readEntry(token: InjectionToken, mode: ResolveMode, entry: Entry, landing: Landing): unknown {
        this.#notifyBeforeResolution(token, mode, entry)
        const instance = landing.owner.#materialize(landing.entry, landing.context)
        this.#notifyAfterResolution(entry, mode, instance)
        return instance
    }

    /** The nearest own entry at or above this container, or this container's own under `self`. */
    #findSingle(token: InjectionToken, mode: ResolveMode): Found | undefined {
        let current: Container | null = this
        while (current) {
            const entries: Entry[] | undefined = current.#entries.get(token)
            if (entries !== undefined && entries.length > 0) return { owner: current, entry: entries[0] }
            if (mode === "self") return undefined
            current = current.#parent
        }
        return undefined
    }

    /**
     * Follow an alias to the binding it lands on, each hop anchored at the container that declared it so
     * shadowing reads the same as it always did.
     */
    #findLanding(found: Found, context: Resolution, required: true): Landing
    #findLanding(found: Found, context: Resolution, required: boolean): Landing | undefined
    #findLanding(found: Found, context: Resolution, required: boolean): Landing | undefined {
        let current = found
        let reached = context

        while (current.entry.source.kind === "alias") {
            this.#assertAcyclic(current.entry.token, reached)

            const { target } = current.entry.source
            reached = { request: reached.request, chain: [...reached.chain, current.entry.token] }

            const next: Found | undefined = current.owner.#findSingle(target, "nearest")
            if (next === undefined) {
                if (required) throw new ResolutionError(notRegistered(target, "nearest"), target, "nearest")
                return undefined
            }
            current = next
        }

        return { owner: current.owner, entry: current.entry, context: reached }
    }

    /** The containers a collection read accumulates from, nearest first. */
    #contributors(token: InjectionToken, mode: ResolveAllMode): Container[] {
        if (mode === "self") return this.#owns(token) ? [this] : []

        const contributors: Container[] = []
        let current: Container | null = this
        while (current) {
            if (current.#owns(token)) {
                contributors.push(current)
                // `nearest` reads ONE container's bindings — the nearest contributor's — never the chain
                // above it. Accumulation is what `chained` is for.
                if (mode === "nearest") return contributors
            }
            current = current.#parent
        }
        return contributors
    }

    #materialize(entry: Entry, context: Resolution): unknown {
        if (entry.cache) return entry.cache.value
        if (entry.scope === Scope.Request && context.request.has(entry)) return context.request.get(entry)

        if (entry.source.kind === "value") {
            const { value } = entry.source
            this.#notifyBeforeMaterialize(entry)
            entry.cache = { value }
            this.#notifyAfterMaterialize(entry, value)
            return value
        }

        this.#assertAcyclic(entry.token, context)
        this.#notifyBeforeMaterialize(entry)

        // Run the build inside the entry's own frame, so `inject()` anywhere below sees this container.
        const frame: Frame = {
            container: this,
            request: context.request,
            chain: [...context.chain, entry.token],
        }
        const instance = runInFrame(frame, () => this.#build(entry))

        if (entry.scope === Scope.Singleton) entry.cache = { value: instance }
        else if (entry.scope === Scope.Request) context.request.set(entry, instance)

        this.#notifyAfterMaterialize(entry, instance)
        return instance
    }

    #build(entry: Entry): unknown {
        if (entry.source.kind === "class") return new entry.source.implementation()
        if (entry.source.kind === "factory") return entry.source.factory()
        throw new RegistrationError(invalidProvider(entry.token), entry.token)
    }

    // Notification
    // ========================================

    #notifyBeforeResolution(token: InjectionToken, mode: ResolveMode | ResolveAllMode, entry: Entry): void {
        const listeners = this.#hooks.beforeResolution
        if (listeners.length === 0) return

        const event = { token, mode, snapshot: snapshot(entry) }
        for (const notify of [...listeners]) notify(event)
    }

    #notifyAfterResolution(entry: Entry, mode: ResolveMode | ResolveAllMode, instance: unknown): void {
        const listeners = this.#hooks.afterResolution
        if (listeners.length === 0) return

        const event = { instance, mode, snapshot: snapshot(entry) }
        for (const notify of [...listeners]) notify(event)
    }

    #notifyBeforeMaterialize(entry: Entry): void {
        const listeners = this.#hooks.beforeMaterialize
        if (listeners.length === 0) return

        const event = { token: entry.token, snapshot: snapshot(entry) as BindingEntrySnapshot }
        for (const notify of [...listeners]) notify(event)
    }

    #notifyAfterMaterialize(entry: Entry, instance: unknown): void {
        const listeners = this.#hooks.afterMaterialize
        if (listeners.length === 0) return

        const event = { instance, snapshot: snapshot(entry) as BindingEntrySnapshot }
        for (const notify of [...listeners]) notify(event)
    }

    // Registry internals
    // ========================================

    #owns(token: InjectionToken): boolean {
        const entries = this.#entries.get(token)
        return entries !== undefined && entries.length > 0
    }

    /** Settle a registration's mode against everything already registered for the token. */
    #claim(token: InjectionToken, multi: boolean): void {
        const mode: ProviderRegistrationMode = multi ? "multi" : "single"
        const own = this.#modes.get(token)

        if (own === "single" && mode === "single") throw new RegistrationError(alreadyRegistered(token), token)
        if (own !== undefined && own !== mode) {
            throw new RegistrationError(modeConflict(token, own, mode, false), token)
        }

        // Only the first own registration consults the chain; later ones are already reconciled with it.
        if (own === undefined) {
            const inherited = this.#parent === null ? undefined : this.#parent.#modeOf(token)
            if (inherited !== undefined && inherited !== mode) {
                throw new RegistrationError(modeConflict(token, inherited, mode, true), token)
            }
        }

        if (mode === "multi") {
            const alias = this.#aliasOf(token)
            if (alias !== undefined) {
                throw new RegistrationError(aliasTargetsMulti(alias, token), token)
            }
        }

        this.#modes.set(token, mode)
    }

    /** Registration order is the order a collection resolves in. */
    #record(token: InjectionToken, source: EntrySource, scope: Scope, multi: boolean, metadata?: EntryMetadata): void {
        const entry: Entry =
            metadata === undefined ? { token, source, scope, multi } : { token, source, scope, multi, metadata }

        const entries = this.#entries.get(token)
        if (entries) entries.push(entry)
        else this.#entries.set(token, [entry])

        this.#order.push(entry)
    }

    #rememberAlias(target: InjectionToken, alias: InjectionToken): void {
        const aliases = this.#aliasTargets.get(target)
        if (aliases) aliases.push(alias)
        else this.#aliasTargets.set(target, [alias])
    }

    /** Nearest declared mode at or above this container, or undefined when nothing declares the token. */
    #modeOf(token: InjectionToken): ProviderRegistrationMode | undefined {
        let current: Container | null = this
        while (current) {
            const mode: ProviderRegistrationMode | undefined = current.#modes.get(token)
            if (mode !== undefined) return mode
            current = current.#parent
        }
        return undefined
    }

    /** Nearest token aliasing `target` at or above this container, if any. */
    #aliasOf(target: InjectionToken): InjectionToken | undefined {
        let current: Container | null = this
        while (current) {
            const aliases: InjectionToken[] | undefined = current.#aliasTargets.get(target)
            if (aliases !== undefined && aliases.length > 0) return aliases[0]
            current = current.#parent
        }
        return undefined
    }

    // Validators
    // ========================================

    #assertProvide(token: InjectionToken | undefined, useKey: string): void {
        if (token === undefined) throw new RegistrationError(missingProvide(useKey))
    }

    #assertSingleValued(token: InjectionToken, mode: ResolveMode): void {
        if (this.#modeOf(token) === "multi") {
            throw new ResolutionError(multiRegistered(token), token, mode)
        }
    }

    /** The chain is reported from the repeat that opened the cycle, not from wherever the read began. */
    #assertAcyclic(token: InjectionToken, context: Resolution): void {
        const start = context.chain.indexOf(token)
        if (start === -1) return

        const chain = [...context.chain.slice(start), token]
        throw new CycleError(circularDependency(chain), chain)
    }
}

// Snapshots
// ========================================

function sealMetadata(metadata: EntryMetadata | undefined): EntryMetadata | undefined {
    return metadata === undefined ? undefined : Object.freeze({ ...metadata })
}

function snapshot(entry: Entry): EntrySnapshot {
    const metadata = entry.metadata !== undefined && { metadata: entry.metadata }

    if (entry.source.kind === "alias") {
        return Object.freeze({
            kind: "alias" as const,
            token: entry.token,
            target: entry.source.target,
            multi: entry.multi,
            ...metadata,
        })
    }

    return Object.freeze({
        kind: entry.source.kind,
        token: entry.token,
        scope: entry.scope,
        multi: entry.multi,
        ...metadata,
    })
}
