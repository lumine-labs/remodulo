# @remodulo/mobx

**MobX companion for [`@remodulo/react`](https://www.npmjs.com/package/@remodulo/react).**

Three values: a `PropsAdapter` that bridges React props into a stable MobX observable, a base class that owns
disposers, and a `makeAutoObservable` that works across a class hierarchy. The core stays
reactivity-agnostic; this is where the two libraries meet.

> ⚠️ **Experimental / internal use.**
>
> Primarily intended for personal and internal use. It may change, break, or be restructured at any time.
> Don't rely on it for public projects unless you're prepared to maintain your own fork.

## Install

```sh
npm install @remodulo/mobx
```

Peers: `@remodulo/react` `^0.12.0`, `@remodulo/container` `^0.3.0`, `mobx` `^6.0.0 || ^7.0.0`, `react` `^18.0.0 || ^19.0.0`. No `reflect-metadata`, no
decorators, no compiler flags — dependencies arrive as `inject()` fields, exactly as in the core.

## Example

```tsx
import { inject, makeTokenizer } from "@remodulo/container"
import { ViewModel, makeInheritedAutoObservable, mobxProps } from "@remodulo/mobx"
import { PropsRef, createModuleComponent } from "@remodulo/react"
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

export const ChartModule = createModuleComponent<ChartProps>(
    { providers: [ChartStore] },
    { adapter: mobxProps<ChartProps>(), token: ChartPropsRef }
)
```

The store reads its props inside a reaction and never hears about React at all. The `PropsRef` subclass is
what types them: the bridge's `token` registers the bridged observable under `ChartPropsRef`, so
`inject(ChartPropsRef)` returns a ref whose `current` is `ChartProps` and not `unknown`.

- **`mobxProps()`** — a `PropsAdapter` that mints one shallow observable and mutates it in place on every
  real props change, inside a `runInAction`. The identity never changes, so reactions stay attached. Keys the
  parent stops passing are removed.
- **`ViewModel`** — `track(disposer)` and a lazy `AbortSignal`, released in reverse order at **unmount**,
  so what a mount acquires the matching unmount lets go and a remount starts clean. Destroy is the backstop
  for a module that never mounted. `onDestroy` may be async and is awaited. It does **no** MobX annotation
  of its own; annotate in your own constructor.
  The base owns all four `onModule*` hooks and **seals** them: override `onInit()`, `onMount()`,
  `onUnmount()` or `onDestroy()` instead — all optional, no `super` call. Redefining an `onModule*` throws
  at construction rather than silently dropping the teardown that runs after your `onDestroy()`.
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
