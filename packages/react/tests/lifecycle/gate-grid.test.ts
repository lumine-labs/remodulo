import { describe, expect, it } from "vitest"

import { App } from "../../src/core/module.js"
import { ModuleStatus } from "../../src/core/module-lifecycle.types.js"
import type { Provider } from "../../src/types.js"
import { makeApp, refuses } from "../setup/helpers.js"

// The gate grid — every signal against every status it can be sent from.
// ========================================
//
// The four phase gates are pinned all over this suite, but always one interesting pair at a time, and the
// pairs nobody found interesting were simply never asserted. This is the whole table instead: four signals
// against the seven statuses a CALLER can hold a module in, so a gate that quietly widens or narrows its
// allow-set fails here whether or not anyone thought that cell was worth a cell.
//
// `initializing` is the eighth status and it is absent on purpose — the init phase is synchronous, so no
// caller can hold a module in it. The two pairs that matter there (init and destroy, sent from inside the
// init phase) are `rulings.test.ts` §2, which is the only place they are reachable from.
//
//   signal     accepts                                          refuses
//   init       created                                          everything else
//   mount      initialized | unmounted                          everything else
//   unmount    mounted                                          everything else
//   destroy    created | initialized | unmounted | failed       mounted; no-ops on destroying | destroyed
//
// destroy()'s no-op arms are folded in as "accepted" here: the grid asks whether the signal is REFUSED, and
// a collapse is not a refusal. Which of the two it is, for those arms, is pinned in `idempotence.test.ts`.

type Held = {
    module: App
    /** Let a module parked mid-drain finish, so the cell leaves nothing in flight. */
    settle: () => Promise<void>
}

const NOOP = async (): Promise<void> => undefined

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((settle) => {
        resolve = settle
    })
    return { promise, resolve }
}

/** Build an App parked in `status`, by the shortest legal route to it. */
async function held(status: ModuleStatus): Promise<Held> {
    switch (status) {
        case ModuleStatus.Created:
            return { module: new App(), settle: NOOP }

        case ModuleStatus.Initialized:
            return { module: makeApp(), settle: NOOP }

        case ModuleStatus.Mounted: {
            const module = makeApp()
            module.mount()
            return { module, settle: NOOP }
        }

        case ModuleStatus.Unmounted: {
            const module = makeApp()
            module.mount()
            module.unmount()
            return { module, settle: NOOP }
        }

        case ModuleStatus.Failed: {
            const Throws = class {
                onModuleInit(): void {
                    throw new Error("init refused")
                }
            }
            const module = new App({ providers: [Throws as unknown as Provider] })
            expect(() => module.init()).toThrow("init refused")
            return { module, settle: NOOP }
        }

        case ModuleStatus.Destroying: {
            // Parked INSIDE the drain: the claim is synchronous, the hook below is not, so the module sits
            // in `destroying` for as long as this cell needs it.
            const entered = deferred()
            const release = deferred()
            const Blocking = class {
                async onModuleDestroy(): Promise<void> {
                    entered.resolve()
                    await release.promise
                }
            }
            const module = makeApp({ providers: [Blocking as unknown as Provider] })
            const inFlight = module.destroy()
            await entered.promise

            return {
                module,
                settle: async () => {
                    release.resolve()
                    await inFlight
                },
            }
        }

        case ModuleStatus.Destroyed: {
            const module = makeApp()
            await module.destroy()
            return { module, settle: NOOP }
        }

        default:
            throw new Error(`no route to "${status}"`)
    }
}

const STATUSES = [
    ModuleStatus.Created,
    ModuleStatus.Initialized,
    ModuleStatus.Mounted,
    ModuleStatus.Unmounted,
    ModuleStatus.Destroying,
    ModuleStatus.Destroyed,
    ModuleStatus.Failed,
] as const

const ACCEPTS: Record<"init" | "mount" | "unmount" | "destroy", readonly ModuleStatus[]> = {
    init: [ModuleStatus.Created],
    mount: [ModuleStatus.Initialized, ModuleStatus.Unmounted],
    unmount: [ModuleStatus.Mounted],
    destroy: [
        ModuleStatus.Created,
        ModuleStatus.Initialized,
        ModuleStatus.Unmounted,
        ModuleStatus.Failed,
        ModuleStatus.Destroying,
        ModuleStatus.Destroyed,
    ],
}

describe("the gate grid", () => {
    for (const signal of ["init", "mount", "unmount"] as const) {
        it(`${signal}() takes ${ACCEPTS[signal].join(" | ")} and refuses the rest`, async () => {
            for (const status of STATUSES) {
                // eslint-disable-next-line no-await-in-loop
                const { module, settle } = await held(status)
                expect(module.status, `route to "${status}" landed on "${module.status}"`).toBe(status)

                const send = (): void => module[signal]()

                if (ACCEPTS[signal].includes(status)) {
                    expect(send, `${signal}() from "${status}" should be accepted`).not.toThrow()
                } else {
                    expect(send, `${signal}() from "${status}" should be refused`).toThrow(
                        refuses(signal, status)
                    )
                }

                // eslint-disable-next-line no-await-in-loop
                await settle()
            }
        })
    }

    it(`destroy() takes everything but mounted`, async () => {
        for (const status of STATUSES) {
            // eslint-disable-next-line no-await-in-loop
            const { module, settle } = await held(status)
            expect(module.status, `route to "${status}" landed on "${module.status}"`).toBe(status)

            if (ACCEPTS.destroy.includes(status)) {
                // A destroy sent at a module already draining is the collapse, not a second drain — it has
                // to be awaited before `settle()` releases the first one, or the cell races itself.
                const inFlight = module.destroy()
                // eslint-disable-next-line no-await-in-loop
                await settle()
                // eslint-disable-next-line no-await-in-loop
                await expect(inFlight).resolves.toBeUndefined()
            } else {
                await expect(module.destroy()).rejects.toThrow(refuses("destroy", status))
                // eslint-disable-next-line no-await-in-loop
                await settle()
            }
        }
    })
})
