#!/usr/bin/env node
/**
 * Typecheck the PUBLISHED declarations from the outside.
 *
 * `pnpm run typecheck` compiles `src/` under our own tsconfig and proves only that we are consistent
 * with ourselves. This runner packs the two packages the way a publish would, installs both into two
 * throwaway consumer projects — one on `@types/react` 18 with `moduleResolution: bundler`, one on
 * `@types/react` 19 with NodeNext, both stricter than we compile ourselves — and typechecks each
 * against `dist/*.d.ts`.
 *
 * Requires `pnpm run build` in both packages first; it never builds, so what is checked is exactly what
 * was built.
 *
 * TWO packages, because 0.10.0 is two packages. `@remodulo/react` depends on `@remodulo/container`, and
 * a consumer outside this workspace cannot get that dependency any other way:
 *
 *   - `@remodulo/container` is declared as `workspace:^`, a protocol npm does not understand at all
 *     (EUNSUPPORTEDPROTOCOL). `pnpm pack` rewrites it to the real range (`^0.2.0`) exactly as `pnpm
 *     publish` would, which is the first reason the tarball — and not the package directory — is what
 *     gets installed here.
 *   - that rewritten range then points at a version nobody has published yet, so npm would go to the
 *     registry and 404. Installing the container's own tarball ALONGSIDE the react one satisfies the
 *     range from the consumer's own tree: npm dedupes `^0.2.0` onto the 0.2.0 it already has.
 *
 * The two-tarball install is therefore not a convenience — it is the only arrangement in which an
 * external consumer of the unpublished pair can be typechecked at all, and it doubles as a rehearsal of
 * the publish itself: if `pnpm pack` produced a manifest npm cannot install, this gate is where that
 * shows up rather than after `npm publish`.
 *
 * Why the consumers stay on npm while the repo is a pnpm workspace: the point of this gate is to
 * simulate an EXTERNAL consumer installing published tarballs. `pnpm install` would link them into the
 * workspace and resolve `@remodulo/react` to the source directory, which is exactly the isolation this
 * gate exists to avoid. A tarball dependency is always COPIED, never symlinked, so the library's
 * declarations are typechecked against the consumer's own `react` / `@types/react` rather than against
 * whatever the workspace happens to hoist.
 *
 * Why the deletions and the hash check: npm records a tarball's integrity in `package-lock.json` and
 * will happily serve the copy it cached under that hash even after the file on disk has changed —
 * MEASURED here, with a container tarball whose `dist` had grown a file that never reached the consumer
 * ("added 3 packages", no error, no new file). Removing the lockfile forces npm to read the tarball it
 * was actually pointed at, and the hash comparison afterwards turns any future caching surprise into a
 * loud failure instead of a green run against yesterday's declarations. npm rewrites the lockfile on the
 * way out, so it stays an accurate record of exactly which tarballs were proven.
 */

import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const consumersDir = dirname(fileURLToPath(import.meta.url))
// packages/react — the package that owns this gate, not the workspace root.
const packageRoot = resolve(consumersDir, "..", "..")
const containerRoot = resolve(packageRoot, "..", "container")
const tarballDir = join(consumersDir, ".tarballs")

// Order matters: the kernel is packed and installed first, so the react tarball's `^0.2.0` has
// something local to dedupe onto.
const packages = [
    { name: "@remodulo/container", root: containerRoot, tarball: join(tarballDir, "remodulo-container.tgz") },
    { name: "@remodulo/react", root: packageRoot, tarball: join(tarballDir, "remodulo-react.tgz") },
]

const consumers = ["react18", "react19"]

// Neither package may reach a consumer carrying the decorator era with it. `dist` is the whole of what
// ships, so the scan is exhaustive by construction.
const forbiddenStrings = ["inversify", "reflect-metadata"]

function fail(message) {
    console.error(`\n[consumers] ${message}\n`)
    process.exit(1)
}

function run(command, args, cwd) {
    console.log(`[consumers] ${relative(packageRoot, cwd) || "."}$ ${command} ${args.join(" ")}`)
    const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: true })

    if (result.error) fail(`failed to spawn \`${command}\`: ${result.error.message}`)
    if (result.status !== 0) fail(`\`${command} ${args.join(" ")}\` exited with ${result.status}`)
}

function distFiles(distDir) {
    const files = []

    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = join(dir, entry.name)
            if (entry.isDirectory()) walk(full)
            else files.push(full)
        }
    }

    walk(distDir)

    return files
}

// Hash of the declaration surface only — that is what a consumer typechecks against.
function hashDeclarations(distDir) {
    const files = distFiles(distDir).filter((file) => file.endsWith(".d.ts"))

    const hash = createHash("sha256")
    for (const file of files) {
        hash.update(relative(distDir, file).replaceAll("\\", "/"))
        hash.update(readFileSync(file))
    }

    return { digest: hash.digest("hex"), count: files.length }
}

/**
 * The negative half of the promise the README makes, checked where it is actually consumed.
 *
 * `repro.tsx` can pin that no decorator is EXPORTED, but not that nothing is imported at runtime: a
 * stray `import "reflect-metadata"` in any emitted module would be invisible to `tsc --noEmit` and
 * perfectly visible to whoever installs the package.
 */
function assertNoForbiddenStrings(label, distDir) {
    for (const file of distFiles(distDir)) {
        if (file.endsWith(".map")) continue

        const contents = readFileSync(file, "utf8")
        for (const forbidden of forbiddenStrings) {
            if (contents.includes(forbidden)) {
                fail(`${label}: installed ${relative(distDir, file)} mentions \`${forbidden}\``)
            }
        }
    }
}

/**
 * Every dependency the packed package declares must sit in the consumer's OWN tree.
 *
 * The consumers live inside the package, so `node_modules` lookup walks up into `packages/react` and
 * then the workspace root — a dependency missing from the consumer resolves there instead, at whatever
 * version we happen to have, and `skipLibCheck` swallows the difference. That is not hypothetical: a
 * stale consumer lockfile kept installing a dependency the package had already moved off, and both
 * profiles stayed green because the root's copy answered every lookup. `@remodulo/container` is the one
 * this matters most for now — it is the whole reason the second tarball is installed.
 */
function assertDependenciesAreLocal(name, consumerDir, installedDir) {
    const { dependencies = {} } = JSON.parse(readFileSync(join(installedDir, "package.json"), "utf8"))

    const missing = Object.keys(dependencies).filter(
        (dependency) =>
            !existsSync(join(consumerDir, "node_modules", dependency)) &&
            !existsSync(join(installedDir, "node_modules", dependency))
    )

    if (missing.length > 0) {
        fail(
            `${name}: ${missing.join(", ")} declared by the packed package but absent from the consumer's tree\n` +
                `  their types would resolve from the package or workspace root instead — delete ` +
                `${join(consumerDir, "node_modules")} and retry.`
        )
    }
}

/**
 * The declarations are only as trustworthy as the compile that produced them.
 *
 * `tsc` emits a complete `dist` even when the program has type errors, unless `noEmitOnError` says
 * otherwise — and a `dist` built before that flag existed looks perfectly well-formed from here. That is
 * not hypothetical either: this runner once reported both profiles green while `pnpm run typecheck:build`
 * was failing on TS2459, because it only ever hashed whatever `dist` it found.
 *
 * Re-checking the build program costs a couple of seconds and never emits, so the property the header
 * promises still holds: what gets typechecked is exactly what was built.
 */
for (const { name, root } of packages) {
    console.log(`\n[consumers] === ${name} ===`)
    run("pnpm", ["run", "typecheck:build"], root)
}

mkdirSync(tarballDir, { recursive: true })

const built = new Map()

for (const { name, root, tarball } of packages) {
    const dist = join(root, "dist")
    if (!existsSync(join(dist, "index.d.ts"))) {
        fail(`${name}: dist/index.d.ts is missing — run \`pnpm run build\` before \`pnpm run typecheck:consumers\`.`)
    }

    // `--config.ignore-scripts=true` is how pnpm spells `--ignore-scripts` for `pack`: without it the
    // package's own `prepack` rebuilds, and this runner would no longer be checking what was built.
    run("pnpm", ["pack", "--config.ignore-scripts=true", "--out", tarball], root)

    const declarations = hashDeclarations(dist)
    built.set(name, declarations)
    console.log(`[consumers] ${name}: ${declarations.count} .d.ts files, sha256 ${declarations.digest.slice(0, 16)}`)
}

for (const name of consumers) {
    const consumerDir = join(consumersDir, name)

    console.log(`\n[consumers] === ${name} ===`)

    for (const { name: packageName } of packages) {
        rmSync(join(consumerDir, "node_modules", packageName), { recursive: true, force: true })
    }
    rmSync(join(consumerDir, "node_modules", ".package-lock.json"), { force: true })
    rmSync(join(consumerDir, "package-lock.json"), { force: true })

    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumerDir)

    for (const { name: packageName } of packages) {
        const installedDir = join(consumerDir, "node_modules", packageName)

        if (!existsSync(installedDir)) fail(`${name}: ${packageName} was not installed`)
        if (lstatSync(installedDir).isSymbolicLink()) {
            fail(`${name}: ${packageName} is a symlink — the consumer would typecheck against the repo's own deps`)
        }

        const expected = built.get(packageName)
        const installed = hashDeclarations(join(installedDir, "dist"))
        if (installed.digest !== expected.digest) {
            fail(
                `${name}: installed ${packageName} declarations do not match the build\n` +
                    `  built:     ${expected.count} files, sha256 ${expected.digest}\n` +
                    `  installed: ${installed.count} files, sha256 ${installed.digest}\n` +
                    `  npm served a cached copy; delete ${join(consumerDir, "node_modules")} and retry.`
            )
        }
        console.log(
            `[consumers] ${name}: ${packageName} declarations match the build (${installed.count} .d.ts files)`
        )

        assertNoForbiddenStrings(`${name}: ${packageName}`, join(installedDir, "dist"))
        assertDependenciesAreLocal(name, consumerDir, installedDir)
    }

    run("npm", ["run", "typecheck"], consumerDir)
}

console.log("\n[consumers] both consumer profiles typecheck against the published declarations.")
