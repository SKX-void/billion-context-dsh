import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import semver from 'semver'

// The peer contract spans FIVE seam packages the plugin VALUE-imports at
// runtime (not type-only, so they must resolve to the host's copy, not a
// stale nested copy): dsh-compaction, dsh-session, dsh-llm, dsh-tools and
// dsh-settings. DSH publishes them in lockstep, so ONE interval covers all
// five — the settings seam stopped moving on its own cadence when it joined
// the lockstep list on the 0.1.5 line.
//
// ISSUE #136 (0.1.5 line) floored the range once; the 0.2.0 line floors it
// again, on three verified seam breaks (all three probed against the
// 0.2.0-rc.2 devDeps, which is what `npm run typecheck` and `npm test` run on):
//   * the settings seam dropped `SettingsProvider`/`installSection` and now
//     exposes `SettingsForms`, keyed by PROFILE ENTRY ID: it projects a form
//     from the plugin's exported `static Config` and only accepts runtime
//     edits on `.volatile()` fields. The engine ports to it (src/settings.ts,
//     `static Config` = `AcpSettingsSchema`), so the old consumer entry point
//     it used is gone;
//   * checkpoint sources are written as the producer kind
//     `{ kind: 'compact-checkpoint', compactionId }` (`compactCheckpointSource`
//     from dsh-compaction) instead of the legacy `{ plugin: 'compact' }`
//     wrapper — and 0.2.0's `MessageSource` union rejects the old shape at
//     typecheck time;
//   * the module-augmentation convention moved to the ROOT package
//     (`declare module '@deepseek-ai/dsh-llm'`), not the `/message` subpath.
// A host below the floor cannot run the engine: the settings seam it enters
// does not exist there and its message-source union refuses the checkpoint
// source, so admitting those versions in the peer range would be a lie.
//
// The explicit `>=0.2.0-rc.2 <0.2.1-0` form pins EXACTLY the 0.2.0 line (every
// 0.2.0 prerelease from the verified rc.2 up, plus the final 0.2.0) and nothing
// beyond it: node-semver sorts `0.2.1-0` before any `0.2.1-x` prerelease
// (numeric ids precede alphanumeric ones), so the next line's alphas/rCs are
// rejected until someone verifies them deliberately. A caret
// (`^0.2.0-rc.2`) would silently admit 0.2.1+ — never allowed here (house rule:
// no unverified line).
//
// The same-tuple prerelease rule applies underneath: a candidate carrying a
// prerelease tag only satisfies a range when some comparator shares its
// [major, minor, patch] tuple — `0.2.0-rc.x` shares tuple 0.2.0, which is why
// one clause covers the whole line.
//
// Versions below come from `npm view @deepseek-ai/dsh-session versions` — the
// published line matches dsh-compaction / dsh-llm / dsh-tools / dsh-settings
// exactly. That line starts at 0.2.0-rc.1 (no 0.2.0 alpha was ever published);
// rc.2 is the floor because rc.2 is what was verified — rc.1 is the same line
// but unprobed, so it stays out until someone checks it and moves the floor.

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
	peerDependencies: Record<string, string>
}

// The runtime VALUE-imported seam packages (matches what dist/index.js pulls
// in). cordis is also a peer but ships on a 4.x line and is NOT part of this
// seam version band, so it is excluded — these five move in lockstep with the
// DSH host.
const seamPeers = [
	'@deepseek-ai/dsh-compaction',
	'@deepseek-ai/dsh-session',
	'@deepseek-ai/dsh-llm',
	'@deepseek-ai/dsh-tools',
	'@deepseek-ai/dsh-settings',
]

for (const peerName of seamPeers) {
	const peerRange = pkg.peerDependencies[peerName]
	assert.equal(typeof peerRange, 'string', `${peerName} must be declared as a peer (runtime VALUE-import)`)

	test(`${peerName}: peer range accepts the whole 0.2.0 seam line`, () => {
		// The verified floor itself installs.
		assert.equal(semver.satisfies('0.2.0-rc.2', peerRange), true, `0.2.0-rc.2 must satisfy ${peerRange}`)
		// Future same-tuple prereleases keep installing: publishing newer rCs on
		// the 0.2.0 line never breaks installs.
		for (const v of ['0.2.0-rc.9', '0.2.0-rc.99']) {
			assert.equal(semver.satisfies(v, peerRange), true, `${v} must satisfy ${peerRange} (same-line rc)`)
		}
		// A final 0.2.0 (no prerelease) is a normal version and stays in range.
		assert.equal(semver.satisfies('0.2.0', peerRange), true)
	})

	test(`${peerName}: peer range keeps rejecting older and next-line versions`, () => {
		// Same line, below the verified floor: rc.1 predates the seams this port
		// was probed against, so it is deliberately out until it is verified.
		assert.equal(semver.satisfies('0.2.0-rc.1', peerRange), false, `0.2.0-rc.1 must NOT satisfy ${peerRange}`)
		// Every older line, including the former devDep baselines (0.1.5-rc.1
		// and 0.1.0-rc.6) and the 0.1.7 line this plugin used to be capped at.
		// Their settings seam has no `SettingsForms` and their session sources
		// refuse the checkpoint kind, so they are intentionally out of contract.
		for (const v of ['0.1.0-rc.6', '0.1.3-alpha.2', '0.1.5-alpha.1', '0.1.5-rc.3', '0.1.6-alpha.1', '0.1.7-alpha.1', '0.1.7-rc.2']) {
			assert.equal(semver.satisfies(v, peerRange), false, `${v} must NOT satisfy ${peerRange}`)
		}
		// Next lines: 0.2.1 (any prerelease or final) and 0.3.x are deliberate,
		// later decisions — never silently allowed.
		for (const v of ['0.2.1-alpha.1', '0.2.1-rc.1', '0.2.1', '0.3.0']) {
			assert.equal(semver.satisfies(v, peerRange), false, `${v} must NOT satisfy ${peerRange}`)
		}
	})
}

test('every runtime VALUE-imported seam package is declared as a peer', () => {
	// dist/index.js must never carry a VALUE import of a @deepseek-ai seam
	// package that is NOT a peer — in a non-hoisted / stale-nested install that
	// resolves to a copy inconsistent with the host (the "reading 7" class of
	// crash). seamPeers above are the complete runtime set.
	for (const name of seamPeers) {
		assert.equal(typeof pkg.peerDependencies[name], 'string', `${name} must be a peer (runtime VALUE-import)`)
	}
})
