/**
 * Dinic 最大流。
 *
 * 规模假设：节点 ≤ 10002（含超级源/汇），边 ≤ 70000（管段+供水+需求），
 * 容量为 0..10^12 的整数且流量总和 ≤ 9×10^15 < 2^53，
 * 因此用 Float64 数组存残量即可保持全程精确整数运算。
 *
 * 阻塞流用迭代式 DFS（显式栈），避免万级节点下递归爆栈。
 */

export interface FlowEdge {
  from: number
  to: number
  capacity: number
}

export interface MaxFlowResult {
  /** 最大流值（安全整数）。 */
  value: number
  /** 每条输入边（按传入顺序）的流量。 */
  flow: Float64Array
  /**
   * 每条输入边（按传入顺序）的正向残量容量 = capacity - flow。
   * 反向残量容量即 flow 本身：分析层按输入边身份取
   * 「正向 residual / 反向 flow」一对残量弧构建辅助网络。
   */
  residual: Float64Array
  /** 残量网络中从源可达的节点标记（含超级源/汇）。 */
  reachable: boolean[]
}

export function maxFlow(
  nodeCount: number,
  edges: FlowEdge[],
  source: number,
  sink: number,
): MaxFlowResult {
  const m = edges.length
  const arcCount = 2 * m
  const head = new Int32Array(nodeCount).fill(-1)
  const to = new Int32Array(arcCount)
  const next = new Int32Array(arcCount)
  // cap 为残量：正向弧初始为容量，反向弧初始为 0。
  const cap = new Float64Array(arcCount)

  for (let i = 0; i < m; i++) {
    const e = 2 * i
    const { from, to: dst, capacity } = edges[i]
    to[e] = dst
    next[e] = head[from]
    head[from] = e
    cap[e] = capacity
    to[e + 1] = from
    next[e + 1] = head[dst]
    head[dst] = e + 1
    cap[e + 1] = 0
  }

  const level = new Int32Array(nodeCount)
  const iter = new Int32Array(nodeCount)
  const queue = new Int32Array(nodeCount)
  const pathEdge = new Int32Array(nodeCount)
  const pathNode = new Int32Array(nodeCount)

  const bfs = (): boolean => {
    level.fill(-1)
    let qh = 0
    let qt = 0
    level[source] = 0
    queue[qt++] = source
    while (qh < qt) {
      const v = queue[qh++]
      for (let e = head[v]; e !== -1; e = next[e]) {
        if (cap[e] > 0 && level[to[e]] === -1) {
          level[to[e]] = level[v] + 1
          queue[qt++] = to[e]
        }
      }
    }
    return level[sink] !== -1
  }

  // 一次相位内的阻塞流（迭代实现）。返回本相位推送的总流量。
  const blockingFlow = (): number => {
    iter.set(head)
    let pushed = 0
    let depth = 0
    pathNode[0] = source
    for (;;) {
      const v = pathNode[depth]
      if (v === sink) {
        // 找到一条增广路：求瓶颈、推送、回退到最靠近源侧的饱和弧起点。
        let f = Infinity
        for (let i = 0; i < depth; i++) {
          const c = cap[pathEdge[i]]
          if (c < f) f = c
        }
        for (let i = 0; i < depth; i++) {
          cap[pathEdge[i]] -= f
          cap[pathEdge[i] ^ 1] += f
        }
        pushed += f
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
      // 沿层次图前进（当前弧优化）。
      let e = iter[v]
      while (e !== -1 && !(cap[e] > 0 && level[to[e]] === level[v] + 1)) {
        e = next[e]
      }
      iter[v] = e
      if (e === -1) {
        // 死胡同：剪枝并回溯。
        level[v] = -1
        if (depth === 0) return pushed
        depth--
      } else {
        pathEdge[depth] = e
        depth++
        pathNode[depth] = to[e]
      }
    }
  }

  let value = 0
  while (bfs()) {
    value += blockingFlow()
  }

  // 每条输入边的流量 = 其反向弧的残量（反向弧从 0 开始，随流量增加）；
  // 正向残量 = 初始容量 - 流量。两条残量弧都按输入边身份对外提供。
  const flow = new Float64Array(m)
  const residual = new Float64Array(m)
  for (let i = 0; i < m; i++) {
    flow[i] = cap[2 * i + 1]
    residual[i] = cap[2 * i]
  }

  // 在最终残量网络上从源做一次可达性遍历，得到最小割的源侧集合。
  const reachable = new Array<boolean>(nodeCount).fill(false)
  let qh = 0
  let qt = 0
  reachable[source] = true
  queue[qt++] = source
  while (qh < qt) {
    const v = queue[qh++]
    for (let e = head[v]; e !== -1; e = next[e]) {
      if (cap[e] > 0 && !reachable[to[e]]) {
        reachable[to[e]] = true
        queue[qt++] = to[e]
      }
    }
  }

  return { value, flow, residual, reachable }
}
