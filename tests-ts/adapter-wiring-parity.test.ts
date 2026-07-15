import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { HOOK_ADAPTERS, SUPPORTED_TOOLS } from '../src/supported';

/**
 * Guards the exact gap that let a real PR (a parked Antigravity adapter) slip
 * through review: adding an id to HOOK_ADAPTERS only proves the id exists in a
 * Set, not that the tool is actually detected or that `cch install` registers
 * a hook for it. v040.test.ts's `keeps the hook-adapter list in sync with
 * ALLOWED_ADAPTERS` test can be satisfied by adding the same string to two
 * Sets and nothing else, so it cannot catch a plumbing-only adapter.
 *
 * These checks read the real wiring source as text (the same doc-drift style
 * already used by hook-schema-check.yml) and fail if an id in HOOK_ADAPTERS
 * has no matching detection branch in detect.ts or registration branch in
 * cli.ts's cmdInstall. A parked/forward-compatible adapter should not be added
 * to HOOK_ADAPTERS until both exist.
 */

const detectSrc = fs.readFileSync(path.join(__dirname, '../src/detect.ts'), 'utf-8');
const cliSrc = fs.readFileSync(path.join(__dirname, '../src/cli.ts'), 'utf-8');

describe('adapter wiring parity (real detection + registration, not just set membership)', () => {
  it.each(HOOK_ADAPTERS)('%s is actually detected in detect.ts', (id) => {
    const hasDetection = new RegExp(`id:\\s*['"]${id}['"]`).test(detectSrc);
    expect(hasDetection, `HOOK_ADAPTERS contains '${id}' but detect.ts has no \`id: '${id}'\` ToolInfo entry, so detectInstalledTools() can never surface it for install`).toBe(true);
  });

  it.each(HOOK_ADAPTERS)('%s has a real hook-registration branch in cmdInstall (cli.ts)', (id) => {
    const hasRegistration = new RegExp(`tool\\.id\\s*===\\s*['"]${id}['"]`).test(cliSrc);
    expect(hasRegistration, `HOOK_ADAPTERS contains '${id}' but cli.ts has no \`tool.id === '${id}'\` branch, so \`cch install\` never registers a hook for it even if detected`).toBe(true);
  });

  it.each(HOOK_ADAPTERS)('%s is described in SUPPORTED_TOOLS as capturing via hooks, not just injecting', (id) => {
    const entry = SUPPORTED_TOOLS.find(t => t.id === id);
    expect(entry, `HOOK_ADAPTERS contains '${id}' but it has no SUPPORTED_TOOLS entry`).toBeDefined();
    expect(entry!.capture, `SUPPORTED_TOOLS['${id}'].capture should describe hook-based capture since it is in HOOK_ADAPTERS`).toMatch(/hooks? \(/);
  });
});
