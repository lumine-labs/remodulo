import { defaultExclude, defineConfig } from "vitest/config"

// eslint-disable-next-line import/no-default-export
export default defineConfig({
    test: {
        environment: "jsdom",
        globals: true,
        // Every spy is undone between cells, so a forgotten `mockRestore` cannot leak a stubbed console
        // into the next test and hide an error it should have reported.
        restoreMocks: true,
        setupFiles: ["./tests/setup/setupTests.ts"],
        include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
        // tests/memory needs --expose-gc and a single fork; it has its own config and `pnpm run test:memory`.
        exclude: [...defaultExclude, "tests/memory/**"],
        coverage: {
            provider: "v8",
            reporter: ["text", "html", "lcov"],
            include: ["src/**/*.ts", "src/**/*.tsx"],
            exclude: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
        },
    },
})
