import { defineConfig } from 'vitest/config'

/**
 * Type-only @deepseek-ai imports resolve through each linked package's
 * `exports` map (built lib/types); the subagent/command service faces are
 * stubbed inside the specs, so the only snapshot package loaded at runtime is
 * schemastery (for the Config schema).
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
