import { describe, expect, it } from 'vitest'
import { solvePlan } from '../src/core/analyze'
import {
  CommitmentEntry,
  jointCommitment,
  jointCommitmentByNode,
} from '../src/core/commitment'
import { sinkInterval } from '../src/core/interval'
import { PlanSolution } from '../src/core/analyze'
import { Network } from '../src/core/types'
import {
  buildLargeNetwork,
  enumerateFeasibleFlows,
  FeasiblePoint,
  mulberry32,
  smallIntervalNetwork,
} from './helpers'

/** 穷举预言机：固定总量 V 下是否存在可行点同时满足全部承诺下限。 */
function oracleFeasible(
  all: FeasiblePoint[],
  V: number,
  mins: (number | null)[],
): boolean {
  return all.some(
    (p) =>
      p.total === V &&
      mins.every((m, k) => m === null || p.sinkY[k] >= m),
  )
}

/** 共享瓶颈锁定网络：s→m 容量 5，m→d1 / m→d2 各容量 5。 */
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

describe('联合最低供水承诺：穷举全部可行流交叉验证', () => {
  it('小整数网络（含重边/反向边/自环/零容量/供需同点/随机断管）全部承诺组合与预言机一致', () => {
    const rng = mulberry32(20260920)
    const ROUNDS = 220
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
      // Dinic 当前解本身就是总量 V 的可行点。
      expect(all.some((p) => p.total === V)).toBe(true)

      const sinkCount = net.sinks.length

      // 枚举每个需求点承诺值的全部组合：null = 该点留空。
      const valueChoices = (k: number): (number | null)[] => {
        const cap = net.sinks[k].capacity
        const vals: (number | null)[] = [null]
        for (let v = 0; v <= cap; v++) vals.push(v)
        // 越界值由结构性用例覆盖，这里聚焦裁决正确性。
        return vals
      }
      const combos: (number | null)[][] = (() => {
        const out: (number | null)[][] = [[]]
        for (let k = 0; k < sinkCount; k++) {
          const choices = valueChoices(k)
          const next: (number | null)[][] = []
          for (const prefix of out) {
            for (const c of choices) next.push([...prefix, c])
          }
          out.length = 0
          out.push(...next)
        }
        return out
      })()

      for (const mins of combos) {
        const entries: CommitmentEntry[] = []
        mins.forEach((m, k) => {
          if (m !== null) entries.push({ sinkIndex: k, minimum: m })
        })
        const result = jointCommitment(solution, entries)
        const expected = oracleFeasible(all, V, mins)

        expect(result.ok).toBe(expected)
        if (result.ok) {
          // 固定总量严格等于当前 analysis.value。
          expect(result.total).toBe(V)
          expect(result.committed).toBe(entries.length)
          // 可行结果只给结论与固定总量，绝不输出逐边/逐点分配。
          expect(Object.keys(result).sort()).toEqual(
            ['committed', 'ok', 'total'].sort(),
          )
        } else {
          // 不可行是「联合约束不满足」而非参数错误。
          expect(result.reason).toBe('joint-lower-bounds-infeasible')
        }
      }

      // 全留空恒可行，且不依赖任何承诺。
      const empty = jointCommitment(solution, [])
      expect(empty).toMatchObject({ ok: true, total: V, committed: 0 })
    }
  })
})

describe('联合最低供水承诺：锁定共享瓶颈场景', () => {
  it('共享容量 5 时 d1、d2 各承诺 3：分别落在 0..5 单点区间内仍不可同时兑现', () => {
    const net = sharedBottleneckNetwork()
    const solution = solvePlan(net, new Set())
    expect(solution.analysis.value).toBe(5)

    // 单点区间均为 0..5：各自承诺 3 单独看都在区间内。
    const i0 = sinkInterval(solution, 0)
    const i1 = sinkInterval(solution, 1)
    expect(i0.ok && i1.ok).toBe(true)
    if (i0.ok && i1.ok) {
      expect(i0.min).toBe(0)
      expect(i0.max).toBe(5)
      expect(i1.min).toBe(0)
      expect(i1.max).toBe(5)
    }

    // 联合裁决：共享瓶颈容量 5，3+3=6 无法同时满足 → 否决。
    const joint = jointCommitment(solution, [
      { sinkIndex: 0, minimum: 3 },
      { sinkIndex: 1, minimum: 3 },
    ])
    expect(joint).toMatchObject({ ok: false, reason: 'joint-lower-bounds-infeasible' })

    // 穷举预言机：不存在总量 5 且两需求点都 ≥3 的可行流。
    const all = enumerateFeasibleFlows(net, new Set())
    expect(
      all.some((p) => p.total === 5 && p.sinkY[0] >= 3 && p.sinkY[1] >= 3),
    ).toBe(false)

    // 但 3+2=5 可同时兑现，裁决可行，仅返回结论与固定总量。
    const feasible = jointCommitment(solution, [
      { sinkIndex: 0, minimum: 3 },
      { sinkIndex: 1, minimum: 2 },
    ])
    expect(feasible).toMatchObject({ ok: true, total: 5, committed: 2 })
    // 可行结果不含任何逐边/逐点分配字段。
    expect(JSON.stringify(feasible)).not.toContain('flow')
    expect(JSON.stringify(feasible)).not.toContain('allocation')
  })

  it('加入独立向 d3 供水 5（总量 10）：承诺和 6 未超总量，局部瓶颈仍否决', () => {
    const net: Network = {
      nodes: [{ id: 's' }, { id: 'm' }, { id: 'd1' }, { id: 'd2' }, { id: 'd3' }],
      arcs: [
        { id: 'p', from: 's', to: 'm', capacity: 5 },
        { id: 'q1', from: 'm', to: 'd1', capacity: 5 },
        { id: 'q2', from: 'm', to: 'd2', capacity: 5 },
        // 独立支路：s → d3 容量 5，与共享瓶颈完全无关。
        { id: 'p3', from: 's', to: 'd3', capacity: 5 },
      ],
      sources: [{ node: 's', capacity: 100 }],
      sinks: [
        { node: 'd1', capacity: 5 },
        { node: 'd2', capacity: 5 },
        { node: 'd3', capacity: 5 },
      ],
    }
    const solution = solvePlan(net, new Set())
    expect(solution.analysis.value).toBe(10)

    // 预言机：d1+d2 在任何可行流中至多 5，故 (3,3) 即便有独立 d3 也不可能。
    const all = enumerateFeasibleFlows(net, new Set())
    const witness = all.filter(
      (p) => p.total === 10 && p.sinkY[0] >= 3 && p.sinkY[1] >= 3,
    )
    expect(witness.length).toBe(0)
    // 总量 10 的可行点确实存在（d3 独立供 5）。
    expect(all.some((p) => p.total === 10 && p.sinkY[2] === 5)).toBe(true)

    const joint = jointCommitmentByNode(solution, [
      { node: 'd1', minimum: 3 },
      { node: 'd2', minimum: 3 },
    ])
    // 承诺和 6 ≤ 固定总量 10，但共享 p 的局部瓶颈仍判不可行。
    expect(joint).toMatchObject({ ok: false, reason: 'joint-lower-bounds-infeasible' })

    // 只承诺其中一点（3）可行：不能把单点区间拼接成联合结论。
    const one = jointCommitmentByNode(solution, [{ node: 'd1', minimum: 3 }])
    expect(one).toMatchObject({ ok: true, total: 10, committed: 1 })

    // 承诺和仍为 6、把 d3 也算进来时：3+2（共享 5）+1（独立），联合可行。
    const rebalanced = jointCommitmentByNode(solution, [
      { node: 'd1', minimum: 3 },
      { node: 'd2', minimum: 2 },
      { node: 'd3', minimum: 1 },
    ])
    expect(rebalanced).toMatchObject({ ok: true, total: 10, committed: 3 })
  })
})

describe('联合最低供水承诺：断管重算、清空与恢复', () => {
  it('停用管段后按新断管集合与当前总量重裁决；清空方案恢复基线裁决', () => {
    const net = sharedBottleneckNetwork()

    const base = solvePlan(net, new Set())
    expect(base.analysis.value).toBe(5)
    const baseJoint = jointCommitment(base, [
      { sinkIndex: 0, minimum: 3 },
      { sinkIndex: 1, minimum: 2 },
    ])
    expect(baseJoint).toMatchObject({ ok: true, total: 5 })

    // 停用 q2：d2 无路可达，承诺 d2≥1 不可行；d1 独占 5，承诺 d1=5 可行。
    const cut = solvePlan(net, new Set(['q2']))
    expect(cut.analysis.value).toBe(5)
    expect(
      jointCommitment(cut, [
        { sinkIndex: 0, minimum: 3 },
        { sinkIndex: 1, minimum: 2 },
      ]),
    ).toMatchObject({ ok: false })
    expect(
      jointCommitment(cut, [{ sinkIndex: 0, minimum: 5 }]),
    ).toMatchObject({ ok: true, total: 5 })

    // 再停用 p：总量降为 0，任何正承诺都不可行。
    const dead = solvePlan(net, new Set(['q2', 'p']))
    expect(dead.analysis.value).toBe(0)
    expect(jointCommitment(dead, [{ sinkIndex: 0, minimum: 1 }])).toMatchObject({
      ok: false,
    })
    expect(jointCommitment(dead, [])).toMatchObject({
      ok: true,
      total: 0,
      committed: 0,
    })

    // 清空方案：分析逐项回到基线，联合裁决也恢复为基线结论。
    const restored = solvePlan(net, new Set())
    expect(restored.analysis).toEqual(base.analysis)
    const restoredJoint = jointCommitment(restored, [
      { sinkIndex: 0, minimum: 3 },
      { sinkIndex: 1, minimum: 2 },
    ])
    expect(restoredJoint).toEqual(baseJoint)
  })

  it('同一输入重复裁决逐项相等（确定）', () => {
    const rng = mulberry32(31)
    for (let round = 0; round < 20; round++) {
      const net = smallIntervalNetwork(rng)
      const solution = solvePlan(net, new Set())
      const entries: CommitmentEntry[] = net.sinks.map((_, k) => ({
        sinkIndex: k,
        minimum: Math.floor(rng() * (net.sinks[k].capacity + 1)),
      }))
      expect(jointCommitment(solution, entries)).toEqual(
        jointCommitment(solution, entries),
      )
    }
  })
})

describe('联合最低供水承诺：失败隔离（不抛出，只清除裁决并就地提示）', () => {
  function tinySolution(): PlanSolution {
    return solvePlan(
      {
        nodes: [{ id: 's' }, { id: 't' }],
        arcs: [{ id: 'e', from: 's', to: 't', capacity: 3 }],
        sources: [{ node: 's', capacity: 3 }],
        sinks: [{ node: 't', capacity: 3 }],
      },
      new Set(),
    )
  }

  it('无效填写：非整数、负数、超容量、重复、越界下标、陌生 id', () => {
    const solution = tinySolution()

    expect(jointCommitment(solution, [{ sinkIndex: 0, minimum: 4 }])).toMatchObject(
      { ok: false },
    )
    expect(
      jointCommitment(solution, [{ sinkIndex: 0, minimum: 1.5 }]),
    ).toMatchObject({ ok: false })
    expect(
      jointCommitment(solution, [{ sinkIndex: 0, minimum: -1 }]),
    ).toMatchObject({ ok: false })
    expect(
      jointCommitment(solution, [
        { sinkIndex: 0, minimum: 1 },
        { sinkIndex: 0, minimum: 1 },
      ]),
    ).toMatchObject({ ok: false })
    expect(jointCommitment(solution, [{ sinkIndex: 5, minimum: 0 }])).toMatchObject(
      { ok: false },
    )
    expect(
      jointCommitmentByNode(solution, [{ node: 'ghost', minimum: 0 }]),
    ).toMatchObject({ ok: false })

    // 合法边界 0 与容量值本身可行。
    expect(
      jointCommitment(solution, [{ sinkIndex: 0, minimum: 0 }]),
    ).toMatchObject({ ok: true })
    expect(
      jointCommitment(solution, [{ sinkIndex: 0, minimum: 3 }]),
    ).toMatchObject({ ok: true })
  })

  it('方案结构异常：辅助求解失败结果不抛出', () => {
    const solution = tinySolution()
    const tampered = {
      ...solution,
      edges: solution.edges.map((e) => ({ ...e, capacity: 1.5 })),
    } as unknown as PlanSolution
    let threw = false
    let result
    try {
      result = jointCommitment(tampered, [{ sinkIndex: 0, minimum: 0 }])
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(result).toMatchObject({ ok: false })
  })

  it('失败后基线、当前演练与既有单点区间保持可用', () => {
    const net = sharedBottleneckNetwork()
    const solution = solvePlan(net, new Set())

    // 先取到单点区间。
    const before = sinkInterval(solution, 0)
    expect(before.ok).toBe(true)

    // 联合裁决失败（超容量填写与联合不可行各一）。
    expect(
      jointCommitment(solution, [{ sinkIndex: 0, minimum: 9 }]),
    ).toMatchObject({ ok: false })
    expect(
      jointCommitment(solution, [
        { sinkIndex: 0, minimum: 3 },
        { sinkIndex: 1, minimum: 3 },
      ]),
    ).toMatchObject({ ok: false })

    // 基线/演练分析、停用集合与单点区间引用与结果不受影响。
    const again = solvePlan(net, new Set())
    expect(again.analysis).toEqual(solution.analysis)
    expect(sinkInterval(again, 0)).toEqual(before)
    // 改为合法填写后裁决立即恢复。
    expect(
      jointCommitment(solution, [{ sinkIndex: 0, minimum: 2 }]),
    ).toMatchObject({ ok: true, total: 5 })
  })
})

describe('联合最低供水承诺：特殊结构', () => {
  it('零容量需求点：只能承诺 0', () => {
    const net: Network = {
      nodes: [{ id: 's' }, { id: 'a' }, { id: 't' }],
      arcs: [{ id: 'e', from: 's', to: 't', capacity: 5 }],
      sources: [{ node: 's', capacity: 5 }],
      sinks: [
        { node: 'a', capacity: 0 },
        { node: 't', capacity: 5 },
      ],
    }
    const solution = solvePlan(net, new Set())
    expect(
      jointCommitment(solution, [{ sinkIndex: 0, minimum: 1 }]),
    ).toMatchObject({ ok: false })
    expect(
      jointCommitment(solution, [
        { sinkIndex: 0, minimum: 0 },
        { sinkIndex: 1, minimum: 5 },
      ]),
    ).toMatchObject({ ok: true, total: 5, committed: 2 })
  })

  it('同点供需、重边、原生反向边、自环、零容量边按 PlanEdge 身份联合裁决', () => {
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
    expect(
      jointCommitment(solution, [{ sinkIndex: 0, minimum: 10 }]),
    ).toMatchObject({ ok: true, total: 10 })
    expect(
      jointCommitment(solution, [{ sinkIndex: 0, minimum: 11 }]),
    ).toMatchObject({ ok: false, reason: 'joint-lower-bounds-infeasible' })

    // 与穷举预言机一致。
    const all = enumerateFeasibleFlows(net, new Set())
    expect(all.some((p) => p.total === 10 && p.sinkY[0] >= 10)).toBe(true)
    expect(all.some((p) => p.total === 10 && p.sinkY[0] >= 11)).toBe(false)
  })

  it('承诺总和超过固定总量必然否决（总量锁定，不许降量兑现）', () => {
    const net: Network = {
      nodes: [{ id: 's' }, { id: 'm' }, { id: 'd1' }, { id: 'd2' }],
      arcs: [
        { id: 'p1', from: 's', to: 'm', capacity: 100 },
        { id: 'q1', from: 'm', to: 'd1', capacity: 100 },
        { id: 'q2', from: 'm', to: 'd2', capacity: 100 },
      ],
      sources: [{ node: 's', capacity: 4 }],
      sinks: [
        { node: 'd1', capacity: 100 },
        { node: 'd2', capacity: 100 },
      ],
    }
    const solution = solvePlan(net, new Set())
    expect(solution.analysis.value).toBe(4)
    expect(
      jointCommitment(solution, [
        { sinkIndex: 0, minimum: 3 },
        { sinkIndex: 1, minimum: 3 },
      ]),
    ).toMatchObject({ ok: false })
    // 两点各取 2，和恰为固定总量 4：可行。
    expect(
      jointCommitment(solution, [
        { sinkIndex: 0, minimum: 2 },
        { sinkIndex: 1, minimum: 2 },
      ]),
    ).toMatchObject({ ok: true, total: 4, committed: 2 })
  })
})

describe('联合最低供水承诺：性能', () => {
  it('10000 节点 / 50000 管段：一次联合校验（方案重算 + 下界环流辅助求解）四秒内完成', () => {
    const net = buildLargeNetwork()
    const sinkIds = net.sinks.slice(0, 10).map((k) => k.node)
    const capByNode = new Map(net.sinks.map((k) => [k.node, k.capacity]))

    const start = performance.now()
    const solution = solvePlan(net, new Set())
    const result = jointCommitmentByNode(
      solution,
      sinkIds.map((node) => ({
        node,
        minimum: Math.floor(capByNode.get(node)! / 2),
      })),
    )
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(4000)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.total).toBe(solution.analysis.value)
      expect(result.committed).toBe(sinkIds.length)
    }
  })
})
