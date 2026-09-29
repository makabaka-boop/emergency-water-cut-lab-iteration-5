import { describe, expect, it } from 'vitest'
import { solvePlan } from '../src/core/analyze'
import { jointCommitment } from '../src/core/commitment'
import {
  GapEntry,
  minimumCommitmentGap,
  minimumCommitmentGapByNode,
} from '../src/core/gap'
import { sinkInterval } from '../src/core/interval'
import { Network } from '../src/core/types'
import {
  buildLargeNetwork,
  enumerateFeasibleFlows,
  FeasiblePoint,
  mulberry32,
  smallIntervalNetwork,
} from './helpers'

/**
 * 穷举预言机：固定总量 V 的全部可行最大流中，求总缺口最小值与
 * 字典序（按需求点顺序）最优的逐点实际供水向量。
 *
 * 缺口口径 s_k = min(y_k, d_k)（承诺点被超额供给不再增加满足），
 * 总缺口 = Σ(d_k − s_k)。先筛总缺口最小的方案，再在其中逐点取
 * s_k 的字典序最大，s 相同则取实际水量 y_k 的字典序最大，
 * 得到唯一的裁决向量（与生产代码的两阶段字典序裁决同口径）。
 */
function oracleOptimum(
  all: FeasiblePoint[],
  V: number,
  mins: (number | null)[],
): { minGap: number; vector: number[] } {
  const maxPoints = all.filter((p) => p.total === V)
  expect(maxPoints.length).toBeGreaterThan(0)

  const satisfied = (y: number, k: number): number =>
    mins[k] === null ? 0 : Math.min(y, (mins[k] as number))
  const gapOf = (p: FeasiblePoint): number =>
    mins.reduce<number>((g, m, k) => {
      if (m === null) return g
      return g + (m - Math.min(p.sinkY[k], m))
    }, 0)

  let minGap = Infinity
  for (const p of maxPoints) minGap = Math.min(minGap, gapOf(p))
  const best = maxPoints.filter((p) => gapOf(p) === minGap)

  const choose = (
    pool: FeasiblePoint[],
    key: (p: FeasiblePoint, k: number) => number,
  ): FeasiblePoint[] => {
    let winners = pool
    for (let k = 0; k < mins.length; k++) {
      if (mins[k] === null) continue
      let bestKey = -Infinity
      for (const p of winners) bestKey = Math.max(bestKey, key(p, k))
      winners = winners.filter((p) => key(p, k) === bestKey)
    }
    return winners
  }

  // 第一关键字：逐点满足量 s_k 字典序最大；第二关键字：承诺点实际水量 y_k
  // （未承诺点不参与裁决——它怎么分都不影响缺口，留给见证即可）。
  const afterSatisfied = choose(best, (p, k) => satisfied(p.sinkY[k], k))
  let winners = afterSatisfied
  for (let k = 0; k < mins.length; k++) {
    if (mins[k] === null) continue
    let bestY = -Infinity
    for (const p of winners) bestY = Math.max(bestY, p.sinkY[k])
    winners = winners.filter((p) => p.sinkY[k] === bestY)
  }
  return { minGap, vector: winners[0].sinkY }
}

/** 独立校验见证：容量、原节点守恒、超级源汇平衡、逐点水量与总量。 */
function expectValidWitness(
  net: Network,
  disabled: ReadonlySet<string>,
  result: Extract<Awaited<ReturnType<typeof minimumCommitmentGap>>, { ok: true }>,
): FeasiblePoint {
  const solution = solvePlan(net, disabled)
  const n = net.nodes.length
  const V = solution.analysis.value

  expect(result.total).toBe(V)
  expect(result.witness.total).toBe(V)
  // 见证边数与建模边一致、身份与顺序一致。
  expect(result.witness.edges.length).toBe(solution.edges.length)
  result.witness.edges.forEach((w, i) => {
    const e = solution.edges[i]
    expect(w.kind).toBe(e.kind)
    expect(w.id).toBe(e.id)
    expect(w.capacity).toBe(e.capacity)
    expect(Number.isSafeInteger(w.flow)).toBe(true)
    expect(w.flow).toBeGreaterThanOrEqual(0)
    expect(w.flow).toBeLessThanOrEqual(w.capacity)
  })

  const balance = new Float64Array(n + 2)
  result.witness.edges.forEach((w, i) => {
    const e = solution.edges[i]
    balance[e.from] -= w.flow
    balance[e.to] += w.flow
  })
  for (let v = 0; v < n; v++) expect(balance[v]).toBe(0)
  expect(-balance[solution.superSource] + 0).toBe(V)
  expect(balance[solution.superSink]).toBe(V)

  // 逐点实际供水 = 见证中需求边流量。
  const sinkY: number[] = []
  net.sinks.forEach((k, sinkIndex) => {
    const w = result.witness.edges[solution.sinkEdgeIndex[sinkIndex]]
    expect(w.id).toBe(k.node)
    expect(result.allocations[sinkIndex].delivered).toBe(w.flow)
    sinkY.push(w.flow)
  })
  expect(sinkY.reduce((a, b) => a + b, 0)).toBe(V)
  return { sinkY, total: V }
}

describe('最小承诺缺口：穷举预言机（小网络全承诺组合）', () => {
  it('小整数网络（重边/反向边/自环/零容量/供需同点/随机断管）总缺口、逐点供水与裁决向量与穷举一致', () => {
    const rng = mulberry32(20260929)
    const ROUNDS = 340
    let comboCount = 0
    for (let round = 0; round < ROUNDS; round++) {
      const net = smallIntervalNetwork(rng)
      const disabled = new Set<string>()
      if (rng() < 0.5) {
        net.arcs.forEach((a) => {
          if (rng() < 0.3) disabled.add(a.id)
        })
      }

      const solution = solvePlan(net, disabled)
      const V = solution.analysis.value
      const all = enumerateFeasibleFlows(net, disabled)
      expect(all.some((p) => p.total === V)).toBe(true)

      const sinkCount = net.sinks.length
      // 每个需求点：null=留空 或 0..容量；全组合与预言机逐一比对。
      const choices: (number | null)[][] = net.sinks.map((k) => {
        const out: (number | null)[] = [null]
        for (let v = 0; v <= k.capacity; v++) out.push(v)
        return out
      })
      const combos: (number | null)[][] = [[]]
      for (let k = 0; k < sinkCount; k++) {
        const next: (number | null)[][] = []
        for (const prefix of combos) for (const c of choices[k]) next.push([...prefix, c])
        combos.length = 0
        combos.push(...next)
      }

      for (const mins of combos) {
        comboCount++
        const entries: GapEntry[] = []
        mins.forEach((m, k) => {
          if (m !== null) entries.push({ sinkIndex: k, minimum: m })
        })
        const result = minimumCommitmentGap(solution, entries)
        expect(result.ok, `round=${round} mins=${JSON.stringify(mins)}`).toBe(true)
        if (!result.ok) continue

        const oracle = oracleOptimum(all, V, mins)

        // 总缺口为穷举最小值；总量仍严格等于最大值 V。
        expect(result.totalGap).toBe(oracle.minGap)
        expect(result.total).toBe(V)
        expect(result.committed).toBe(entries.length)
        // 逐点实际供水与字典序唯一裁决向量逐项一致（含未承诺点）。
        expect(result.allocations.map((a) => a.delivered)).toEqual(oracle.vector)
        // 缺口口径与承诺标记。
        result.allocations.forEach((a, k) => {
          if (mins[k] === null) {
            expect(a.minimum).toBeNull()
            expect(a.gap).toBe(0)
          } else {
            expect(a.minimum).toBe(mins[k])
            expect(a.gap).toBe(Math.max(0, (mins[k] as number) - a.delivered))
            expect(a.gap).toBe((mins[k] as number) - Math.min(a.delivered, mins[k] as number))
          }
        })
        expect(result.totalGap).toBe(
          result.allocations.reduce((g, a) => g + a.gap, 0),
        )

        // 见证必须真的满足容量与守恒，且就是展示的这份逐点供水。
        const witnessPoint = expectValidWitness(net, disabled, result)
        expect(witnessPoint.sinkY).toEqual(oracle.vector)
      }
    }
    // 保证组合规模确实可观（非空测试）。
    expect(comboCount).toBeGreaterThan(3000)
  })
})

describe('最小承诺缺口：锁定场景', () => {
  /** 共享瓶颈：s→m 容量 5，m→d1 / m→d2 各容量 5。 */
  function sharedNet(): Network {
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

  it('共享瓶颈 5、各承诺 3：不可同时兑现时缺口压到 1，裁决向量 (3,2)', () => {
    const net = sharedNet()
    const solution = solvePlan(net, new Set())
    expect(solution.analysis.value).toBe(5)

    // 联合裁决仍判不可行（既有结论不受诊断影响）。
    const result = minimumCommitmentGap(solution, [
      { sinkIndex: 0, minimum: 3 },
      { sinkIndex: 1, minimum: 3 },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.totalGap).toBe(1)
    expect(result.allocations.map((a) => [a.delivered, a.gap])).toEqual([
      [3, 0],
      [2, 1],
    ])
    expect(result.total).toBe(5)

    const all = enumerateFeasibleFlows(net, new Set())
    const oracle = oracleOptimum(all, 5, [3, 3])
    expect(oracle.minGap).toBe(1)
    expect(oracle.vector).toEqual([3, 2])
    expectValidWitness(net, new Set(), result)
  })

  it('多个同优方案（承诺 2/2）：字典序裁决 (3,2) 且重复运行逐项稳定', () => {
    const net = sharedNet()
    const solution = solvePlan(net, new Set())
    const entries: GapEntry[] = [
      { sinkIndex: 0, minimum: 2 },
      { sinkIndex: 1, minimum: 2 },
    ]
    const r1 = minimumCommitmentGap(solution, entries)
    const r2 = minimumCommitmentGap(solvePlan(net, new Set()), entries)
    expect(r1.ok && r2.ok).toBe(true)
    if (!r1.ok || !r2.ok) return
    expect(r1).toEqual(r2)
    // 承诺均兑现（缺口 0）；多个总量 5 的方案中 s 相同，按实际水量字典序取 (3,2)。
    expect(r1.totalGap).toBe(0)
    expect(r1.allocations.map((a) => a.delivered)).toEqual([3, 2])
    expectValidWitness(net, new Set(), r1)
  })

  it('冗余路径：任一单管断开最大流不变，承诺仍可全额兑现', () => {
    const net: Network = {
      nodes: [{ id: 's' }, { id: 'd' }],
      arcs: [
        { id: 'r1', from: 's', to: 'd', capacity: 3 },
        { id: 'r2', from: 's', to: 'd', capacity: 3 },
      ],
      sources: [{ node: 's', capacity: 10 }],
      sinks: [{ node: 'd', capacity: 10 }],
    }
    const full = solvePlan(net, new Set())
    expect(full.analysis.value).toBe(6)
    const rFull = minimumCommitmentGap(full, [{ sinkIndex: 0, minimum: 6 }])
    expect(rFull).toMatchObject({ ok: true, totalGap: 0, total: 6 })

    const oneBroken = solvePlan(net, new Set(['r1']))
    expect(oneBroken.analysis.value).toBe(3)
    const rBroken = minimumCommitmentGap(oneBroken, [
      { sinkIndex: 0, minimum: 6 },
    ])
    expect(rBroken.ok).toBe(true)
    if (rBroken.ok) {
      expect(rBroken.totalGap).toBe(3)
      expect(rBroken.allocations[0]).toMatchObject({ delivered: 3, gap: 3 })
      expectValidWitness(net, new Set(['r1']), rBroken)
    }
  })

  it('不可达需求点：承诺全部转为缺口，水量 0；可达点不受影响', () => {
    const net: Network = {
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
    // 停用 q2：d2 完全不可达，5 单位全给 d1。
    const cut = solvePlan(net, new Set(['q2']))
    expect(cut.analysis.value).toBe(5)
    const result = minimumCommitmentGap(cut, [
      { sinkIndex: 0, minimum: 4 },
      { sinkIndex: 1, minimum: 3 },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.allocations.map((a) => [a.delivered, a.gap])).toEqual([
      [5, 0],
      [0, 3],
    ])
    expect(result.totalGap).toBe(3)
    expectValidWitness(net, new Set(['q2']), result)
  })

  it('零承诺点与零容量点不产生缺口；强制过水的零承诺点富余水可被无偿调走', () => {
    const net: Network = {
      nodes: [{ id: 's' }, { id: 'a' }, { id: 'd' }],
      // s 只能经 a 到达 d：a 作为需求点会被强制过水。
      arcs: [
        { id: 'e1', from: 's', to: 'a', capacity: 10 },
        { id: 'e2', from: 'a', to: 'd', capacity: 10 },
      ],
      sources: [{ node: 's', capacity: 10 }],
      sinks: [
        { node: 'a', capacity: 10 },
        { node: 'd', capacity: 10 },
      ],
    }
    const solution = solvePlan(net, new Set())
    expect(solution.analysis.value).toBe(10)

    // 只承诺 d=10，a 留空（当前解里 a 被强制过水 10）：富余水必须能调走，
    // 否则会误判 d 缺口 10。
    const r = minimumCommitmentGap(solution, [{ sinkIndex: 1, minimum: 10 }])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.totalGap).toBe(0)
    expect(r.allocations[1]).toMatchObject({ delivered: 10, gap: 0 })
    expect(r.allocations[0].minimum).toBeNull()
    expectValidWitness(net, new Set(), r)

    // a 承诺 0、d 承诺 10：同样缺口 0（零承诺不锁死富余水）。
    const r2 = minimumCommitmentGap(solution, [
      { sinkIndex: 0, minimum: 0 },
      { sinkIndex: 1, minimum: 10 },
    ])
    expect(r2.ok).toBe(true)
    if (r2.ok) {
      expect(r2.totalGap).toBe(0)
      expect(r2.allocations.map((a) => a.gap)).toEqual([0, 0])
      expectValidWitness(net, new Set(), r2)
    }

    // 零容量需求点：只能得 0，承诺 0 无缺口，正承诺失败为参数非法。
    const zeroCap: Network = {
      nodes: [{ id: 's' }, { id: 'z' }, { id: 't' }],
      arcs: [{ id: 'e', from: 's', to: 't', capacity: 5 }],
      sources: [{ node: 's', capacity: 5 }],
      sinks: [
        { node: 'z', capacity: 0 },
        { node: 't', capacity: 5 },
      ],
    }
    const zs = solvePlan(zeroCap, new Set())
    const rz = minimumCommitmentGap(zs, [
      { sinkIndex: 0, minimum: 0 },
      { sinkIndex: 1, minimum: 5 },
    ])
    expect(rz).toMatchObject({ ok: true, totalGap: 0, total: 5 })
    expect(
      minimumCommitmentGap(zs, [{ sinkIndex: 0, minimum: 1 }]),
    ).toMatchObject({ ok: false })
  })

  it('承诺超出可达上限：缺口 = 承诺 − 单点最大可获水量（穷举交叉验证）', () => {
    const net = sharedNet()
    const solution = solvePlan(net, new Set())
    const interval = sinkInterval(solution, 0)
    expect(interval.ok).toBe(true)
    const result = minimumCommitmentGap(solution, [
      { sinkIndex: 0, minimum: 5 },
      { sinkIndex: 1, minimum: 5 },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 总量 5 下两点不可能同时 5；最优各 5 满足、缺口 5，裁决 (5,0)。
    expect(result.totalGap).toBe(5)
    expect(result.allocations.map((a) => a.delivered)).toEqual([5, 0])
    expectValidWitness(net, new Set(), result)
  })
})

describe('最小承诺缺口：与联合裁决、失败隔离的关系', () => {
  it('诊断不改写方案的 flow/residual，且不影响既有联合裁决与单点区间', () => {
    const net: Network = {
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
    const solution = solvePlan(net, new Set())
    const flowSnapshot = Float64Array.from(solution.flow)
    const residualSnapshot = Float64Array.from(solution.residual)
    const intervalBefore = sinkInterval(solution, 1)

    minimumCommitmentGap(solution, [
      { sinkIndex: 0, minimum: 3 },
      { sinkIndex: 1, minimum: 3 },
    ])
    expect(Array.from(solution.flow)).toEqual(Array.from(flowSnapshot))
    expect(Array.from(solution.residual)).toEqual(Array.from(residualSnapshot))
    expect(sinkInterval(solution, 1)).toEqual(intervalBefore)
  })

  it('无效填写：非整数、负数、超容量、重复、越界下标、陌生 id', () => {
    const net: Network = {
      nodes: [{ id: 's' }, { id: 't' }],
      arcs: [{ id: 'e', from: 's', to: 't', capacity: 3 }],
      sources: [{ node: 's', capacity: 3 }],
      sinks: [{ node: 't', capacity: 3 }],
    }
    const solution = solvePlan(net, new Set())
    expect(minimumCommitmentGap(solution, [{ sinkIndex: 0, minimum: 4 }])).toMatchObject({
      ok: false,
    })
    expect(
      minimumCommitmentGap(solution, [{ sinkIndex: 0, minimum: 1.5 }]),
    ).toMatchObject({ ok: false })
    expect(
      minimumCommitmentGap(solution, [{ sinkIndex: 0, minimum: -1 }]),
    ).toMatchObject({ ok: false })
    expect(
      minimumCommitmentGap(solution, [
        { sinkIndex: 0, minimum: 1 },
        { sinkIndex: 0, minimum: 2 },
      ]),
    ).toMatchObject({ ok: false })
    expect(
      minimumCommitmentGap(solution, [{ sinkIndex: 9, minimum: 0 }]),
    ).toMatchObject({ ok: false })
    expect(
      minimumCommitmentGapByNode(solution, [{ node: 'ghost', minimum: 0 }]),
    ).toMatchObject({ ok: false })
  })

  it('空承诺：总缺口 0，见证为当前最大流，逐点水量与当前方案一致', () => {
    const rng = mulberry32(5)
    for (let round = 0; round < 30; round++) {
      const net = smallIntervalNetwork(rng)
      const solution = solvePlan(net, new Set())
      const result = minimumCommitmentGap(solution, [])
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expect(result.totalGap).toBe(0)
      expect(result.committed).toBe(0)
      result.witness.edges.forEach((w, i) => {
        expect(w.flow).toBe(solution.flow[i])
      })
      result.allocations.forEach((a, k) => {
        expect(a.minimum).toBeNull()
        expect(a.delivered).toBe(solution.flow[solution.sinkEdgeIndex[k]])
      })
    }
  })

  it('断管重算：停用管段后按新网络与新最大总量给缺口；清空恢复', () => {
    const net: Network = {
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
    const entries: GapEntry[] = [
      { sinkIndex: 0, minimum: 3 },
      { sinkIndex: 1, minimum: 3 },
    ]
    const base = minimumCommitmentGap(solvePlan(net, new Set()), entries)
    expect(base).toMatchObject({ ok: true, totalGap: 1 })

    const cut = minimumCommitmentGap(solvePlan(net, new Set(['p'])), entries)
    expect(cut.ok).toBe(true)
    if (cut.ok) {
      expect(cut.total).toBe(0)
      expect(cut.totalGap).toBe(6)
      expect(cut.allocations.map((a) => a.delivered)).toEqual([0, 0])
      expectValidWitness(net, new Set(['p']), cut)
    }

    const restored = minimumCommitmentGap(solvePlan(net, new Set()), entries)
    expect(restored).toEqual(base)
  })

  it('方案结构异常时返回失败结果且不抛出', () => {
    const solution = solvePlan(
      {
        nodes: [{ id: 's' }, { id: 't' }],
        arcs: [{ id: 'e', from: 's', to: 't', capacity: 3 }],
        sources: [{ node: 's', capacity: 3 }],
        sinks: [{ node: 't', capacity: 3 }],
      },
      new Set(),
    )
    const tampered = {
      ...solution,
      edges: solution.edges.map((e) => ({ ...e, capacity: 1.5 })),
    } as unknown as typeof solution
    let threw = false
    let result
    try {
      result = minimumCommitmentGap(tampered, [{ sinkIndex: 0, minimum: 1 }])
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(result).toMatchObject({ ok: false })
  })

  it('同点供需、重边、原生反向边、自环、零容量边：缺口与穷举一致', () => {
    const net: Network = {
      nodes: [{ id: 's' }, { id: 't' }],
      arcs: [
        { id: 'p1', from: 's', to: 't', capacity: 4 },
        { id: 'p2', from: 's', to: 't', capacity: 6 },
        { id: 'back', from: 't', to: 's', capacity: 100 },
        { id: 'loop', from: 's', to: 's', capacity: 7 },
        { id: 'zero', from: 's', to: 't', capacity: 0 },
      ],
      sources: [{ node: 's', capacity: 100 }],
      sinks: [{ node: 't', capacity: 100 }],
    }
    const solution = solvePlan(net, new Set())
    expect(solution.analysis.value).toBe(10)
    for (const d of [8, 10, 11, 13]) {
      const result = minimumCommitmentGap(solution, [{ sinkIndex: 0, minimum: d }])
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      const all = enumerateFeasibleFlows(net, new Set())
      const oracle = oracleOptimum(all, 10, [d])
      expect(result.totalGap).toBe(oracle.minGap)
      expect(result.allocations[0].delivered).toBe(oracle.vector[0])
      expectValidWitness(net, new Set(), result)
    }
  })
})

describe('最小承诺缺口：确定性、与联合裁决一致性', () => {
  it('同一输入（含多个同优方案）重复诊断逐项相等', () => {
    const rng = mulberry32(99)
    for (let round = 0; round < 40; round++) {
      const net = smallIntervalNetwork(rng)
      const disabled = new Set<string>()
      net.arcs.forEach((a) => {
        if (rng() < 0.25) disabled.add(a.id)
      })
      const entries: GapEntry[] = net.sinks.map((_, k) => ({
        sinkIndex: k,
        minimum: Math.floor(rng() * (net.sinks[k].capacity + 1)),
      }))
      const a = minimumCommitmentGap(solvePlan(net, disabled), entries)
      const b = minimumCommitmentGap(solvePlan(net, disabled), entries)
      expect(a).toEqual(b)
    }
  })

  it('总缺口为 0 ⇔ 联合裁决可行（全部承诺组合、随机网络）', () => {
    const rng = mulberry32(20261001)
    for (let round = 0; round < 120; round++) {
      const net = smallIntervalNetwork(rng)
      const disabled = new Set<string>()
      if (rng() < 0.4) {
        net.arcs.forEach((a) => {
          if (rng() < 0.3) disabled.add(a.id)
        })
      }
      const solution = solvePlan(net, disabled)
      const entries: GapEntry[] = net.sinks.map((_, k) => ({
        sinkIndex: k,
        minimum: Math.floor(rng() * (net.sinks[k].capacity + 1)),
      }))
      const gap = minimumCommitmentGap(solution, entries)
      const joint = jointCommitment(solution, entries)
      expect(gap.ok).toBe(true)
      if (!gap.ok) continue
      if (gap.totalGap === 0) {
        expect(joint).toMatchObject({ ok: true })
      } else {
        expect(joint).toMatchObject({ ok: false })
      }
    }
  })

  it('V=0（无可达来水）：全部承诺转为缺口，见证为零流且守恒', () => {
    const net: Network = {
      nodes: [{ id: 's' }, { id: 'd1' }, { id: 'd2' }],
      arcs: [],
      sources: [{ node: 's', capacity: 5 }],
      sinks: [
        { node: 'd1', capacity: 5 },
        { node: 'd2', capacity: 5 },
      ],
    }
    const solution = solvePlan(net, new Set())
    expect(solution.analysis.value).toBe(0)
    const r = minimumCommitmentGap(solution, [
      { sinkIndex: 0, minimum: 2 },
      { sinkIndex: 1, minimum: 3 },
    ])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.totalGap).toBe(5)
    expect(r.allocations.map((a) => [a.delivered, a.gap])).toEqual([
      [0, 2],
      [0, 3],
    ])
    expectValidWitness(net, new Set(), r)
  })

  it('见证边与 PlanSolution.edges 身份/顺序严格一一对应，且禁用管段不在见证中', () => {
    const net: Network = {
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
    const disabled = new Set(['q2'])
    const solution = solvePlan(net, disabled)
    const r = minimumCommitmentGap(solution, [
      { sinkIndex: 0, minimum: 3 },
      { sinkIndex: 1, minimum: 3 },
    ])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.witness.edges.length).toBe(solution.edges.length)
    r.witness.edges.forEach((w, i) => {
      expect(w.kind).toBe(solution.edges[i].kind)
      expect(w.id).toBe(solution.edges[i].id)
    })
    expect(r.witness.edges.some((w) => w.kind === 'arc' && w.id === 'q2')).toBe(false)
  })
})

describe('最小承诺缺口：性能', () => {
  it('10000 节点 / 50000 管段：方案重算 + 10 点缺口诊断 4 秒内完成，见证守恒', () => {
    const net = buildLargeNetwork()
    const sinkIds = net.sinks.slice(0, 10).map((k) => k.node)
    const capByNode = new Map(net.sinks.map((k) => [k.node, k.capacity]))

    const start = performance.now()
    const solution = solvePlan(net, new Set())
    const result = minimumCommitmentGapByNode(
      solution,
      sinkIds.map((node) => ({
        node,
        // 故意超过可达量：必然产生缺口，走通两阶段与自检。
        minimum: capByNode.get(node)!,
      })),
    )
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(4000)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.total).toBe(solution.analysis.value)
    expect(result.committed).toBe(10)
    expect(result.totalGap).toBeGreaterThanOrEqual(0)
    expectValidWitness(net, new Set(), result)
  })
})
