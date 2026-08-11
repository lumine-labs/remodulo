import { shallowEqual } from "@luminelabs/toolkit"

// Types
// ========================================

export type PropsAdapter<P extends object, T = P> = {
    create(initial: P): T
    update(args: { current: T; next: P }): T
}

type Subscriber<T> = (next: T, prev: T) => void

const defaultAdapter: PropsAdapter<any> = {
    create(initial) {
        return initial
    },
    update({ next }) {
        return next
    },
}

// PropsRef
// ========================================

export class PropsRef<T = any> {
    private value: T // exposed value: the adapter's output (the raw props under the default adapter)
    private plain: object // raw props, kept untouched so a swapped adapter always wraps the source
    private adapter: PropsAdapter<any, T>
    private readonly subscribers = new Set<Subscriber<T>>()

    constructor(config: { props: object; adapter?: PropsAdapter<any, T> }) {
        this.adapter = config.adapter ?? defaultAdapter
        this.plain = config.props
        this.value = this.adapter.create(config.props)
    }

    get current(): T {
        return this.value
    }

    update(next: object): void {
        if (shallowEqual(this.plain, next)) return
        this.plain = next

        const prev = this.value
        this.value = this.adapter.update({ current: this.value, next })

        this.notify(this.value, prev)
    }

    setAdapter(adapter?: PropsAdapter<any, T>): void {
        const nextAdapter = adapter ?? defaultAdapter
        if (nextAdapter === this.adapter) return
        this.adapter = nextAdapter

        const prev = this.value
        this.value = nextAdapter.create(this.plain)

        this.notify(this.value, prev)
    }

    onUpdate(cb: Subscriber<T>, options?: { immediate?: boolean }): () => void {
        this.subscribers.add(cb)

        if (options?.immediate) {
            invokeSubscriber(cb, this.value, this.value)
        }

        return () => {
            this.subscribers.delete(cb)
        }
    }

    private notify(next: T, prev: T): void {
        for (const cb of [...this.subscribers]) {
            invokeSubscriber(cb, next, prev)
        }
    }
}

// Helpers
// ========================================

function invokeSubscriber<T>(cb: Subscriber<T>, next: T, prev: T): void {
    try {
        cb(next, prev)
    } catch (error) {
        console.error("PropsRef.onUpdate: subscriber threw", error)
    }
}
