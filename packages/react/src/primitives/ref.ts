// Ref
// ========================================

export class Ref<T> {
    current: T | null = null

    readonly set = (value: T | null): void => {
        this.current = value
    }
}

// RefMap
// ========================================

export class RefMap<T, K = string> {
    readonly #elements = new Map<K, T>()
    readonly #callbacks = new Map<K, (element: T | null) => void>()

    set(key: K): (element: T | null) => void {
        const cached = this.#callbacks.get(key)
        if (cached) return cached

        const callback = (element: T | null): void => {
            if (element === null) {
                this.#elements.delete(key)
                return
            }
            this.#elements.set(key, element)
        }

        this.#callbacks.set(key, callback)
        return callback
    }

    get(key: K): T | null {
        return this.#elements.get(key) ?? null
    }

    all(): ReadonlyMap<K, T> {
        return this.#elements
    }
}
