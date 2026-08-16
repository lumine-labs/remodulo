# @remodulo/mobx

**MobX companion for [`@remodulo/react`](https://www.npmjs.com/package/@remodulo/react).**

A module-component factory with the props bridge already wired, the `PropsAdapter` behind it, and a
`makeAutoObservable` that works across a class hierarchy. The core stays reactivity-agnostic; this is where
the two libraries meet.

Pairs with [`@remodulo/view-model`](https://www.npmjs.com/package/@remodulo/view-model), which owns the
`ViewModel` base class this package's annotation walk is built to tolerate. Install it if you want one; it
is not required, and not a peer.

> ⚠️ **Experimental / internal use.**
>
> Primarily intended for personal and internal use. It may change, break, or be restructured at any time.
> Don't rely on it for public projects unless you're prepared to maintain your own fork.

## Install

```sh
npm install @remodulo/mobx
```

Peers: `@remodulo/react` `^0.13.0` and `mobx` `^6.0.0 || ^7.0.0` — the two things this package actually
imports. `react` and `@remodulo/container` are **not** peers here; they arrive with `@remodulo/react`, as
its own. No `reflect-metadata`, no decorators, no compiler flags — dependencies arrive as `inject()`
fields, exactly as in the core.

## Example

```tsx
import { inject, makeTokenizer } from "@remodulo/container"
import { createMobxModuleComponent, makeInheritedAutoObservable } from "@remodulo/mobx"
import { PropsRef } from "@remodulo/react"
import { ViewModel } from "@remodulo/view-model"
import { autorun, runInAction } from "mobx"

type ChartProps = { series: string; window: number }

class ChartPropsRef extends PropsRef<ChartProps> {}

const tokens = makeTokenizer("chart")
const TApiClient = tokens<{ points(series: string, window: number): Promise<number[]> }>("ApiClient")

class ChartStore extends ViewModel {
    points: number[] = []

    private readonly props = inject(ChartPropsRef)
    private readonly api = inject(TApiClient)

    constructor() {
        super()
        makeInheritedAutoObservable(this, { props: false, api: false }, { autoBind: true })
        this.track(autorun(() => void this.refetch()))
    }

    private async refetch(): Promise<void> {
        const { series, window } = this.props.current
        const points = await this.api.points(series, window)
        runInAction(() => (this.points = points))
    }
}

export const ChartModule = createMobxModuleComponent<ChartProps>({ providers: [ChartStore] }, { token: ChartPropsRef })
```

The store reads its props inside a reaction and never hears about React at all. The `PropsRef` subclass is
what types them: the bridge's `token` registers the bridged observable under `ChartPropsRef`, so
`inject(ChartPropsRef)` returns a ref whose `current` is `ChartProps` and not `unknown`.

- **`createMobxModuleComponent(config?, props?)`** — `@remodulo/react`'s `createModuleComponent` with the
  MobX bridge already wired. Identical signature except the props param takes `use` and `token` only: the
  `adapter` slot belongs to the factory, which mints one per component at definition time, where the
  identity has to be fixed. `config` passes through verbatim, object form and function-of-enriched-props
  form alike.
- **`mobxProps()`** — the `PropsAdapter` underneath, for composing by hand: pass it as
  `createModuleComponent(config, { adapter: mobxProps<T>(), ... })` when you need the base factory (a
  non-MobX adapter alongside, your own wrapper). Hoist it — an adapter recreated per render rebuilds the
  target. It mints one shallow observable and mutates it in place on every real props change, inside a
  `runInAction`. The identity never changes, so reactions stay attached. Keys the parent stops passing are
  removed.
- **`makeInheritedAutoObservable(target, overrides?, options?)`** — MobX's own
  [refuses any class with a superclass](https://mobx.js.org/subclassing.html#limitations); this walks the
  prototype chain instead. Call it exactly once per instance, in the most derived constructor. Injected
  collaborators are just fields, so exclude them with `false`. Non-configurable own properties are skipped
  — MobX deletes a property before redefining it, so this is what lets a sealed `ViewModel` be annotated
  at all.

> ⚠️ With the call in a **base** constructor, a subclass's own **fields** are never observable —
> JavaScript initialises them after `super()` returns. Methods and getters are fine at every level. This
> fails silently.

The technique behind `makeInheritedAutoObservable` is
[urugator's](https://github.com/mobxjs/mobx/discussions/2850#discussioncomment-497321), packaged upstream as
[`mobx-store-inheritance`](https://github.com/inoyakaigor/mobx-store-inheritance) by Igor «InoY»
Zviagintsev (ISC). It is vendored here because that package lists `typescript` as a runtime dependency.

## [Documentation](https://lumine-labs.github.io/remodulo/)

## License

MIT
