import { describe, expect, it } from 'vitest'
import { solvePlan } from '../src/core/analyze'
import { sinkInterval, sinkIntervalByNode } from '../src/core/interval'
import { Network } from '../src/core/types'
import {
  buildLargeNetwork,
  enumerateFeasibleFlows,
  mulberry32,
  smallIntervalNetwork,
} from './helpers'

/**
 * 独立复核用 Dinic：输入为普通 (capacity,0) 边列表（每条残量一条独立输入
 * 边，与生产 maxFlow 完全一致），返回每条输入边的净推流（反向弧残量）。
 * 阻塞流直接移植生产实现，避免递归 DFS 在部分推送时漏推。
 */
interface DEdge {
  from: number
  to: number
  capacity: number
  /** 反向弧初始容量（默认 0）。用于放置「汇→源」方向的闭合弧。 */
  reverseCapacity?: number
}

function plainDinic(
  nodeCount: number,
  edges: DEdge[],
  source: number,
  sink: number,
  /** 最多推送的流量上限（默认不限）。 */
  flowLimit = Infinity,
): { netFlow: Float64Array; value: number } {
  const m = edges.length
  const head = new Int32Array(nodeCount).fill(-1)
  const to = new Int32Array(2 * m)
  const nxt = new Int32Array(2 * m)
  const cap = new Float64Array(2 * m)
  edges.forEach((e, i) => {
    const a = 2 * i
    to[a] = e.to
    nxt[a] = head[e.from]
    head[e.from] = a
    cap[a] = e.capacity
    to[a + 1] = e.from
    nxt[a + 1] = head[e.to]
    head[e.to] = a + 1
    cap[a + 1] = e.reverseCapacity ?? 0
  })
  const level = new Int32Array(nodeCount)
  const queue = new Int32Array(nodeCount)
  const iter = new Int32Array(nodeCount)
  const pathEdge = new Int32Array(nodeCount)
  const pathNode = new Int32Array(nodeCount)
  const bfs = () => {
    level.fill(-1)
    let qh = 0
    let qt = 0
    level[source] = 0
    queue[qt++] = source
    while (qh < qt) {
      const u = queue[qh++]
      for (let a = head[u]; a !== -1; a = nxt[a]) {
        if (cap[a] > 0 && level[to[a]] === -1) {
          level[to[a]] = level[u] + 1
          queue[qt++] = to[a]
        }
      }
    }
    return level[sink] !== -1
  }
  const blockingFlow = () => {
    iter.set(head)
    let pushed = 0
    let depth = 0
    pathNode[0] = source
    for (;;) {
      const u = pathNode[depth]
      if (u === sink) {
        let f = Infinity
        for (let i = 0; i < depth; i++) {
          const c = cap[pathEdge[i]]
          if (c < f) f = c
        }
        // 限定总推流不超过 flowLimit。
        if (pushed + f > flowLimit) f = flowLimit - pushed
        for (let i = 0; i < depth; i++) {
          cap[pathEdge[i]] -= f
          cap[pathEdge[i] ^ 1] += f
        }
        pushed += f
        if (pushed >= flowLimit) return pushed
        // 未饱和路径上的弧（因限额而提前结束）时，回退到首个饱和弧。
        let d = 0
        for (let i = 0; i < depth; i++) {
          if (cap[pathEdge[i]] === 0) {
            d = i
            break
          }
        }
        depth = d
        continue
      }
      let a = iter[u]
      while (a !== -1 && !(cap[a] > 0 && level[to[a]] === level[u] + 1)) {
        a = nxt[a]
      }
      iter[u] = a
      if (a === -1) {
        level[u] = -1
        if (depth === 0) return pushed
        depth--
      } else {
        pathEdge[depth] = a
        depth++
        pathNode[depth] = to[a]
      }
    }
  }
  let value = 0
  while (value < flowLimit && bfs()) value += blockingFlow()
  const netFlow = new Float64Array(m)
  edges.forEach((_e, i) => {
    netFlow[i] = cap[2 * i + 1]
  })
  return { netFlow, value }
}

/**
 * 独立构造端点流（不调用被测 interval 内部）：
 * 排除目标需求边自身的正反残量弧，在其余残量网络上加一条「闭合弧」承担
 * 环流闭环（闭合弧初始 (cap, 0)，其流量即目标边流量变化量）：
 *   增流：源 T、汇 v，辅助路 T…→v，闭合弧 v→T（=目标边反残量方向），
 *         容量=目标边正残量 headroom；目标边流量 +closureFlow。
 *   减流：源 v、汇 T，辅助路 v…→T，闭合弧 T→v（=目标边正残量方向），
 *         容量=目标边当前流量；目标边流量 -closureFlow。
 */
function assertCirculationEndpoint(
  net: Network,
  targetSinkIndex: number,
  want: 'min' | 'max',
): void {
  const solution = solvePlan(net, new Set())
  const targetFlowIndex = solution.sinkEdgeIndex[targetSinkIndex]
  const claimed = sinkInterval(solution, targetSinkIndex)
  expect(claimed.ok).toBe(true)
  if (!claimed.ok) return
  const need =
    want === 'max' ? claimed.max - claimed.current : claimed.current - claimed.min

  // need=0：所声称端点就是当前解（已是可行流），无需构造环流。
  if (need === 0) {
    expect(want === 'max' ? claimed.max : claimed.min).toBe(claimed.current)
    return
  }

  const T = solution.superSink
  const v = solution.edges[targetFlowIndex].from
  // 与生产同构的残量边：正残量 from→to（推流使原边增流，sign+1），
  // 反残量 to→from（推流使原边减流，sign-1）。
  const edges: DEdge[] = []
  const meta: { edge: number; sign: 1 | -1 }[] = []
  solution.edges.forEach((e, i) => {
    if (i === targetFlowIndex) return // 排除目标需求边自身的正反残量弧
    if (solution.residual[i] > 0) {
      edges.push({ from: e.from, to: e.to, capacity: solution.residual[i] })
      meta.push({ edge: i, sign: 1 })
    }
    if (solution.flow[i] > 0) {
      edges.push({ from: e.to, to: e.from, capacity: solution.flow[i] })
      meta.push({ edge: i, sign: -1 })
    }
  })
  // 闭合弧与生产源汇相反，故作为「正向零容量、反向弧预置容量」的边加入，
  // 预置容量取目标边自身闭合残量（增流=headroom，减流=current）：
  //   增流：生产源 T 汇 v，闭合 v→T；放 T→v 零容量边，反向弧 v→T 预置 headroom。
  //   减流：生产源 v 汇 T，闭合 T→v；放 v→T 零容量边，反向弧 T→v 预置 current。
  const closureCap =
    want === 'max'
      ? solution.residual[targetFlowIndex]
      : solution.flow[targetFlowIndex]
  const closureIndex = edges.length
  if (want === 'max') {
    edges.push({ from: T, to: v, capacity: 0, reverseCapacity: closureCap })
  } else {
    edges.push({ from: v, to: T, capacity: 0, reverseCapacity: closureCap })
  }

  // 与生产一致：增流求 T→v；减流求 v→T。只取 need 个单位的流来精确构造端点。
  const source = want === 'max' ? T : v
  const sink = want === 'max' ? v : T
  const { netFlow, value: pushed } = plainDinic(
    solution.nodeCount,
    edges,
    source,
    sink,
    need,
  )

  // 完整可调流（生产区间结果）≥ need，故限额 need 下恰推 need。
  expect(pushed).toBe(need)
  const closureFlow = pushed

  const next = Float64Array.from(solution.flow)
  netFlow.forEach((g, ai) => {
    if (ai === closureIndex || g === 0) return
    next[meta[ai].edge] += g * meta[ai].sign
  })
  // 目标边：增流 +g（闭合走目标边反向残量）；减流 -g（闭合走正向残量）。
  next[targetFlowIndex] += want === 'max' ? closureFlow : -closureFlow

  // 容量约束。
  solution.edges.forEach((e, i) => {
    expect(next[i]).toBeGreaterThanOrEqual(0)
    expect(next[i]).toBeLessThanOrEqual(e.capacity)
  })
  // 节点守恒与总值不变。
  const bal = new Float64Array(solution.nodeCount)
  solution.edges.forEach((e, i) => {
    bal[e.from] -= next[i]
    bal[e.to] += next[i]
  })
  const isZero = (x: number) => Object.is(x, 0) || Object.is(x, -0)
  for (let u = 0; u < solution.nodeCount - 2; u++) {
    expect(isZero(bal[u])).toBe(true)
  }
  expect(-bal[solution.superSource] + 0).toBe(solution.analysis.value)
  expect(bal[solution.superSink] + 0).toBe(solution.analysis.value)

  // 构造出的目标边流量恰为所声称的端点。
  expect(next[targetFlowIndex]).toBe(want === 'max' ? claimed.max : claimed.min)
}

describe('避难点供水区间：穷举全部可行流交叉验证', () => {
  it('小整数网络（含重边/反向边/自环/零容量/供需同点/随机断管）逐需求点核对上下界与端点可实现性', () => {
    const rng = mulberry32(20260919)
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

      // 最大流层按输入边身份给出正反残量：flow + residual = capacity。
      solution.edges.forEach((e, i) => {
        expect(solution.flow[i]).toBeGreaterThanOrEqual(0)
        expect(solution.flow[i]).toBeLessThanOrEqual(e.capacity)
        expect(solution.flow[i] + solution.residual[i]).toBe(e.capacity)
      })

      const all = enumerateFeasibleFlows(net, disabled)
      // Dinic 当前解必为可行点，故至少有一个总值 V 的可行分配。
      const maxFlows = all.filter((p) => p.total === V)
      expect(maxFlows.length).toBeGreaterThan(0)
      expect(V).toBe(Math.max(...all.map((p) => p.total)))

      const sinkCount = net.sinks.length
      const currentY = net.sinks.map(
        (_, k) => solution.flow[solution.sinkEdgeIndex[k]],
      )

      // 当前完整分配向量必须出现在总值 V 的可行点集合中。
      const currentKey = JSON.stringify(currentY)
      const maxKeys = new Set(maxFlows.map((p) => JSON.stringify(p.sinkY)))
      expect(maxKeys.has(currentKey)).toBe(true)

      for (let k = 0; k < sinkCount; k++) {
        const result = sinkInterval(solution, k)
        expect(result.ok).toBe(true)
        if (!result.ok) continue
        expect(result.total).toBe(V)
        expect(result.sinkNode).toBe(net.sinks[k].node)
        expect(result.current).toBe(currentY[k])

        const ys = maxFlows.map((p) => p.sinkY[k])
        const lo = Math.min(...ys)
        const hi = Math.max(...ys)

        // 上下界与穷举严格一致，且端点可实现。
        expect(result.min).toBe(lo)
        expect(result.max).toBe(hi)
        expect(ys).toContain(result.min)
        expect(ys).toContain(result.max)

        // 每个总值 V 的可行分配都落在区间内；当前分配亦然。
        ys.forEach((y) => {
          expect(y).toBeGreaterThanOrEqual(result.min)
          expect(y).toBeLessThanOrEqual(result.max)
        })
        expect(result.min).toBeLessThanOrEqual(result.current)
        expect(result.current).toBeLessThanOrEqual(result.max)
        // 不突破需求边容量。
        expect(result.min).toBeGreaterThanOrEqual(0)
        expect(result.max).toBeLessThanOrEqual(net.sinks[k].capacity)
      }
    }
  })

  it('锁定场景：共享瓶颈容量 5、下游两个需求点容量各 5 → 二者区间均为 0..5 且当前分配落内', () => {
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
    expect(solution.analysis.value).toBe(5)

    const all = enumerateFeasibleFlows(net, new Set())
    const maxFlows = all.filter((p) => p.total === 5)
    // 穷举层面：两需求点可获水量各自恰好覆盖 0..5，且互补和为 5。
    for (let k = 0; k < 2; k++) {
      const ys = maxFlows.map((p) => p.sinkY[k]).sort((a, b) => a - b)
      expect(ys).toEqual([0, 1, 2, 3, 4, 5])
    }
    maxFlows.forEach((p) => {
      expect(p.sinkY[0] + p.sinkY[1]).toBe(5)
    })

    for (let k = 0; k < 2; k++) {
      const result = sinkInterval(solution, k)
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expect(result.min).toBe(0)
      expect(result.max).toBe(5)
      expect(result.current).toBeGreaterThanOrEqual(0)
      expect(result.current).toBeLessThanOrEqual(5)
    }
    // 两个需求点的当前分配之和恰为总值 5（一组可行分配）。
    const c0 = sinkInterval(solution, 0)
    const c1 = sinkInterval(solution, 1)
    if (c0.ok && c1.ok) expect(c0.current + c1.current).toBe(5)
  })
})

describe('避难点供水区间：环流端点独立构造与不变量', () => {
  it('端点流由辅助环流构造后满足容量、守恒且总值不变', () => {
    const rng = mulberry32(77)
    for (let round = 0; round < 60; round++) {
      const net = smallIntervalNetwork(rng)
      for (let k = 0; k < net.sinks.length; k++) {
        assertCirculationEndpoint(net, k, 'min')
        assertCirculationEndpoint(net, k, 'max')
      }
    }
  })

  it('锁定 5-5 共享瓶颈：两个端点环流构造得到 0 与 5', () => {
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
    assertCirculationEndpoint(net, 0, 'min')
    assertCirculationEndpoint(net, 0, 'max')
    assertCirculationEndpoint(net, 1, 'min')
    assertCirculationEndpoint(net, 1, 'max')
  })
})

describe('避难点供水区间：结构与边界', () => {
  it('需求边强制：唯一通路饱和时该点区间退化为单点', () => {
    const net: Network = {
      nodes: [{ id: 's' }, { id: 't' }],
      arcs: [{ id: 'e', from: 's', to: 't', capacity: 3 }],
      sources: [{ node: 's', capacity: 10 }],
      sinks: [{ node: 't', capacity: 10 }],
    }
    const solution = solvePlan(net, new Set())
    const r = sinkInterval(solution, 0)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r).toMatchObject({ min: 3, current: 3, max: 3, total: 3 })
    }
  })

  it('零容量需求点：区间恒为 0', () => {
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
    const ra = sinkInterval(solution, 0)
    const rt = sinkInterval(solution, 1)
    expect(ra.ok && rt.ok).toBe(true)
    if (ra.ok) expect(ra).toMatchObject({ min: 0, current: 0, max: 0 })
    if (rt.ok) expect(rt).toMatchObject({ min: 5, current: 5, max: 5 })
  })

  it('同一节点兼作供水点与需求点：两条边界边独立核算', () => {
    const net: Network = {
      nodes: [{ id: 'x' }, { id: 't' }],
      arcs: [{ id: 'e', from: 'x', to: 't', capacity: 10 }],
      sources: [{ node: 'x', capacity: 6 }],
      sinks: [
        { node: 'x', capacity: 2 },
        { node: 't', capacity: 10 },
      ],
    }
    const solution = solvePlan(net, new Set())
    expect(solution.analysis.value).toBe(6)
    // x 处可就地消化 0..2，其余送往 t（4..6），总值恒为 6。
    const rx = sinkInterval(solution, 0)
    const rt = sinkInterval(solution, 1)
    if (rx.ok) expect(rx).toMatchObject({ min: 0, max: 2 })
    if (rt.ok) expect(rt).toMatchObject({ min: 4, max: 6 })
  })

  it('重边、原生反向边、自环按各输入边独立核算', () => {
    const net: Network = {
      nodes: [{ id: 's' }, { id: 't' }],
      arcs: [
        { id: 'p1', from: 's', to: 't', capacity: 4 },
        { id: 'p2', from: 's', to: 't', capacity: 6 },
        { id: 'back', from: 't', to: 's', capacity: 100 },
        { id: 'loop', from: 's', to: 's', capacity: 7 },
      ],
      sources: [{ node: 's', capacity: 100 }],
      sinks: [{ node: 't', capacity: 100 }],
    }
    const solution = solvePlan(net, new Set())
    expect(solution.analysis.value).toBe(10)
    const r = sinkInterval(solution, 0)
    if (r.ok) expect(r).toMatchObject({ min: 10, current: 10, max: 10 })
    // 自环流量任意但对需求点无贡献；其残量不破坏区间结论（穷举已覆盖）。
    const all = enumerateFeasibleFlows(net, new Set()).filter(
      (p) => p.total === 10,
    )
    expect(all.length).toBeGreaterThan(0)
    expect(Math.min(...all.map((p) => p.sinkY[0]))).toBe(10)
  })

  it('停用管段后区间按新断管集合重算；清空方案恢复基线区间（同结果）', () => {
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
    const base = solvePlan(net, new Set())
    const baseR = sinkInterval(base, 0)
    expect(baseR.ok).toBe(true)

    // 停用 q2：5 单位只能去 d1，区间退化为单点 5。
    const cut = solvePlan(net, new Set(['q2']))
    expect(cut.analysis.value).toBe(5)
    const cutR1 = sinkInterval(cut, 0)
    const cutR2 = sinkInterval(cut, 1)
    if (cutR1.ok) expect(cutR1).toMatchObject({ min: 5, max: 5 })
    if (cutR2.ok) expect(cutR2).toMatchObject({ min: 0, max: 0 })

    // 恢复（清空方案）：区间与基线逐项一致。
    const restored = solvePlan(net, new Set())
    const restoredR = sinkInterval(restored, 0)
    expect(restored.analysis).toEqual(base.analysis)
    expect(restoredR).toEqual(baseR)
  })

  it('结果确定：同输入重复求解区间逐项相等', () => {
    const rng = mulberry32(11)
    for (let i = 0; i < 20; i++) {
      const net = smallIntervalNetwork(rng)
      const a = sinkInterval(solvePlan(net, new Set()), 0)
      const b = sinkInterval(solvePlan(net, new Set()), 0)
      expect(a).toEqual(b)
    }
  })

  it('辅助求解失败：越界下标或不存在的需求点 id 返回失败且不抛出', () => {
    const net: Network = {
      nodes: [{ id: 's' }, { id: 't' }],
      arcs: [{ id: 'e', from: 's', to: 't', capacity: 1 }],
      sources: [{ node: 's', capacity: 1 }],
      sinks: [{ node: 't', capacity: 1 }],
    }
    const solution = solvePlan(net, new Set())
    expect(sinkInterval(solution, 5)).toMatchObject({ ok: false })
    expect(sinkInterval(solution, -1)).toMatchObject({ ok: false })
    expect(sinkIntervalByNode(solution, 'ghost')).toMatchObject({ ok: false })
  })
})

describe('避难点供水区间：性能', () => {
  it('10000 节点 / 50000 管段：单次区间查询（方案重算 + 两个辅助网络）四秒内完成', () => {
    const net = buildLargeNetwork()
    const sinkNode = net.sinks[0].node

    const start = performance.now()
    const solution = solvePlan(net, new Set())
    const result = sinkIntervalByNode(solution, sinkNode)
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(4000)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.total).toBe(solution.analysis.value)
      expect(result.min).toBeLessThanOrEqual(result.current)
      expect(result.current).toBeLessThanOrEqual(result.max)
      expect(Number.isSafeInteger(result.min)).toBe(true)
      expect(Number.isSafeInteger(result.max)).toBe(true)
    }
  })
})
