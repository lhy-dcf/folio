// Offline acceptance: real runner + file repositories + built Electron IPC/UI.
// Run `bun run --cwd apps/electron build`, then `bun apps/electron/e2e/automation-freshness.ts`.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import type { AutomationRule, Quote } from '@finagent/core'
import { createMarketQuoteCapability } from '../../../packages/shared/src/capabilities/manifests/market-quote.ts'
import { defaultCapabilityFetchers } from '../../../packages/shared/src/capabilities/fetchers.ts'
import { createCapabilityRegistry } from '../../../packages/shared/src/capabilities/registry.ts'
import { ResearchDiffRepository } from '../../../packages/shared/src/research-diff/repository.ts'
import { JsonFileStore } from '../../../packages/shared/src/storage/json-file-store.ts'
import { runAutomation } from '../../../packages/shared/src/automation/runner.ts'
import { AutomationRuleRepository, AutomationRunRepository } from '../../../packages/shared/src/automation/rules-repository.ts'
import { buildBrief } from '../../../packages/shared/src/automation/brief.ts'
import { resolveElectronBinary } from './electron-harness.mjs'
import { seedLocale } from './seed-locale.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const repoRoot = join(here, '../../..')
const artifacts = join(here, 'artifacts', 'automation-freshness')
await mkdir(artifacts, { recursive: true })
const userData = await mkdtemp(join(here, '.user-data-automation-freshness-'))
const store = new JsonFileStore(userData)
seedLocale(userData, 'zh-CN')
await store.write('onboarding.json', { completed: true })
const rule: AutomationRule = {
  id: 'fixture-stale-quote', type: 'watchlist-daily-review', enabled: true,
  notify: 'all', createdAt: Date.now(), symbols: ['AAPL.US'],
}
// Display the recorded run, but prevent the actual app scheduler from executing it.
await new AutomationRuleRepository(store).save({ ...rule, enabled: false })

for (const stale of [true, false]) {
  const now = Date.now()
  const quote: Quote = {
    symbol: 'AAPL.US', lastPrice: 100, prevClose: 100, change: 0, changePercent: 0,
    high: 100, low: 100, open: 100, volume: 1000, timestamp: Math.floor(now / 1000) - 86_400,
  }
  const capability = createMarketQuoteCapability({
    ...defaultCapabilityFetchers,
    getQuote: async () => { throw new Error('Unexpected live quote fetch') },
    getQuoteResult: async () => ({
      data: quote,
      provenance: { providerId: 'fixture', providerName: 'Fixture', fetchedAt: now, stale },
    }),
  })
  let notifications = 0
  const run = await runAutomation(rule, {
    registry: createCapabilityRegistry([capability]), diffRepo: new ResearchDiffRepository(store),
    researchStart: async () => { throw new Error('Unexpected research request') },
    notify: async () => { notifications += 1 }, now: () => now,
    idGen: () => stale ? 'fixture-stale' : 'fixture-recovered',
  })
  assert.equal(run.outcome, stale ? 'incomplete' : 'no_material_update')
  assert.equal(notifications, stale ? 0 : 1)
  assert.equal(run.analyzed, 0)
  await new AutomationRunRepository(store).record(run)
  const runs = await new AutomationRunRepository(new JsonFileStore(userData)).list()
  const brief = buildBrief({ runs, alerts: [], diffs: [], movers: [], portfolio: [] }, now)
  assert.equal(brief.quiet.count, stale ? 0 : 1)
  const name = stale ? 'stale-incomplete' : 'fresh-recovered'
  await writeFile(join(artifacts, `${name}.json`), JSON.stringify({ run, notifications, quiet: brief.quiet }, null, 2))

  const app = await electron.launch({
    executablePath: resolveElectronBinary(appRoot, repoRoot),
    args: [join(appRoot, 'src/main/index.js'), '--disable-gpu'], cwd: repoRoot,
    env: {
      ...process.env, FINAGENT_AGENT_PROVIDER: 'local', FINAGENT_FORCE_PROD_LOAD: '1',
      FINAGENT_DEMO_DATA: '1', FINAGENT_E2E: '1', FINAGENT_E2E_HIDDEN: '1',
      FINAGENT_E2E_VISIBLE: '0', FINAGENT_USER_DATA_DIR: userData,
    },
  })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.webContents.setBackgroundThrottling(false)
    })
    await page.getByRole('button', { name: '今日', exact: true }).click()
    await page.locator('.folio-daily-brief-section').getByRole('button', { name: '管理', exact: true }).click()
    const rules = page.getByTestId('automation-rules-view')
    const expected = stale ? '运行未完成' : '未发现实质变化'
    await rules.getByText(expected, { exact: false }).waitFor()
    const persisted = await page.evaluate('window.electronAPI.automation.listRuns()')
    assert.equal(persisted.ok, true)
    assert.deepEqual(persisted.data.find((entry: { id: string }) => entry.id === run.id), run)
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    }))
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(
        undefined, { stayHidden: true, stayAwake: true },
      )
      return image.toPNG().toString('base64')
    })
    await writeFile(join(artifacts, `${name}.png`), Buffer.from(png, 'base64'))
    console.log(`PASS ${name}: persisted runner outcome displayed through real IPC after app startup`)
  } finally {
    await app.close()
  }
}
console.log(`Artifacts: ${artifacts}`)
