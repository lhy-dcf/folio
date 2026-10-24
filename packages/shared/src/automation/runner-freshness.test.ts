import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AutomationRule, NotificationEvent, Quote, ResearchDiff } from '@finagent/core'
import { createMarketQuoteCapability } from '../capabilities/manifests/market-quote.ts'
import { defaultCapabilityFetchers } from '../capabilities/fetchers.ts'
import { createCapabilityRegistry } from '../capabilities/registry.ts'
import type { ResearchDiffRepository } from '../research-diff/repository.ts'
import { JsonFileStore } from '../storage/json-file-store.ts'
import { buildBrief } from './brief.ts'
import { AutomationRunRepository } from './rules-repository.ts'
import { runAutomation } from './runner.ts'

const NOW = 1_700_000_000_000
const RULE: AutomationRule = {
  id: 'freshness-rule', type: 'watchlist-daily-review', enabled: true,
  notify: 'material-only', createdAt: NOW,
}

function quote(lastPrice = 100): Quote {
  return {
    symbol: 'AAPL.US', lastPrice, prevClose: 100, change: lastPrice - 100,
    changePercent: lastPrice - 100, high: lastPrice, low: 100, open: 100,
    volume: 1000, timestamp: NOW / 1000 - 30 * 86_400,
  }
}

function fixture(options: {
  quotes?: Record<string, Quote>
  stale?: string[]
  delayed?: boolean
  diff?: ResearchDiff
} = {}) {
  const quotes = options.quotes ?? { 'AAPL.US': quote() }
  const stale = new Set(options.stale ?? ['AAPL.US'])
  const research: string[] = []
  const notifications: NotificationEvent[] = []
  let sequence = 0
  // Exercise the production capability's provider-provenance merge, not a
  // synthetic capability that bypasses normalization.
  const capability = createMarketQuoteCapability({
    ...defaultCapabilityFetchers,
    getQuote: async () => { throw new Error('Unexpected data-only fetch') },
    getQuoteResult: async (symbol) => ({
      data: quotes[symbol]!,
      provenance: {
        providerId: 'fixture', providerName: 'Fixture', fetchedAt: NOW,
        marketTime: quotes[symbol]!.timestamp * 1000,
        stale: stale.has(symbol), delayed: options.delayed ?? false,
      },
    }),
  })
  const context = {
    registry: createCapabilityRegistry([capability]),
    diffRepo: { getBySymbol: async () => options.diff } as unknown as ResearchDiffRepository,
    watchlistSymbols: () => Object.keys(quotes),
    researchStart: async (symbol: string) => { research.push(symbol) },
    notify: async (event: NotificationEvent) => { notifications.push(event) },
    now: () => NOW,
    idGen: () => `freshness-run-${++sequence}`,
  }
  return { context, stale, research, notifications }
}

describe('automation quote freshness (#185)', () => {
  it.each(['material-only', 'all'] as const)(
    'does not call newly fetched stale data no-change or notify quiet (%s)',
    async (notify) => {
      const { context, research, notifications } = fixture()
      const run = await runAutomation({ ...RULE, notify }, context)
      expect(run).toMatchObject({
        outcome: 'incomplete', evaluated: 1, materialChanges: 0, analyzed: 0,
        notified: false, failures: ['AAPL.US: quote stale'],
      })
      expect(research).toEqual([])
      expect(notifications).toEqual([])
    },
  )

  it('does not research or notify a material price move based only on stale data', async () => {
    const { context, research, notifications } = fixture({ quotes: { 'AAPL.US': quote(106) } })
    const run = await runAutomation(RULE, context)
    expect(run.outcome).toBe('incomplete')
    expect(run.materialChanges).toBe(0)
    expect(run.failures).toEqual(['AAPL.US: quote stale'])
    expect(research).toEqual([])
    expect(notifications).toEqual([])
  })

  it('keeps independent material research signals without citing the stale price move', async () => {
    const { context, research, notifications } = fixture({
      quotes: { 'AAPL.US': quote(106) },
      diff: {
        id: 'diff', symbol: 'AAPL.US', previousReportId: 'before', currentReportId: 'after',
        generatedAt: NOW, changes: [], material: true, summary: 'Independent change',
      },
    })
    const run = await runAutomation(RULE, context)
    expect(run).toMatchObject({
      outcome: 'incomplete', materialChanges: 1, analyzed: 1,
      failures: ['AAPL.US: quote stale'],
    })
    expect(research).toEqual(['AAPL.US'])
    expect(notifications).toHaveLength(1)
    expect(notifications[0]!.payload?.priceMovePct).toBeUndefined()
    expect(notifications[0]!.message).not.toContain('6.0%')
  })

  it('does not mistake delayed or old market timestamps for provider-declared stale data', async () => {
    const { context } = fixture({ stale: [], delayed: true })
    const run = await runAutomation(RULE, context)
    expect(run).toMatchObject({ outcome: 'no_material_update', evaluated: 1, failures: [] })
  })

  it('continues healthy symbols without declaring a mixed scope complete', async () => {
    const { context, research, notifications } = fixture({ quotes: {
      'AAPL.US': quote(), 'MSFT.US': { ...quote(106), symbol: 'MSFT.US' },
    } })
    const run = await runAutomation({ ...RULE, notify: 'all' }, context)
    expect(run).toMatchObject({
      outcome: 'incomplete', evaluated: 2, materialChanges: 1, analyzed: 1,
      failures: ['AAPL.US: quote stale'],
    })
    expect(research).toEqual(['MSFT.US'])
    expect(notifications.map((event) => event.symbol)).toEqual(['MSFT.US'])
  })

  it('recovers when the next provider result is fresh', async () => {
    const { context, stale } = fixture()
    const first = await runAutomation(RULE, context)
    stale.clear()
    const next = await runAutomation(RULE, context)
    expect(first.outcome).toBe('incomplete')
    expect(next).toMatchObject({ outcome: 'no_material_update', failures: [] })
    expect(first.failures).toEqual(['AAPL.US: quote stale'])
  })

  it('keeps the persisted incomplete run out of the daily brief quiet scope after reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'folio-automation-stale-'))
    try {
      const { context } = fixture()
      const run = await runAutomation(RULE, context)
      await new AutomationRunRepository(new JsonFileStore(root)).record(run)
      const reloaded = await new AutomationRunRepository(new JsonFileStore(root)).list()
      expect(reloaded[0]).toMatchObject({ outcome: 'incomplete', failures: ['AAPL.US: quote stale'] })
      const brief = buildBrief({ runs: reloaded, alerts: [], diffs: [], portfolio: [], movers: [] }, NOW)
      expect(brief.quiet.count).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
