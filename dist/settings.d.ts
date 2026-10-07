/**
 * M6 — runtime settings integration. Wires the engine's scalar knobs into the
 * host's settings form through the dsh-settings >= 0.2.0 seam
 * (`SettingsForms`), which projects one form per loader entry from that
 * entry's Config schema and requires its fields to be volatile. Editing the
 * form re-resolves the entry config in place, so a change applies to RUNNING
 * sessions without a restart.
 *
 * Layering (per key): engine default, then the inherited composition layer
 * (`base`), then the profile patch override (`user`); both layers are read
 * back from the host's `describe()` for this plugin's own entry id, so the
 * engine keeps no second store. The `/acp-prune config` slash command reads
 * and writes that form through the `SettingsCommandSurface` built here.
 *
 * Deliberately NOT exposed through settings: `coreOverrides`, `countTokens`,
 * `autoTools`, `autoCommand`, `prompts` (object/function values or
 * construction-time registrations), and the `settingsEnabled` kill switch
 * itself (a switch that turns off its own plumbing could not be reached if
 * the plumbing broke).
 * @module billion-context-dsh/settings
 */
import z from '@deepseek-ai/schemastery';
import type { SettingsDescriptor, SettingsForms } from '@deepseek-ai/dsh-settings';
/**
 * The settings entry id: the composition row id in cordis.patch.yml, which is
 * also the key the host files this plugin settings form under. Used as the
 * FALLBACK when the engine is built outside the loader (unit tests,
 * programmatic mounts), where no profile entry exists.
 */
export declare const ACP_SETTINGS_NAMESPACE = "compaction-acp";
/** The six knobs exposed to the runtime settings layer. Order defines /acp-prune config listing order. */
export declare const SETTINGS_KEYS: readonly ['modelContextLimit', 'autoModelContextLimit', 'nudgeMinContextLimitPct', 'nudgeMaxContextLimitPct', 'nudgeEmergencyThresholdPct', 'autoNudge'];
export type SettingsKey = (typeof SETTINGS_KEYS)[number];
/** Resolved shape of one settings snapshot — what every consumer read returns. */
export interface AcpSettings {
    /** Absent = auto-detection mode (probe the model's real window). */
    readonly modelContextLimit?: number;
    readonly autoModelContextLimit: boolean;
    /** Absent = the kernel's own 0.45 floor stays in effect. */
    readonly nudgeMinContextLimitPct?: number;
    readonly nudgeMaxContextLimitPct: number;
    readonly nudgeEmergencyThresholdPct: number;
    readonly autoNudge: boolean;
}
/** Input shape (everything optional — omitted keys fall back to defaults). */
export type AcpSettingsInput = Partial<AcpSettings>;
/**
 * Engine defaults for the settings-exposed keys — MUST mirror
 * `DEFAULT_CONFIG` in src/index.ts (locked together by tests/settings.test.ts,
 * which compares these against the real DEFAULT_CONFIG field by field).
 */
export declare const SETTING_DEFAULTS: {
    readonly autoModelContextLimit: true;
    readonly nudgeMaxContextLimitPct: 0.7;
    readonly nudgeEmergencyThresholdPct: 0.85;
    readonly autoNudge: true;
};
/**
 * The subset of `AcpConfig` the settings layer may see. Declared structurally
 * (instead of importing AcpConfig) so this module stays dependency-free —
 * src/index.ts's `AcpConfig` satisfies it as-is.
 */
export interface AcpSettingsCompositionEntry {
    readonly modelContextLimit?: number;
    readonly autoModelContextLimit?: boolean;
    readonly nudgeMinContextLimitPct?: number;
    readonly nudgeMaxContextLimitPct?: number;
    readonly nudgeEmergencyThresholdPct?: number;
    readonly autoNudge?: boolean;
}
/**
 * Filter a composition-row config down to the settings-known scalar keys.
 * This filtered subset is the ONLY thing handed to the settings layer as its
 * `base`: the raw row also carries prompts/coreOverrides/countTokens — object
 * and function values that would flow into the stored resolved snapshot (the
 * settings resolver does not reject unknown keys) and pollute describe()/clone
 * paths downstream.
 */
export declare function filterSettingsEntry(entry: AcpSettingsCompositionEntry): AcpSettingsInput;
/** Apply the engine defaults to a (possibly partial) settings input. */
export declare function resolveAcpSettings(input: AcpSettingsInput): AcpSettings;
/**
 * The plugin's cordis Config schema, and therefore the host settings form:
 * dsh-settings >= 0.2.0 (`SettingsForms`) projects one form per loader entry
 * from the entry's exported `Config`, and it refuses a runtime edit unless the
 * field is `.volatile()` ("Plugin entry ... has no volatile fields"). Editing
 * the form re-resolves the entry config in place, so every reader below sees
 * the new value without a restart.
 *
 * NO `.default()` on any field, deliberately: the schema resolver applies
 * defaults EAGERLY, so a defaulted `nudge*Pct` would be indistinguishable from
 * an explicit row value and would mask `config.preset` (issue #176). Engine
 * defaults live in `SETTING_DEFAULTS` / `resolveAcpSettings` and are applied at
 * READ time instead. Integer constraint uses `.step(1).min(1)` because
 * schemastery 3.18.x has no `.int()`/`.positive()` helpers.
 */
export declare const AcpSettingsSchema: z<Schemastery.ObjectS<NoInfer<{
    modelContextLimit: z<number, number, "volatile">;
    autoModelContextLimit: z<boolean, boolean, "volatile">;
    nudgeMinContextLimitPct: z<number, number, "volatile">;
    nudgeMaxContextLimitPct: z<number, number, "volatile">;
    nudgeEmergencyThresholdPct: z<number, number, "volatile">;
    autoNudge: z<boolean, boolean, "volatile">;
}>>, Schemastery.ObjectT<NoInfer<{
    modelContextLimit: z<number, number, "volatile">;
    autoModelContextLimit: z<boolean, boolean, "volatile">;
    nudgeMinContextLimitPct: z<number, number, "volatile">;
    nudgeMaxContextLimitPct: z<number, number, "volatile">;
    nudgeEmergencyThresholdPct: z<number, number, "volatile">;
    autoNudge: z<boolean, boolean, "volatile">;
}>>, "plain">;
export declare function readSettingsInput(config: AcpSettingsInput): AcpSettingsInput;
/**
 * A resolved config with the six settings keys REMOVED. Their values must never
 * reach `resolveAcpConfig` in wrapper form (a `Volatile` object spread over
 * `DEFAULT_CONFIG` would become the configured value); `readSettingsInput`
 * supplies the plain values instead.
 */
export declare function withoutSettingsKeys<T extends object>(config: T): Omit<T, SettingsKey>;
/** What changed between two settings snapshots, and what the engine must do about it. */
export interface SettingsChangeEffect {
    /**
     * The per-route window cache (which also caches probe FAILURES) must be
     * dropped so the next step re-resolves windows under the new limits.
     */
    clearWindowCache: boolean;
    /**
     * Re-enabling nudges clears the per-turn dedup map: entries written while
     * nudging was off must not suppress the first fresh nudge.
     */
    clearNudgeDedup: boolean;
    /** Human-readable order-anomaly warnings. Accepted, not rejected — a rejected write cannot fix an externally-edited file anyway. */
    readonly warnings: readonly string[];
}
/** Pure diff used by the engine's change handler (unit-testable without a context). */
export declare function describeSettingsChange(prev: AcpSettings, next: AcpSettings): SettingsChangeEffect;
/** Result of parsing a `/acp-prune config set` value. `null` means "reset this key". */
export type ParsedSettingValue = {
    ok: true;
    value: number | boolean | null;
} | {
    ok: false;
    reason: string;
};
/**
 * Four-step value parser for `/acp-prune config set` — deliberately NOT bare
 * JSON.parse, which rejects the most common human inputs (`.7` throws a
 * SyntaxError and the raw string would then fail schema validation; `null`
 * would silently mean "unset" only by convention). Order:
 * 1. `true` / `false` literals → booleans;
 * 2. anything Number() accepts finitely (`.7`, `2e5`, `200000`) → number;
 * 3. `null` (word) → reset-this-key sentinel;
 * 4. otherwise rejected with guidance.
 */
export declare function parseSettingValue(raw: string): ParsedSettingValue;
/** Everything `/acp-prune config` needs from the engine. Fakes in tests implement this directly. */
export interface SettingsCommandSurface {
    /** False in processes without a settings provider (plain npm-install compositions): the command degrades to advice instead of failing. */
    readonly available: boolean;
    /** Current effective values (works with or without a provider). */
    snapshot(): AcpSettings;
    /** Our namespace's descriptor (layers + revision), or undefined while unregistered. */
    describe(): SettingsDescriptor | undefined;
    /** Merge a patch into the user section and persist it. */
    update(patch: AcpSettingsInput): Promise<void>;
    /** Replace the whole user section ({} resets everything to base/defaults). */
    replaceSection(section: Record<string, unknown>): Promise<void>;
}
/**
 * Build the command surface over a lazily-captured settings service. The
 * engine captures the service through a parallel `ctx.inject(['settings'])`,
 * so the reference may legitimately be undefined for the whole process life
 * (headless/plain compositions have no settings provider).
 *
 * `getEntryId` answers this plugin's profile entry id — dsh-settings >= 0.2.0
 * files forms and writes BY ENTRY ID (`update(ns, patch)`), not by a namespace
 * the plugin registers for itself.
 */
export declare function makeSettingsCommandSurface(getService: () => SettingsForms | undefined, getSnapshot: () => AcpSettings, getEntryId: () => string): SettingsCommandSurface;
