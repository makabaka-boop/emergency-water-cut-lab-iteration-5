import { PlanEdgeKind, PlanSolution } from './analyze'
import { findSinkIndex } from './interval'

/**
 * 最小承诺缺口诊断（opt-in，与联合承诺裁决相互独立）。
 *
 * 在「总送水量仍严格等于当前网络可达最大值 V（= analysis.value）」的全部最大流
 * 方案中，选出各安置点（需求点）未达承诺量之和最小的一组，并返回：
 *  - 总缺口（全部被承诺点的未达量之和）；
 *  - 逐点实际供水量与缺口（未承诺点只给实际供水量，缺口记 0）；
 *  - 一组满足全部管段/供水/需求边容量与节点守恒的完整流量见证。
 *
 * 绝不能把各点单独可达上限拼成一份联合方案：本诊断的每一次改道都是当前最大流
 * 残量网络中的环流，故见证始终是「同一组边流量」上的可行最大流。
 *
 * 本模块从 solvePlan 已给的那组最大流出发做残量环流改道，不修改、也不依赖联合
 * 裁决结论；诊断失败或输入变化时只返回失败结果，不污染最大流、承诺可行性结论
 * 与停用管段状态。
 *
 * 算法（残量环流两阶段 + 字典序裁决）：
 *  设当前 Dinic 最大流为 f（总量 V）。任意同值最大流与 f 之差是残量网络中的
 *  环流（与 interval.ts 同一原理）。
 *
 *  阶段 B（最大化被承诺点的满足总量 ⇔ 最小化总缺口）：
 *    总量恒为 V，把 1 单位「不损害任何承诺满足量」的来水改道给缺水的被承诺点，
 *    即增加 1 单位满足量。冻结全部被承诺需求边自身的残量弧，代之以两条人造弧：
 *      - 补给水弧 v_k → G（门节点），容量 max(0, d_k − f_k)：k 尚能补上的单位；
 *      - 富余水弧 T → v_k，容量 max(0, f_k − d_k)：k 已超过承诺、可被无偿
 *        调走的单位（冻结整边会把这部分富余水也锁死，例如承诺 0 却强制过水）。
 *    其余未承诺需求边的反残量弧（T → v_j）天然开放。求 T → G 的最大流：
 *    每个单位要么从某个未承诺点、要么从某点的承诺富余中调出，经 v_k → G 补给
 *    安置点 k，门节点收到的总量恰为满足总量的最大增量（从已满足承诺点调水必须
 *    走富余弧，容量上限保证其水量不会跌破承诺，故不存在「先损后补」的虚假增量）。
 *
 *  阶段 C（相同最优值下满足量的稳定裁决）：
 *    按 network.sinks 的需求点顺序（承诺条目按 sinkIndex 升序）逐点处理：永久
 *    冻结此前已优化的被承诺需求边（其水量此后不得变动），临时排除该点自身的
 *    正反残量弧，求 T → v_k 的限额环流，限额 max(0, d_k − 当前水量)——在不
 *    损害更早安置点满足量的前提下把该点补到承诺值，处理完即永久冻结该点。
 *    于是逐点满足量 (s_0, s_1, …) 被字典序最大化。
 *
 *  阶段 D（富余水的稳定裁决）：
 *    缺口与满足量已定，剩下无法避免的富余来水按同样顺序继续优先分给更早的承诺
 *    点（直至其需求边容量）。捐赠者只准动用承诺之外的富余：为每个更晚承诺点
 *    加捐赠弧 T → v_j（容量 = 当前水量 − d_j，经过即只捐富余、不跌破承诺），
 *    未承诺点经真实反残量弧可一直捐到 0；已处理点的真实边与捐赠弧永久冻结。
 *    于是逐点「实际供水量」向量也唯一确定（承诺点实际水量的字典序最大化），
 *    全部边序固定，见证逐项可复现。
 *
 *  未承诺点（留空）在两阶段中均可自由增减，其最终水量只作为见证的一部分返回；
 *  零承诺点（d=0）无可补单位、天然缺口 0；不可达需求点没有 T→v 的残量路，
 *  闭合边推不上流，缺口原样保留为 d。
 */

export interface GapEntry {
  /** 需求点在 network.sinks 中的下标。 */
  sinkIndex: number
  /** 最低供水量：0..该需求点容量 的整数。 */
  minimum: number
}

/** 单个需求点的诊断结论（未承诺点 minimum 为 null、gap 恒为 0）。 */
export interface SinkGap {
  sinkNode: string
  /** 最低承诺量；未填写（留空）为 null。 */
  minimum: number | null
  /** 见证方案中该点的实际供水量。 */
  delivered: number
  /** 未达承诺量 = max(0, minimum − delivered)；未承诺点为 0。 */
  gap: number
}

/** 见证中的一条建模边流量（与 PlanSolution.edges 同身份、同顺序）。 */
export interface WitnessEdge {
  kind: PlanEdgeKind
  /** 管段取管段 id；供水点/需求点取节点 id。 */
  id: string
  capacity: number
  flow: number
}

/** 完整流量见证：总送水量 + 每条建模边的流量（容量/守恒由返回前自检保证）。 */
export interface GapWitness {
  /** 见证的总送水量，严格等于诊断时的 analysis.value。 */
  total: number
  edges: WitnessEdge[]
}

export interface GapDiagnosis {
  /** 固定的总送水量（= 诊断时的 analysis.value）。 */
  total: number
  /** 全部被承诺点未达承诺量之和（已压到最小）。 */
  totalGap: number
  /** 实际参与诊断（填写了非空下限）的需求点数量。 */
  committed: number
  /** 逐点结论，按 network.sinks 顺序。 */
  allocations: SinkGap[]
  /** 满足全部容量与守恒约束的完整流量见证。 */
  witness: GapWitness
}

export interface GapFailure {
  ok: false
  /** 失败原因（非空字符串）：无效填写、方案异常或见证不变量自检失败。 */
  reason: string
}

export type GapResult = ({ ok: true } & GapDiagnosis) | GapFailure

/**
 * 残量网络上的 Dinic（迭代阻塞流，支持推流上限、按「输入边身份」冻结弧，
 * 并可从一组当前流量预置残量）。
 *
 * 与 maxflow.ts 的区别：诊断内部要在同一个残量状态上做多轮改道
 * （阶段 B 一次、阶段 C 每点一次），故把残量结构做成可复用对象：
 *  - initialFlow：前 realFlowCount 条输入边构造后立即预置净流量
 *    （正残量 = capacity − f、反残量 = f，与 maxflow.ts 终态同构）；
 *  - limit：本轮推到限额即停（阶段 C 每点最多补 d_k − f_k 个单位）；
 *  - freezeInput：永久跳过某条输入边的正反两条弧（已优化/排除的需求边）。
 * 容量全程为安全整数（继承输入契约总容量 ≤ 9×10^15 的前提）。
 */
class ResidualDinic {
  private readonly head: Int32Array
  private readonly to: Int32Array
  private readonly next: Int32Array
  private readonly cap: Float64Array
  private readonly frozenArc: Uint8Array
  private readonly level: Int32Array
  private readonly iter: Int32Array
  private readonly queue: Int32Array
  private readonly pathEdge: Int32Array
  private readonly pathNode: Int32Array

  constructor(
    nodeCount: number,
    edges: ReadonlyArray<{ from: number; to: number; capacity: number }>,
    initialFlow?: Float64Array,
    realFlowCount?: number,
  ) {
    const arcCount = 2 * edges.length
    this.head = new Int32Array(nodeCount).fill(-1)
    this.to = new Int32Array(arcCount)
    this.next = new Int32Array(arcCount)
    this.cap = new Float64Array(arcCount) // 正向初始容量、反向初始 0
    this.frozenArc = new Uint8Array(arcCount)
    edges.forEach((e, i) => {
      const a = 2 * i
      this.to[a] = e.to
      this.next[a] = this.head[e.from]
      this.head[e.from] = a
      this.cap[a] = e.capacity
      this.to[a + 1] = e.from
      this.next[a + 1] = this.head[e.to]
      this.head[e.to] = a + 1
    })
    // 预置真实边当前流量（其后的人造边初始无流量）。
    const real = realFlowCount ?? 0
    if (initialFlow) {
      for (let i = 0; i < real; i++) {
        const f = initialFlow[i]
        if (f !== 0) {
          this.cap[2 * i] -= f
          this.cap[2 * i + 1] += f
        }
      }
    }
    this.level = new Int32Array(nodeCount)
    this.iter = new Int32Array(nodeCount)
    this.queue = new Int32Array(nodeCount)
    this.pathEdge = new Int32Array(nodeCount)
    this.pathNode = new Int32Array(nodeCount)
  }

  /** 永久跳过某条输入边的正/反两条弧（残量状态保留，只是不再参与改道）。 */
  freezeInput(i: number): void {
    this.frozenArc[2 * i] = 1
    this.frozenArc[2 * i + 1] = 1
  }

  /** 某条输入边当前的净正向流量（= 反向弧残量）。 */
  flowOf(i: number): number {
    return this.cap[2 * i + 1]
  }

  /** 从 source 到 sink 的限额最大流（迭代阻塞流）；返回本轮新推流量。 */
  push(source: number, sink: number, limit: number): number {
    let pushed = 0
    const bfs = (): boolean => {
      this.level.fill(-1)
      let qh = 0
      let qt = 0
      this.level[source] = 0
      this.queue[qt++] = source
      while (qh < qt) {
        const v = this.queue[qh++]
        for (let a = this.head[v]; a !== -1; a = this.next[a]) {
          if (this.frozenArc[a]) continue
          if (this.cap[a] > 0 && this.level[this.to[a]] === -1) {
            this.level[this.to[a]] = this.level[v] + 1
            this.queue[qt++] = this.to[a]
          }
        }
      }
      return this.level[sink] !== -1
    }

    while (pushed < limit && bfs()) {
      this.iter.set(this.head)
      let depth = 0
      this.pathNode[0] = source
      augment: while (pushed < limit) {
        const v = this.pathNode[depth]
        if (v === sink) {
          let f = Infinity
          for (let i = 0; i < depth; i++) {
            const c = this.cap[this.pathEdge[i]]
            if (c < f) f = c
          }
          if (pushed + f > limit) f = limit - pushed
          for (let i = 0; i < depth; i++) {
            const a = this.pathEdge[i]
            this.cap[a] -= f
            this.cap[a ^ 1] += f
          }
          pushed += f
          // 回退到本路第一个饱和弧；限额截停但无饱和弧时回到源重来。
          let d = 0
          for (let i = 0; i < depth; i++) {
            if (this.cap[this.pathEdge[i]] === 0) {
              d = i
              break
            }
          }
          depth = d
          continue
        }
        let a = this.iter[v]
        while (
          a !== -1 &&
          (this.frozenArc[a] ||
            !(this.cap[a] > 0 && this.level[this.to[a]] === this.level[v] + 1))
        ) {
          a = this.next[a]
        }
        this.iter[v] = a
        if (a === -1) {
          this.level[v] = -1
          if (depth === 0) break augment
          depth--
        } else {
          this.pathEdge[depth] = a
          depth++
          this.pathNode[depth] = this.to[a]
        }
      }
    }
    return pushed
  }
}

/** 方案/参数健全性：异常时按诊断失败处理，绝不抛出、绝不篡改入参。 */
function checkSound(solution: PlanSolution): string | null {
  const { analysis, edges, nodeCount, sinkEdgeIndex } = solution
  if (!Number.isSafeInteger(analysis.value) || analysis.value < 0) {
    return '当前方案总量不是非负安全整数'
  }
  if (!Array.isArray(edges) || nodeCount < 2) {
    return '当前方案建模结构无效'
  }
  for (const e of edges) {
    if (
      !Number.isInteger(e.from) ||
      !Number.isInteger(e.to) ||
      e.from < 0 ||
      e.to < 0 ||
      e.from >= nodeCount ||
      e.to >= nodeCount ||
      !Number.isSafeInteger(e.capacity) ||
      e.capacity < 0
    ) {
      return '当前方案存在非法建模边'
    }
  }
  if (!Array.isArray(sinkEdgeIndex)) return '当前方案需求边索引无效'
  return null
}

/** 校验承诺条目并按 sinkIndex 升序排列（升序即字典序裁决与缺口口径）。 */
function normalizeEntries(
  solution: PlanSolution,
  entries: readonly GapEntry[],
): { ordered: GapEntry[]; edgeIndex: number[] } | { error: string } {
  const { edges, sinkEdgeIndex } = solution
  if (!Array.isArray(entries)) return { error: '承诺列表无效' }
  const seen = new Set<number>()
  for (const entry of entries) {
    if (
      !entry ||
      !Number.isInteger(entry.sinkIndex) ||
      entry.sinkIndex < 0 ||
      !Number.isSafeInteger(entry.minimum) ||
      entry.minimum < 0
    ) {
      return { error: '存在无效的需求点或承诺数值' }
    }
    const edgeIndex = sinkEdgeIndex[entry.sinkIndex]
    if (
      edgeIndex === undefined ||
      edgeIndex < 0 ||
      edgeIndex >= edges.length ||
      edges[edgeIndex].kind !== 'sink'
    ) {
      return { error: '承诺所指需求点在当前方案中不存在' }
    }
    if (seen.has(entry.sinkIndex)) return { error: '同一需求点被重复承诺' }
    seen.add(entry.sinkIndex)
    if (entry.minimum > edges[edgeIndex].capacity) {
      return {
        error: `需求点 "${edges[edgeIndex].id}" 的承诺超过其容量 ${edges[edgeIndex].capacity}`,
      }
    }
  }
  const ordered = [...entries].sort((a, b) => a.sinkIndex - b.sinkIndex)
  return { ordered, edgeIndex: ordered.map((e) => sinkEdgeIndex[e.sinkIndex]) }
}

/**
 * 最小承诺缺口诊断主入口。
 *
 * entries 为空（全部留空）时总缺口为 0，直接返回当前最大流作为见证
 * （不做任何改道）。任何失败都以 { ok:false, reason } 返回，不抛出。
 */
export function minimumCommitmentGap(
  solution: PlanSolution,
  entries: readonly GapEntry[],
): GapResult {
  try {
    const soundError = checkSound(solution)
    if (soundError) return { ok: false, reason: soundError }

    const normalized = normalizeEntries(solution, entries)
    if ('error' in normalized) return { ok: false, reason: normalized.error }
    const { ordered, edgeIndex: committedEdges } = normalized

    const { edges, nodeCount } = solution
    const T = solution.superSink
    const m = edges.length
    const K = ordered.length

    // 自有副本：全部改道都在残量副本上进行，绝不改写 solution.flow / residual。
    const start = Float64Array.from(solution.flow)
    for (let i = 0; i < m; i++) {
      if (!Number.isSafeInteger(start[i]) || start[i] < 0 || start[i] > edges[i].capacity) {
        return { ok: false, reason: '当前方案流量不满足容量约束' }
      }
    }

    // 空承诺：无需改道，当前最大流本身即总缺口 0 的见证。
    if (K === 0) {
      return finalize(solution, start, [], [], 'empty')
    }

    // -------------------------------------------------------------------
    // 阶段 B：冻结全部被承诺需求边自身残量弧，加门节点 G、补给弧 v_k→G
    // （容量 = 尚欠单位）与富余弧 T→v_k（容量 = 超过承诺、可无偿调走的单位），
    // 未承诺需求边的反残量弧天然开放；求 T→G 最大流即满足总量的最大增量。
    // -------------------------------------------------------------------
    const G = nodeCount
    const inputsB: { from: number; to: number; capacity: number }[] = edges.map(
      (e) => ({ from: e.from, to: e.to, capacity: e.capacity }),
    )
    // 人造边下标：补给弧 m+2k、富余弧 m+2k+1（初始均无流量，realFlowCount=m）。
    for (let k = 0; k < K; k++) {
      const ei = committedEdges[k]
      const fk = start[ei]
      const dk = ordered[k].minimum
      inputsB.push({ from: edges[ei].from, to: G, capacity: Math.max(0, dk - fk) })
      inputsB.push({ from: T, to: edges[ei].from, capacity: Math.max(0, fk - dk) })
    }
    const phaseB = new ResidualDinic(nodeCount + 1, inputsB, start, m)
    for (const ei of committedEdges) phaseB.freezeInput(ei)
    phaseB.push(T, G, Infinity)

    // 阶段 B 后各真实边净流量（承诺边被冻结，其反残量未动；补给/富余改道对
    // 承诺边的净影响 = 补给增流 − 富余调走，故 Δy_k = flow(补给弧) − flow(富余弧)）。
    const afterB = new Float64Array(m)
    for (let i = 0; i < m; i++) afterB[i] = phaseB.flowOf(i)
    for (let k = 0; k < K; k++) {
      const ei = committedEdges[k]
      const gained = phaseB.flowOf(m + 2 * k)
      const released = phaseB.flowOf(m + 2 * k + 1)
      afterB[ei] = start[ei] + gained - released
    }

    // -------------------------------------------------------------------
    // 阶段 C：按承诺点顺序逐点字典序裁决（更早点永久冻结、自身边本轮排除、
    // 限额 d_k − 当前水量）。处理完的承诺边永久冻结。
    // -------------------------------------------------------------------
    const phaseC = new ResidualDinic(
      nodeCount,
      edges.map((e) => ({ from: e.from, to: e.to, capacity: e.capacity })),
      afterB,
      m,
    )
    const finalFlow = Float64Array.from(afterB)
    const frozenEdges = new Set<number>()
    for (let k = 0; k < K; k++) {
      const ei = committedEdges[k]
      // 先从残量网读出该点此刻的真实水量：更早轮次的改道可能已动用过它
      // （改道只减少「水源点」水量）。current 也可能大于承诺——阶段 B 后该点
      // 保留着无处分流的富余来水，此时满足量已满，无需再补（need=0），
      // 直接按当前水量冻结即可。
      const current = phaseC.flowOf(ei)
      const need = Math.max(0, ordered[k].minimum - current)
      phaseC.freezeInput(ei) // 本轮排除自身边，之后永久冻结
      frozenEdges.add(ei)
      const pushed = need > 0 ? phaseC.push(T, edges[ei].from, need) : 0
      finalFlow[ei] = current + pushed
    }
    // 未冻结边（管段/供水边/未承诺需求边）以最终残量净流量为准。
    for (let i = 0; i < m; i++) {
      if (!frozenEdges.has(i)) finalFlow[i] = phaseC.flowOf(i)
    }

    // -------------------------------------------------------------------
    // 阶段 D（富余水裁决）：缺口与逐点满足量 s_k 已由阶段 B/C 定为最优，
    // 余下的「富余来水」按需求点顺序继续优先分给更早的承诺点，直到其需求
    // 容量饱和。捐赠者只能动用承诺之外的富余（人造弧 T→v_j，容量 yC_j−d_j，
    // 永不使其跌破承诺），未承诺点经其真实反残量弧可一直捐到 0；已处理承诺点
    // 的真实边与其富余弧都永久冻结。由此逐点实际供水向量也字典序唯一。
    // -------------------------------------------------------------------
    const inputsD = edges.map((e) => ({
      from: e.from,
      to: e.to,
      capacity: e.capacity,
    }))
    // 富余捐赠弧 m+k：T → v_k，容量 = 阶段 C 后该点超过承诺的水量。
    for (let k = 0; k < K; k++) {
      const ei = committedEdges[k]
      inputsD.push({
        from: T,
        to: edges[ei].from,
        capacity: Math.max(0, finalFlow[ei] - ordered[k].minimum),
      })
    }
    const phaseD = new ResidualDinic(nodeCount, inputsD, finalFlow, m)
    for (const ei of committedEdges) phaseD.freezeInput(ei)
    for (let k = 0; k < K; k++) {
      const ei = committedEdges[k]
      const donated = phaseD.flowOf(m + k) // 本点富余已被更早目标调走的水量
      phaseD.freezeInput(m + k)
      const current = finalFlow[ei] - donated
      const headroom = edges[ei].capacity - current
      const added = headroom > 0 ? phaseD.push(T, edges[ei].from, headroom) : 0
      finalFlow[ei] = current + added
    }
    // 承诺边最终水量 = 阶段 C 水量 − 被调走富余 + 本点获补；
    // 其余边（管段/供水/未承诺需求边）以最终残量净流量为准。
    const dFrozen = new Set(committedEdges)
    for (let i = 0; i < m; i++) {
      if (!dFrozen.has(i)) finalFlow[i] = phaseD.flowOf(i)
    }

    return finalize(solution, finalFlow, ordered, committedEdges, 'solved')
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 返回前统一自检与组装：容量约束、原网络节点守恒、超级源汇平衡 = V、
 * 逐点水量落界与缺口非负。任一不满足即判诊断失败（自检失败不应发生）。
 */
function finalize(
  solution: PlanSolution,
  flow: Float64Array,
  ordered: GapEntry[],
  committedEdges: number[],
  _mode: 'empty' | 'solved',
): GapResult {
  const { edges, nodeCount, sinkEdgeIndex } = solution
  const S = solution.superSource
  const T = solution.superSink
  const V = solution.analysis.value

  const balance = new Float64Array(nodeCount)
  for (let i = 0; i < edges.length; i++) {
    const f = flow[i]
    const e = edges[i]
    if (!Number.isSafeInteger(f) || f < 0 || f > e.capacity) {
      return { ok: false, reason: 'diagnostic-invariant-violated:capacity' }
    }
    balance[e.from] -= f
    balance[e.to] += f
  }
  for (let v = 0; v < nodeCount - 2; v++) {
    if (balance[v] !== 0) {
      return { ok: false, reason: 'diagnostic-invariant-violated:conservation' }
    }
  }
  if (-balance[S] !== V || balance[T] !== V) {
    return { ok: false, reason: 'diagnostic-invariant-violated:total' }
  }

  const committedK = new Map<number, number>()
  committedEdges.forEach((ei, k) => committedK.set(ei, k))

  const allocations: SinkGap[] = []
  let totalGap = 0
  for (let sinkIndex = 0; sinkIndex < sinkEdgeIndex.length; sinkIndex++) {
    const ei = sinkEdgeIndex[sinkIndex]
    const y = flow[ei]
    const k = committedK.get(ei)
    if (k === undefined) {
      allocations.push({ sinkNode: edges[ei].id, minimum: null, delivered: y, gap: 0 })
      continue
    }
    const minimum = ordered[k].minimum
    // y 可能超过承诺（无法分流的富余来水）：此时缺口为 0，满足量按承诺计满。
    const gap = Math.max(0, minimum - y)
    totalGap += gap
    allocations.push({ sinkNode: edges[ei].id, minimum, delivered: y, gap })
  }

  return {
    ok: true,
    total: V,
    totalGap,
    committed: ordered.length,
    allocations,
    witness: {
      total: V,
      edges: edges.map((e, i) => ({
        kind: e.kind,
        id: e.id,
        capacity: e.capacity,
        flow: flow[i],
      })),
    },
  }
}

/** 按需求点节点 id 填写承诺的便捷封装（id 不属于当前方案需求点时失败）。 */
export function minimumCommitmentGapByNode(
  solution: PlanSolution,
  entries: ReadonlyArray<{ node: string; minimum: number }>,
): GapResult {
  if (!Array.isArray(entries)) return { ok: false, reason: '承诺列表无效' }
  const indexed: GapEntry[] = []
  for (const entry of entries) {
    if (!entry || typeof entry.node !== 'string') {
      return { ok: false, reason: '存在无效的需求点或承诺数值' }
    }
    const idx = findSinkIndex(solution, entry.node)
    if (idx < 0) {
      return { ok: false, reason: `需求点 "${entry.node}" 不属于当前模型` }
    }
    indexed.push({ sinkIndex: idx, minimum: entry.minimum })
  }
  return minimumCommitmentGap(solution, indexed)
}
