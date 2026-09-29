import { describe, expect, it } from 'vitest'
import { solvePlan } from '../src/core/analyze'
import {
  CommitmentGapEntry,
  minimumCommitmentGap,
  minimumCommitmentGapByNode,
} from '../src/core/gap'
import { Network } from '../src/core/types'
import {
  buildLargeNetwork,
  enumerateFeasibleFlows,
  FeasiblePoint,
  mulberry32,
  smallIntervalNetwork,
} from './helpers'

/** 校验见证与当前网络：容量、普通节点守恒、总量和需求点实际值一致。 */
function expectValidWitness(
  net: Network,
  disabled: ReadonlySet<string>,
  result: Extract<Awaited<ReturnType<typeof minimumCommitmentGap>>, { ok: true }>,
) {
  const balance = new Map<string, number>()
  const actualByNode = new Map<string, number>()
  net.nodes.forEach((n) => balance.set(n.id, 0))

  for (const e of result.witness) {
    expect(Number.isSafeInteger(e.flow)).toBe(true)
    expect(e.flow).toBeGreaterThanOrEqual(0)
    expect(e.flow).toBeLessThanOrEqual(e.capacity)

    if (e.kind === 'arc') {
      expect(disabled.has(e.id)).toBe(false)
      balance.set(e.from, (balance.get(e.from) ?? 0) - e.flow)
      balance.set(e.to, (balance.get(e.to) ?? 0) + e.flow)
    } else if (e.kind === 'source') {
      const source = net.sources.find((s) => s.node === e.id)
      expect(source).toBeDefined()
      expect(e.to).toBe(e.id)
      balance.set(e.to, (balance.get(e.to) ?? 0) + e.flow)
    } else {
      const sink = net.sinks.find((s) => s.node === e.id)
      expect(sink).toBeDefined()
      expect(e.from).toBe(e.id)
      balance.set(e.from, (balance.get(e.from) ?? 0) - e.flow)
      actualByNode.set(e.id, e.flow)
    }
  }

  // 停用管段不得出现在见证中。
  expect(result.witness.filter((e) => e.kind === 'arc').length).toBe(
    net.arcs.filter((a) => !disabled.has(a.id)).length,
  )
  balance.forEach((v) => expect(v).toBe(0))
  expect(result.allocations.every((a) => actualByNode.get(a.sinkNode) === a.actual)).toBe(true)
  expect(result.allocations.reduce((s, a) => s + a.actual, 0)).toBe(result.total)
}

function oracleGap(points: FeasiblePoint[], V: number, mins: (number | null)[]): number {
  let best = Infinity
  for (const p of points) {
    if (p.total !== V) continue
    let gap = 0
    mins.forEach((m, i) => {
      if (m !== null) gap += Math.max(0, m - p.sinkY[i])
    })
    best = Math.min(best, gap)
  }
  return best
}

function sharedBottleneckNetwork(): Network {
  return {
    nodes: [{ id: 's' }, { id: 'm' }, { id: 'd1' }, { id: 'd2' }],
    arcs: [
      { id: 'p', from: 's', to: 'm', capacity: 5 },
      { id: 'q1', from: 'm', to: 'd1', capacity: 5 },
      { id: 'q2', from: 'm', to: 'd2', capacity: 5 },
    ],
    sources: [{ node: 's', capacity: 100 }],
    sinks: [
      { node: 'd1', capacity: 5 },
      { node: 'd2', capacity: 5 },
    ],
  }
}

describe('最小承诺缺口：小网络穷举预言机', () => {
  it('共享瓶颈、冗余路径、零承诺、不可达及随机结构均给出最优联合方案', () => {
    const rng = mulberry32(20260929)
    for (let round = 0; round < 220; round++) {
      const net = smallIntervalNetwork(rng)
      const disabled = new Set<string>()
      if (rng() < 0.45) {
        net.arcs.forEach((a) => {
          if (rng() < 0.3) disabled.add(a.id)
        })
      }
      const solution = solvePlan(net, disabled)
      const V = solution.analysis.value
      const all = enumerateFeasibleFlows(net, disabled)
      expect(all.some((p) => p.total === V)).toBe(true)

      const mins = net.sinks.map((k) => {
        const choice = rng()
        if (choice < 0.2) return null
        if (choice < 0.35) return 0
        return Math.floor(rng() * (k.capacity + 1))
      })
      const entries: CommitmentGapEntry[] = []
      mins.forEach((m, i) => {
        if (m !== null) entries.push({ sinkIndex: i, minimum: m })
      })

      const result = minimumCommitmentGap(net, solution, entries)
      expect(result.ok).toBe(true)
      if (!result.ok) continue

      const expectedGap = oracleGap(all, V, mins)
      expect(result.totalGap).toBe(expectedGap)
      expect(result.total).toBe(V)
      expect(result.committedEntries).toBe(entries.length)
      expect(result.committedTotal).toBe(
        entries.reduce((s, e) => s + e.minimum, 0),
      )

      const actualGap = result.allocations.reduce((s, a) => s + a.gap, 0)
      expect(actualGap).toBe(result.totalGap)
      result.allocations.forEach((a, i) => {
        if (mins[i] === null) {
          expect(a.committed).toBeNull()
          expect(a.gap).toBe(0)
        } else {
          expect(a.committed).toBe(mins[i])
          expect(a.gap).toBe(Math.max(0, mins[i] - a.actual))
        }
        expect(all.some((p) => p.total === V && p.sinkY[i] === a.actual)).toBe(true)
      })
      // 关键：逐点实际值必须拼成同一条预言机中的联合最大流，而非各自独立上界。
      expect(
        all.some(
          (p) =>
            p.total === V &&
            result.allocations.every((a, i) => p.sinkY[i] === a.actual),
        ),
      ).toBe(true)
      expectValidWitness(net, disabled, result)
    }
  })
})

describe('最小承诺缺口：锁定场景与确定裁决', () => {
  it('共享瓶颈：总送水量仍为最大值 5，3+3 的最小缺口为 1', () => {
    const net = sharedBottleneckNetwork()
    const solution = solvePlan(net, new Set())
    const result = minimumCommitmentGapByNode(net, solution, [
      { node: 'd1', minimum: 3 },
      { node: 'd2', minimum: 3 },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.total).toBe(5)
    expect(result.committedTotal).toBe(6)
    expect(result.totalGap).toBe(1)
    expect(result.allocatedToCommitted).toBe(5)
    expect(result.allocations.map((a) => a.gap).sort()).toEqual([0, 1])
    expect(result.allocations.map((a) => a.actual).sort()).toEqual([2, 3])
    expectValidWitness(net, new Set(), result)
  })

  it('冗余路径可让总缺口为 0，并保持最大总量', () => {
    const net: Network = {
      nodes: [{ id: 's' }, { id: 'd1' }, { id: 'd2' }],
      arcs: [
        { id: 'a', from: 's', to: 'd1', capacity: 3 },
        { id: 'b', from: 's', to: 'd2', capacity: 3 },
        { id: 'c', from: 's', to: 'd2', capacity: 2 },
      ],
      sources: [{ node: 's', capacity: 10 }],
      sinks: [
        { node: 'd1', capacity: 5 },
        { node: 'd2', capacity: 5 },
      ],
    }
    const solution = solvePlan(net, new Set())
    const result = minimumCommitmentGap(net, solution, [
      { sinkIndex: 0, minimum: 3 },
      { sinkIndex: 1, minimum: 5 },
    ])
    expect(result).toMatchObject({
      ok: true,
      total: 8,
      totalGap: 0,
    })
    if (result.ok) expectValidWitness(net, new Set(), result)
  })

  it('零承诺是合法承诺：缺口为 0，且仍返回最大流见证', () => {
    const net = sharedBottleneckNetwork()
    const solution = solvePlan(net, new Set())
    const result = minimumCommitmentGapByNode(net, solution, [
      { node: 'd1', minimum: 0 },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.committedEntries).toBe(1)
    expect(result.committedTotal).toBe(0)
    expect(result.totalGap).toBe(0)
    expect(result.allocations[0].committed).toBe(0)
    expectValidWitness(net, new Set(), result)
  })

  it('不可达节点：该点承担全部缺口，其它承诺可在同一见证中满足', () => {
    const net = sharedBottleneckNetwork()
    const disabled = new Set(['q2'])
    const solution = solvePlan(net, disabled)
    const result = minimumCommitmentGap(net, solution, [
      { sinkIndex: 0, minimum: 4 },
      { sinkIndex: 1, minimum: 2 },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.total).toBe(5)
    expect(result.totalGap).toBe(2)
    expect(result.allocations[0]).toMatchObject({ actual: 5, gap: 0 })
    expect(result.allocations[1]).toMatchObject({ actual: 0, gap: 2 })
    expectValidWitness(net, disabled, result)
  })

  it('相同输入重复诊断返回同一最优值与同一份裁决', () => {
    const net = sharedBottleneckNetwork()
    const solution = solvePlan(net, new Set())
    const entries: CommitmentGapEntry[] = [
      { sinkIndex: 0, minimum: 3 },
      { sinkIndex: 1, minimum: 3 },
    ]
    const a = minimumCommitmentGap(net, solution, entries)
    const b = minimumCommitmentGap(net, solution, entries)
    expect(a).toEqual(b)
  })
})

describe('最小承诺缺口：失败隔离与输入校验', () => {
  it('超容量、重复、越界和陌生节点均失败且不抛出', () => {
    const net = sharedBottleneckNetwork()
    const solution = solvePlan(net, new Set())
    expect(minimumCommitmentGap(net, solution, [{ sinkIndex: 0, minimum: 6 }]).ok).toBe(false)
    expect(
      minimumCommitmentGap(net, solution, [
        { sinkIndex: 0, minimum: 1 },
        { sinkIndex: 0, minimum: 1 },
      ]).ok,
    ).toBe(false)
    expect(minimumCommitmentGap(net, solution, [{ sinkIndex: 9, minimum: 0 }]).ok).toBe(false)
    expect(
      minimumCommitmentGapByNode(net, solution, [{ node: 'ghost', minimum: 0 }]).ok,
    ).toBe(false)
  })

  it('诊断失败后同一方案仍可正常做最大流、区间和联合承诺', () => {
    const net = sharedBottleneckNetwork()
    const solution = solvePlan(net, new Set())
    const failed = minimumCommitmentGapByNode(net, solution, [
      { node: 'd1', minimum: 99 },
    ])
    expect(failed.ok).toBe(false)
    expect(solution.analysis.value).toBe(5)
    expect(solution.flow.length).toBe(solution.edges.length)
    const retry = minimumCommitmentGapByNode(net, solution, [
      { node: 'd1', minimum: 2 },
      { node: 'd2', minimum: 2 },
    ])
    expect(retry).toMatchObject({ ok: true, totalGap: 0 })
  })
})

describe('最小承诺缺口：性能', () => {
  it('10000 节点 / 50000 管段一次诊断四秒内完成', () => {
    const net = buildLargeNetwork()
    const entries = net.sinks.slice(0, 10).map((s, i) => ({
      sinkIndex: i,
      minimum: Math.floor(s.capacity / 2),
    }))
    const start = performance.now()
    const solution = solvePlan(net, new Set())
    const result = minimumCommitmentGap(net, solution, entries)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(4000)
    expect(result.ok).toBe(true)
    if (result.ok) expectValidWitness(net, new Set(), result)
  })
})
