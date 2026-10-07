/**
 * M6 — runtime settings integration tests (issue #75 phase 1, ported to the
 * 0.2.0 settings seam).
 *
 * The 0.2.0 seam (`SettingsForms`) does not let a plugin register a namespace:
 * it projects one form per LOADER ENTRY from the entry's exported Config schema
 * and writes by ENTRY ID. So the plugin's six knobs ARE its `static Config`
 * (`AcpSettingsSchema`, every field `.volatile()`), and the engine reads them
 * through the live volatile references the loader hands it — a form write is
 * committed IN PLACE (`Entry.update` → `updateVolatile`), no remount.
 *
 * Coverage map:
 *  - pure units: filterSettingsEntry whitelist, engine-default mirror, the
 *    Config schema (volatile fields, NO defaults, integer / inclusive pct
 *    bounds), readSettingsInput / withoutSettingsKeys, parseSettingValue,
 *    describeSettingsChange diff flags, command-surface degradation;
 *  - E2E: a real engine on a bare cordis Context with loader-shaped volatile
 *    refs — live reads follow a volatile commit (no remount), /acp-prune config
 *    list/set/reset round-trips through a forms-like service keyed by entry id,
 *    the entry id comes from the owning profile entry, the kill switch ignores
 *    the service, a detached service is dropped, and reset preserves keys the
 *    six-key schema does not know.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service, type Message } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session } from '@deepseek-ai/dsh-session'
import {
  ACP_SETTINGS_NAMESPACE,
  AcpSettingsSchema,
  describeSettingsChange,
  filterSettingsEntry,
  makeSettingsCommandSurface,
  parseSettingValue,
  readSettingsInput,
  resolveAcpSettings,
  SETTINGS_KEYS,
  SETTING_DEFAULTS,
  withoutSettingsKeys,
  type AcpSettingsInput,
  type SettingsKey,
} from '../src/settings.ts'
import { AcpCompactionEngine, resolveAcpConfig, type AcpConfig } from '../src/index.ts'
import { kernelConfigFor } from '../src/config.ts'
import { acpCommand } from '../src/commands.ts'
import type { ToolEnvironment } from '../src/tools.ts'
import { DEFAULT_CONTEXT_WINDOW } from '../src/window.ts'

/**
 * Stand-in for a schemastery volatile field as the LOADER hands it to a plugin:
 * a stable reference whose `get()` always answers the live entry config
 * (`createVolatile` in @deepseek-ai/cosmokit; the loader commits a form write
 * with `updateVolatile(ref, source)` — same reference, new value, no remount).
 */
interface VolatileRef<T> {
  get(): T | undefined
  set(value: T | undefined): void
}

function volatileRef<T>(initial?: T): VolatileRef<T> {
  let current = initial
  return { get: () => current, set: (value) => { current = value } }
}

interface LoaderConfig {
  config: Partial<AcpConfig>
  refs: Record<SettingsKey, VolatileRef<unknown>>
}

/**
 * A composition row as the loader resolves it: the six declared settings fields
 * arrive as volatile references over the live entry config, every other field
 * passes through untouched.
 */
function loaderConfig(entry: AcpSettingsInput, extra: Partial<AcpConfig> = {}): LoaderConfig {
  const refs: Record<SettingsKey, VolatileRef<unknown>> = {
    modelContextLimit: volatileRef<unknown>(entry.modelContextLimit),
    autoModelContextLimit: volatileRef<unknown>(entry.autoModelContextLimit),
    nudgeMinContextLimitPct: volatileRef<unknown>(entry.nudgeMinContextLimitPct),
    nudgeMaxContextLimitPct: volatileRef<unknown>(entry.nudgeMaxContextLimitPct),
    nudgeEmergencyThresholdPct: volatileRef<unknown>(entry.nudgeEmergencyThresholdPct),
    autoNudge: volatileRef<unknown>(entry.autoNudge),
  }
  return { config: { ...refs, ...extra } as unknown as Partial<AcpConfig>, refs }
}

/** Commit one knob the way the loader does (in place, on the existing ref). */
function commit(refs: Record<SettingsKey, VolatileRef<unknown>>, key: SettingsKey, value: unknown): void {
  refs[key]!.set(value)
}

/**
 * Forms-like settings service (the 0.2.0 public surface: describe / update /
 * replace / mutate, keyed by profile entry id). It also plays the LOADER half
 * of a write — committing the new values into the running config references —
 * because a unit test has no profile directory and no config editor.
 */
class MemorySettingsForms extends Service {
  static provide = 'settings'
  /** Entry ids the host files forms under; the engine must pick its own. */
  namespaces: string[] = [ACP_SETTINGS_NAMESPACE]
  /** The profile patch override layer (`user`) and the inherited layer (`base`). */
  user: Record<string, unknown> = {}
  base: Record<string, unknown> = {}
  revision = 0
  /** Every write the engine issued, so the entry-id contract is assertable. */
  readonly writes: { ns: string; kind: 'update' | 'replace'; payload: Record<string, unknown> }[] = []
  /** The loader-side effect of a write. */
  refs: Record<SettingsKey, VolatileRef<unknown>> | undefined

  private commitWrite(kind: 'update' | 'replace', payload: Record<string, unknown>): void {
    if (this.refs === undefined) return
    for (const key of SETTINGS_KEYS) {
      if (key in payload) commit(this.refs, key, payload[key])
      else if (kind === 'replace') commit(this.refs, key, this.base[key])
    }
  }

  describe(): unknown[] {
    return this.namespaces.map((ns) => ({
      ns,
      revision: this.revision,
      autoGenerate: true,
      applies: 'live',
      schema: {},
      value: {},
      base: { ...this.base },
      user: { ...this.user },
    }))
  }

  /**
   * The real seam validates every write through `resolveConfig(entry.fiber
   * .runtime, next)` inside `configEditor.edit`, so an out-of-range value throws
   * there — the fixture must throw too, or the command's write-failure path goes
   * untested (rule 5: fixtures mirror real host behavior).
   */
  private validate(payload: Record<string, unknown>): void {
    AcpSettingsSchema(payload)
  }

  async update(ns: string, patch: Record<string, unknown>): Promise<void> {
    this.validate(patch)
    this.writes.push({ ns, kind: 'update', payload: patch })
    this.user = { ...this.user, ...patch }
    this.commitWrite('update', patch)
    this.revision += 1
  }

  async replace(ns: string, section: Record<string, unknown>): Promise<void> {
    this.validate(section)
    this.writes.push({ ns, kind: 'replace', payload: section })
    this.user = { ...section }
    this.commitWrite('replace', section)
    this.revision += 1
  }

  async mutate(_ns: string, _ops: readonly unknown[]): Promise<void> {}
}

/** Mount the real engine as a composition-row-like plugin on a fresh fork of `root`. */
async function mountEngine(
  root: Context,
  config: Partial<AcpConfig> = {},
  prepare?: (ctx: Context) => void,
): Promise<{ fiber: { dispose: () => Promise<void> }; engine: AcpCompactionEngine }> {
  let engine: AcpCompactionEngine | undefined
  const fiber = root.plugin((ctx) => {
    prepare?.(ctx)
    engine = new AcpCompactionEngine(ctx, config)
  })
  await fiber
  if (engine === undefined) throw new Error('engine did not mount')
  return { fiber, engine }
}

/** Drive /acp-prune through the real command handler (config paths never touch the agent). */
async function runAcp(env: ToolEnvironment, rawInput: string): Promise<string> {
  const command = acpCommand(env)
  const result = await command.handler({
    commandId: 'cmd-settings-test' as never,
    agent: {} as Agent,
    rawInput,
    signal: new AbortController().signal,
  } as never)
  assert.equal(result.kind, 'success')
  return (result as { text: string }).text
}

/** Read a possibly-volatile schema field as its plain value. */
function plain(value: unknown): unknown {
  return typeof (value as { get?: unknown })?.get === 'function' ? (value as { get(): unknown }).get() : value
}

// ── Pure units ────────────────────────────────────────────────────────────

test('M6: filterSettingsEntry keeps only the six settings keys', () => {
  const entry = {
    modelContextLimit: 200000,
    autoModelContextLimit: false,
    nudgeMinContextLimitPct: 0.5,
    nudgeMaxContextLimitPct: 0.72,
    nudgeEmergencyThresholdPct: 0.9,
    autoNudge: false,
    autoTools: false,
    autoCommand: false,
    settingsEnabled: false,
    prompts: { nudge: { text: 'x' } },
    coreOverrides: { nudge: { maxContextLimitPct: 0.8 } },
    countTokens: (text: string) => text.length,
  }
  assert.deepEqual(filterSettingsEntry(entry), {
    modelContextLimit: 200000,
    autoModelContextLimit: false,
    nudgeMinContextLimitPct: 0.5,
    nudgeMaxContextLimitPct: 0.72,
    nudgeEmergencyThresholdPct: 0.9,
    autoNudge: false,
  })
})

test('M6: engine defaults mirror SETTING_DEFAULTS (untouched settings reproduce today behavior)', () => {
  const defaults = resolveAcpConfig({})
  assert.equal(defaults.autoModelContextLimit, SETTING_DEFAULTS.autoModelContextLimit)
  assert.equal(defaults.autoNudge, SETTING_DEFAULTS.autoNudge)
  assert.equal(defaults.nudgeMaxContextLimitPct, SETTING_DEFAULTS.nudgeMaxContextLimitPct)
  assert.equal(defaults.nudgeEmergencyThresholdPct, SETTING_DEFAULTS.nudgeEmergencyThresholdPct)
  assert.equal(defaults.modelContextLimit, undefined)
  assert.equal(defaults.nudgeMinContextLimitPct, undefined)
})

test('M6: the Config schema declares the six knobs VOLATILE and defaultless', () => {
  // The host only accepts runtime edits on volatile fields, so every declared
  // field must carry `meta.volatile` (the seam's `volatileForm` finds the form
  // through exactly that flag).
  const dict = (AcpSettingsSchema as unknown as { dict: Record<string, { meta?: Record<string, unknown> }> }).dict
  assert.deepEqual(Object.keys(dict).sort(), [...SETTINGS_KEYS].sort())
  for (const key of SETTINGS_KEYS) {
    assert.equal(dict[key]?.meta?.volatile, true, `${key} must be volatile`)
    // NO `.default()` anywhere: the resolver applies defaults eagerly, and a
    // defaulted threshold would be indistinguishable from an explicit row value
    // and mask `config.preset` (issue #176). Defaults are applied at READ time.
    assert.equal('default' in (dict[key]?.meta ?? {}), false, `${key} must have no schema default`)
  }
  // And the resolved values really are live references, with nothing filled in.
  const viaSchema = AcpSettingsSchema({}) as unknown as Record<string, unknown>
  for (const key of SETTINGS_KEYS) {
    assert.equal(plain(viaSchema[key]), undefined, `${key} must resolve to undefined`)
  }
})

test('M6: schema enforces an integer, at-least-1 context limit', () => {
  assert.equal(plain(AcpSettingsSchema({ modelContextLimit: 1 }).modelContextLimit), 1)
  assert.equal(plain(AcpSettingsSchema({ modelContextLimit: 200000 }).modelContextLimit), 200000)
  assert.throws(() => AcpSettingsSchema({ modelContextLimit: 0 }), />= 1/)
  assert.throws(() => AcpSettingsSchema({ modelContextLimit: 128000.5 }), /multiple of 1/)
})

test('M6: schema pct bounds are inclusive (0 and 1 accepted, outside rejected)', () => {
  const zero = AcpSettingsSchema({ nudgeMaxContextLimitPct: 0, nudgeEmergencyThresholdPct: 0 })
  assert.equal(plain(zero.nudgeMaxContextLimitPct), 0)
  const one = AcpSettingsSchema({ nudgeMaxContextLimitPct: 1, nudgeEmergencyThresholdPct: 1 })
  assert.equal(plain(one.nudgeEmergencyThresholdPct), 1)
  assert.throws(() => AcpSettingsSchema({ nudgeMaxContextLimitPct: -0.1 }), />= 0/)
  assert.throws(() => AcpSettingsSchema({ nudgeEmergencyThresholdPct: 1.1 }), /<= 1/)
})

test('M6: readSettingsInput unwraps volatile refs and omits absent keys', () => {
  const { refs } = loaderConfig({ nudgeMaxContextLimitPct: 0.6, autoNudge: false })
  const entry = readSettingsInput(refs as unknown as AcpSettingsInput)
  assert.deepEqual(entry, { nudgeMaxContextLimitPct: 0.6, autoNudge: false })
  // Absent keys are OMITTED, never written as `undefined`: `resolveAcpConfig`
  // spreads this over DEFAULT_CONFIG and a present-but-undefined key erases the
  // default. `in` (not deepEqual) is the assertion that matters.
  for (const key of SETTINGS_KEYS) {
    if (key === 'nudgeMaxContextLimitPct' || key === 'autoNudge') continue
    assert.equal(key in entry, false, `${key} must be absent, not undefined`)
  }
  // A later commit is visible immediately (the ref is live, not a snapshot).
  commit(refs, 'nudgeMaxContextLimitPct', 0.55)
  assert.equal(readSettingsInput(refs as unknown as AcpSettingsInput).nudgeMaxContextLimitPct, 0.55)
  // Plain values (direct construction, unit tests) pass through unchanged.
  assert.deepEqual(readSettingsInput({ nudgeMaxContextLimitPct: 0.5 }), { nudgeMaxContextLimitPct: 0.5 })
})

test('M6: readSettingsInput recognizes REAL schemastery volatile refs', () => {
  // The critical integration point: the loader validates our Config schema, so
  // what the constructor receives is exactly this shape.
  const resolved = AcpSettingsSchema({ modelContextLimit: 64000, autoNudge: false }) as unknown as AcpSettingsInput
  assert.deepEqual(readSettingsInput(resolved), { modelContextLimit: 64000, autoNudge: false })
})

test('M6: withoutSettingsKeys strips the six knobs and keeps every other field', () => {
  const config = {
    modelContextLimit: volatileRef(200000),
    autoNudge: volatileRef(false),
    preset: 'aggressive',
    prompts: { nudge: { text: 'x' } },
    countTokens: (text: string) => text.length,
  }
  const rest = withoutSettingsKeys(config)
  assert.deepEqual(Object.keys(rest).sort(), ['countTokens', 'preset', 'prompts'])
  assert.equal(rest.preset, 'aggressive')
})

test('M6: parseSettingValue — booleans, numbers, null; `false` is a value, not an error', () => {
  assert.deepEqual(parseSettingValue('true'), { ok: true, value: true })
  assert.deepEqual(parseSettingValue('false'), { ok: true, value: false })
  assert.deepEqual(parseSettingValue('.7'), { ok: true, value: 0.7 })
  assert.deepEqual(parseSettingValue('2e5'), { ok: true, value: 200000 })
  assert.deepEqual(parseSettingValue('200000'), { ok: true, value: 200000 })
  assert.deepEqual(parseSettingValue('null'), { ok: true, value: null })
  assert.equal(parseSettingValue('garbage').ok, false)
  assert.equal(parseSettingValue('1.5.2').ok, false)
  assert.equal(parseSettingValue('   ').ok, false)
  assert.equal(parseSettingValue('FALSE').ok, false)
})

test('M6: describeSettingsChange flags window cache, nudge dedup, and order warnings', () => {
  const base = resolveAcpSettings({})
  // No-op diff stays quiet.
  let effect = describeSettingsChange(base, base)
  assert.equal(effect.clearWindowCache, false)
  assert.equal(effect.clearNudgeDedup, false)
  assert.deepEqual(effect.warnings, [])
  // Window-related keys changed → drop the (failure-caching) window cache.
  assert.equal(describeSettingsChange(base, { ...base, modelContextLimit: 300000 }).clearWindowCache, true)
  assert.equal(describeSettingsChange(base, { ...base, autoModelContextLimit: false }).clearWindowCache, true)
  // Re-enabling nudges clears the dedup map; disabling does not.
  const off = { ...base, autoNudge: false }
  assert.equal(describeSettingsChange(off, base).clearNudgeDedup, true)
  assert.equal(describeSettingsChange(base, off).clearNudgeDedup, false)
  // Order anomalies warn (accept, never reject).
  effect = describeSettingsChange(base, { ...base, nudgeMinContextLimitPct: 0.8, nudgeMaxContextLimitPct: 0.7 })
  assert.equal(effect.warnings.length, 1)
  assert.match(effect.warnings[0]!, /lower bound never engages/)
  effect = describeSettingsChange(base, { ...base, nudgeMaxContextLimitPct: 0.9 })
  assert.equal(effect.warnings.length, 1)
  assert.match(effect.warnings[0]!, /emergency tier loses its headroom/)
})

test('M6: command surface degrades without a service', async () => {
  const surface = makeSettingsCommandSurface(() => undefined, () => resolveAcpSettings({}), () => ACP_SETTINGS_NAMESPACE)
  assert.equal(surface.available, false)
  assert.equal(surface.describe(), undefined)
  await assert.rejects(surface.update({ autoNudge: false }), /not available/)
})

test('M6: command surface describes and writes BY ENTRY ID', async () => {
  const writes: { ns: string; kind: string; payload: Record<string, unknown> }[] = []
  const surface = makeSettingsCommandSurface(
    () => ({
      describe: () => [{ ns: 'other-row' }, { ns: 'my-acp-row' }],
      update: async (ns: string, patch: Record<string, unknown>) => { writes.push({ ns, kind: 'update', payload: patch }) },
      replace: async (ns: string, section: Record<string, unknown>) => { writes.push({ ns, kind: 'replace', payload: section }) },
    }) as never,
    () => resolveAcpSettings({}),
    () => 'my-acp-row',
  )
  assert.equal(surface.available, true)
  assert.equal(String((surface.describe() as { ns?: unknown } | undefined)?.ns), 'my-acp-row')
  await surface.update({ autoNudge: false })
  await surface.replaceSection({ autoNudge: true })
  assert.deepEqual(writes, [
    { ns: 'my-acp-row', kind: 'update', payload: { autoNudge: false } },
    { ns: 'my-acp-row', kind: 'replace', payload: { autoNudge: true } },
  ])
})

// ── E2E with a real engine + loader-shaped volatile config ────────────────

test('M6: engine env reads LIVE settings — a volatile commit hot-applies without a remount', async () => {
  const root = new Context()
  const { config, refs } = loaderConfig({})
  const { fiber, engine } = await mountEngine(root, config)
  try {
    assert.equal(engine.env.modelContextLimit, DEFAULT_CONTEXT_WINDOW)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.7)
    // The loader commits a form write in place (Entry.update → updateVolatile):
    // same engine instance, same ref, new value.
    commit(refs, 'nudgeMaxContextLimitPct', 0.6)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.6)
    assert.equal(kernelConfigFor(engine.env).nudge.maxContextLimitPct, 0.6)
    commit(refs, 'modelContextLimit', 32000)
    assert.equal(engine.env.modelContextLimit, 32000)
  } finally {
    await fiber.dispose()
  }
})

test('M6: a live commit reaches the window gate, not just the env getters', async () => {
  const root = new Context()
  // Composition keeps auto detection ON — only the live config turns it off.
  const { config, refs } = loaderConfig({})
  const { fiber, engine } = await mountEngine(root, config)
  try {
    const ctx = new Context()
    ctx.provide('sessionProjections', {
      snapshot: () => ({ values: { contextPressure: { contextWindow: 1000000 } } }),
    })
    ctx.provide('llm', {
      resolveModelInfo: async () => ({ context: { contextWindow: 64000 } }),
    })
    const agent = {
      id: 'test-session',
      session: Session.create('test-session'),
      options: { provider: 'test-provider', model: 'test-model' },
      ctx,
    } as unknown as Agent
    // Reading the COMPOSITION value at the gate would keep consulting the
    // projection even though the setting is now off.
    assert.equal((await engine.windowFor(agent)).source, 'projection')
    commit(refs, 'autoModelContextLimit', false)
    assert.notEqual((await engine.windowFor(agent)).source, 'projection')
  } finally {
    await fiber.dispose()
  }
})

test('M6: /acp-prune config list/set/reset round-trips through the forms service', async () => {
  const root = new Context()
  const forms = await root.plugin(MemorySettingsForms)
  const { config, refs } = loaderConfig({})
  ;(root.get('settings') as MemorySettingsForms).refs = refs
  const { fiber, engine } = await mountEngine(root, config)
  try {
    const list = await runAcp(engine.env, 'config')
    assert.match(list, /nudgeMaxContextLimitPct/)
    assert.match(list, /source/)

    const setResult = await runAcp(engine.env, 'config set nudgeMaxContextLimitPct 0.6')
    assert.match(setResult, /✓/)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.6)

    // A boolean key accepts `false` (the parse regression).
    const boolResult = await runAcp(engine.env, 'config set autoNudge false')
    assert.match(boolResult, /✓/)
    // `autoNudge` has no env getter (the nudge path reads the live snapshot
    // directly), so assert it through the command surface's snapshot.
    assert.equal(engine.env.settingsCommand?.snapshot().autoNudge, false)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.6)

    // Every write went to the ENTRY ID, never to a namespace we invented.
    assert.deepEqual(
      (root.get('settings') as MemorySettingsForms).writes.map((write) => write.ns),
      [ACP_SETTINGS_NAMESPACE, ACP_SETTINGS_NAMESPACE],
    )

    const resetResult = await runAcp(engine.env, 'config reset nudgeMaxContextLimitPct')
    assert.match(resetResult, /✓/)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.7)

    const unknown = await runAcp(engine.env, 'config set bogus 0.5')
    assert.match(unknown, /unknown key/)
    const invalid = await runAcp(engine.env, 'config set nudgeMaxContextLimitPct bogus')
    assert.match(invalid, /not a valid value/)
    const outOfRange = await runAcp(engine.env, 'config set nudgeMaxContextLimitPct 1.5')
    assert.match(outOfRange, /rejected/)
  } finally {
    await fiber.dispose()
    await forms.dispose()
  }
})

test('M6: the settings entry id comes from the owning profile entry', async () => {
  const root = new Context()
  const forms = await root.plugin(MemorySettingsForms)
  const service = root.get('settings') as MemorySettingsForms
  // The host files a form per entry id; ours must be picked out of the list.
  service.namespaces = ['some-other-row', 'my-acp-row']
  const { config, refs } = loaderConfig({})
  service.refs = refs
  const { fiber, engine } = await mountEngine(root, config, (ctx) => {
    Object.assign(ctx.fiber as object, { entry: { options: { id: 'my-acp-row' } } })
  })
  try {
    const setResult = await runAcp(engine.env, 'config set nudgeMaxContextLimitPct 0.6')
    assert.match(setResult, /✓/)
    assert.deepEqual(service.writes.map((write) => write.ns), ['my-acp-row'])
  } finally {
    await fiber.dispose()
    await forms.dispose()
  }
})

test('M6: settingsEnabled false is a kill switch — composition values stay, service ignored', async () => {
  const root = new Context()
  const forms = await root.plugin(MemorySettingsForms)
  const { config } = loaderConfig({ nudgeMaxContextLimitPct: 0.66 })
  ;(root.get('settings') as MemorySettingsForms).refs = loaderConfig({}).refs
  const { fiber, engine } = await mountEngine(root, { ...config, settingsEnabled: false })
  try {
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.66)
    assert.equal(engine.env.settingsCommand?.available, false)
    const setResult = await runAcp(engine.env, 'config set nudgeMaxContextLimitPct 0.5')
    assert.match(setResult, /no settings provider/)
    assert.equal((root.get('settings') as MemorySettingsForms).writes.length, 0)
  } finally {
    await fiber.dispose()
    await forms.dispose()
  }
})

test('M6: a detached settings service is dropped, the live values keep working', async () => {
  const root = new Context()
  const forms = await root.plugin(MemorySettingsForms)
  const { config, refs } = loaderConfig({ nudgeMaxContextLimitPct: 0.66 })
  ;(root.get('settings') as MemorySettingsForms).refs = refs
  const { fiber, engine } = await mountEngine(root, config)
  try {
    assert.equal(engine.env.settingsCommand?.available, true)
    const setResult = await runAcp(engine.env, 'config set nudgeMaxContextLimitPct 0.4')
    assert.match(setResult, /✓/)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.4)

    await forms.dispose()

    // Without the disposer the engine would hold a dead handle: /acp-prune
    // config would still report available and write into a disposed service.
    assert.equal(engine.env.settingsCommand?.available, false)
    // The six knobs are the entry config itself, so they keep reading live.
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.4)
    commit(refs, 'nudgeMaxContextLimitPct', 0.5)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.5)
  } finally {
    await fiber.dispose()
  }
})

test('M6: reset keeps keys the six-key schema does not know (no silent data loss)', async () => {
  const root = new Context()
  const forms = await root.plugin(MemorySettingsForms)
  const { config, refs } = loaderConfig({})
  const service = root.get('settings') as MemorySettingsForms
  service.refs = refs
  service.user = { nudgeMaxContextLimitPct: 0.6, handWritten: 'keep-me' }
  commit(refs, 'nudgeMaxContextLimitPct', 0.6)
  const { fiber, engine } = await mountEngine(root, config)
  try {
    const reset = await runAcp(engine.env, 'config reset nudgeMaxContextLimitPct')
    assert.match(reset, /✓/)
    // `replace()` merges the section over `base`, so a section rebuilt from
    // SETTING_KEYS alone would silently revert the operator's other overrides.
    const user = engine.env.settingsCommand?.describe()?.user as Record<string, unknown> | undefined
    assert.equal(user?.handWritten, 'keep-me')
    assert.equal(user?.nudgeMaxContextLimitPct, undefined)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.7)
  } finally {
    await fiber.dispose()
    await forms.dispose()
  }
})

// ── Issue #176: a composed preset must reach the live reads ────────────────
// Every kernel consumer reads the six scalar keys through the live settings
// source, never through `this.config` — so the preset has to be present in the
// live snapshot, or it silently never fires.

test('M6: a composed preset seeds the live reads (issue #176)', async () => {
  const root = new Context()
  const { config } = loaderConfig({}, { preset: 'aggressive' })
  const { fiber, engine } = await mountEngine(root, config)
  try {
    // Exactly the three preset-filled thresholds, resolved on the live path.
    assert.equal(engine.env.nudgeMinContextLimitPct, 0.3)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.5)
    assert.equal(engine.env.nudgeEmergencyThresholdPct, 0.7)
    assert.equal(kernelConfigFor(engine.env).nudge.maxContextLimitPct, 0.5)
  } finally {
    await fiber.dispose()
  }
})

test('M6: an explicit row value outranks the preset, which outranks the default', async () => {
  const root = new Context()
  // nudgeMax is spelled on the row; the other two come from the preset.
  const { config, refs } = loaderConfig({ nudgeMaxContextLimitPct: 0.55 }, { preset: 'aggressive' })
  const { fiber, engine } = await mountEngine(root, config)
  try {
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.55)
    assert.equal(engine.env.nudgeMinContextLimitPct, 0.3)
    assert.equal(engine.env.nudgeEmergencyThresholdPct, 0.7)
    // A live override still beats both.
    commit(refs, 'nudgeMaxContextLimitPct', 0.6)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.6)
    assert.equal(engine.env.nudgeMinContextLimitPct, 0.3)
  } finally {
    await fiber.dispose()
  }
})

test('M6: remounting the engine on the same root stays clean (no registration to collide)', async () => {
  const root = new Context()
  const forms = await root.plugin(MemorySettingsForms)
  const first = await mountEngine(root, loaderConfig({}).config)
  assert.equal(first.engine.env.nudgeMaxContextLimitPct, 0.7)
  await first.fiber.dispose()
  const second = await mountEngine(root, loaderConfig({ nudgeMaxContextLimitPct: 0.66 }).config)
  try {
    assert.equal(second.engine.env.nudgeMaxContextLimitPct, 0.66)
  } finally {
    await second.fiber.dispose()
    await forms.dispose()
  }
})
