import { $mobx, isObservable, makeObservable } from "mobx"
import type { AnnotationsMap, CreateObservableOptions } from "mobx"

// makeInheritedAutoObservable
// ========================================

/*
 * Vendored third-party code.
 *
 * MobX's own `makeAutoObservable` rejects any class with a superclass — see
 * https://mobx.js.org/subclassing.html#limitations. The technique below lifts that restriction by
 * walking the prototype chain itself and handing explicit annotations to `makeObservable`.
 *
 * Origin: posted by urugator in the MobX discussions,
 * https://github.com/mobxjs/mobx/discussions/2850#discussioncomment-497321
 * Packaged as `mobx-store-inheritance` by Igor «InoY» Zviagintsev,
 * https://github.com/inoyakaigor/mobx-store-inheritance
 *
 * That package declares ISC in its `package.json` and ships no LICENSE file, so no upstream copyright
 * notice exists to reproduce verbatim. The ISC permission notice is included below, attributed to the
 * authors named above. It is vendored rather than depended upon because the upstream package lists
 * `typescript` as a runtime dependency, which would follow every consumer into production.
 *
 * Copyright (c) urugator and Igor «InoY» Zviagintsev
 *
 * Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee
 * is hereby granted, provided that the above copyright notice and this permission notice appear in all
 * copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE
 * INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE
 * LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER
 * RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
 * TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

const annotationsSymbol = Symbol.for("@remodulo/mobx:annotations")
const objectPrototype = Object.prototype

export function makeInheritedAutoObservable<T extends object, AdditionalKeys extends PropertyKey = never>(
    target: T,
    overrides?: AnnotationsMap<T, AdditionalKeys>,
    options?: CreateObservableOptions
): T {
    if (isObservable(target)) {
        throw new Error(
            "makeInheritedAutoObservable: target is already observable. Call it exactly once, in the most derived constructor."
        )
    }

    const proto = Object.getPrototypeOf(target) as object | null
    let annotations = (proto ? Object.getOwnPropertyDescriptor(proto, annotationsSymbol)?.value : undefined) as
        AnnotationsMap<T, AdditionalKeys> | undefined

    if (!annotations) {
        annotations = {} as AnnotationsMap<T, AdditionalKeys>
        const collected = annotations as unknown as Record<PropertyKey, unknown>
        const declared = overrides as unknown as Record<PropertyKey, unknown> | undefined

        let current: object | null = target
        while (current && current !== objectPrototype) {
            Reflect.ownKeys(current).forEach((key) => {
                if (key === $mobx || key === "constructor") return
                const sealed = Object.getOwnPropertyDescriptor(target, key)
                if (sealed?.configurable === false) return
                collected[key] = !declared ? true : key in declared ? declared[key] : true
            })
            current = Object.getPrototypeOf(current)
        }

        if (proto && proto !== objectPrototype) {
            Object.defineProperty(proto, annotationsSymbol, { value: annotations })
        }
    } else {
        const cached = annotations as unknown as Record<PropertyKey, unknown>
        const applicable: Record<PropertyKey, unknown> = {}
        for (const key of Reflect.ownKeys(cached)) {
            if (key in target) {
                applicable[key] = cached[key]
            }
        }
        annotations = applicable as unknown as AnnotationsMap<T, AdditionalKeys>
    }

    return makeObservable(target, annotations, options)
}
