/**
 * jest-dom's matcher types, re-attached to vitest 5's assertion interface.
 *
 * `@testing-library/jest-dom` (7.0.1, the latest published) ships its vitest
 * augmentation against `interface Assertion<T = any>` — vitest 4's shape.
 * Vitest 5 widened that to
 * `Assertion<R extends void | Promise<void> = void, T = unknown>` so a promise
 * return type can be threaded through `.resolves`/`expect.poll`, and moved the
 * user-land extension point to the empty `Matchers<R, T>` interface it extends.
 *
 * Declaration merging requires an identical type-parameter list, so jest-dom's
 * one-parameter `Assertion` no longer merges with vitest's two-parameter one.
 * `skipLibCheck` swallows the mismatch inside jest-dom's own `.d.ts`, so the
 * break surfaced as 161 `Property 'toBeInTheDocument' does not exist` errors
 * across the suite rather than one clear message about the interface.
 *
 * Only the types moved: `__tests__/setup.ts`'s
 * `import "@testing-library/jest-dom"` still registers the matchers through
 * `expect.extend` exactly as before, which is why every test kept passing at
 * runtime while `tsc` went red.
 *
 * Augmenting `Matchers` also covers `expect.not.stringContaining(...)` and
 * friends — vitest 5's `AsymmetricMatchersContaining extends Matchers<any>`.
 *
 * Delete this file once jest-dom publishes a vitest 5 augmentation of its own.
 */
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  interface Matchers<
    R extends void | Promise<void> = void | Promise<void>,
    T = unknown,
  > extends TestingLibraryMatchers<unknown, R> {}
}
